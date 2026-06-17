import { promises as fs } from 'node:fs';
import { consola } from 'consola';
import { createPatch } from 'diff';
import path from 'node:path';
import type { Document } from 'yaml';
import { parseConfig, readConfig, stringifyConfig } from '../config/io.js';
import {
  containerConfigPath,
  containerConfigsDir,
  containerDir,
  containerEnvPath,
  monocerosHome as defaultMonocerosHome,
} from '../config/paths.js';
import {
  ensureEnvGitignored,
  ensureEnvVars,
  hasVarPlaceholder,
  GIT_IDENTITY_VAR,
} from '../config/env-file.js';
import { featureOptionHints } from '../init/feature-doc.js';
import { loadFeatureManifestSummary } from '../init/manifest.js';
import {
  collectGitCredentials,
  resolveProvider,
  type CredentialsSpawn,
} from '../devcontainer/credentials.js';
import {
  findRunningContainerByLocalFolder,
  realContainerExec,
  type ContainerExec,
  type DockerLookupExec,
} from '../devcontainer/locate-running.js';
import { proxyHostPort, readMonocerosConfig } from '../config/global.js';
import {
  KNOWN_PROVIDER_HOSTS,
  PROVIDER_VALUES,
  REGEX,
  isValidEmail,
  portNumber,
  type RepoProvider,
} from '../config/schema.js';
import { loadComponentCatalog } from '../init/components.js';
import {
  ensureProxy,
  maybeStopProxy,
  type DockerExec as ProxyDockerExec,
} from '../proxy/index.js';
import {
  proxyUrlsFor,
  removeDynamicConfig,
  writeDynamicConfig,
} from '../proxy/dynamic.js';
import { preflightHostPort } from '../proxy/port-check.js';
import {
  BUILTIN_LANGUAGES,
  LANGUAGE_CATALOG,
  curatedServiceEnvDefaults,
  deriveServiceName,
  expandCuratedService,
  isCuratedService,
  knownLanguages,
  parseLanguageSpec,
} from '../create/catalog.js';
import {
  renderServiceObjectBody,
  renderCustomService,
  customServiceHint,
} from '../init/service-doc.js';
import { deriveRepoName } from '../create/scaffold.js';
import type { FeatureOptions, RepoEntry } from '../create/types.js';
import {
  addAptPackagesToDoc,
  addFeatureToDoc,
  addInstallUrlToDoc,
  addLanguageToDoc,
  addPortsToDoc,
  addRepoToDoc,
  addServiceEntryToDoc,
  ensureContainerGitUserPlaceholder,
  relocateLeakedSectionComments,
  removeAptPackagesFromDoc,
  removeFeatureFromDoc,
  removeInstallUrlFromDoc,
  removeLanguageFromDoc,
  removePortsFromDoc,
  removeRepoFromDoc,
  removeServiceFromDoc,
  setDefaultPortInDoc,
} from './yml.js';

/**
 * `monoceros add-*` / `monoceros remove-*` — edit the yml at
 * `<MONOCEROS_HOME>/container-configs/<name>.yml` for one container.
 *
 * No cwd magic. The first positional argument is always the container
 * name; the command looks up the yml via convention. Comment-preserving
 * AST mutation; the builder then runs `monoceros apply <name>` to
 * materialize.
 */

export interface ModifyLogger {
  info: (message: string) => void;
  success: (message: string) => void;
  warn: (message: string) => void;
}

export type ConfirmFn = (prompt: string) => Promise<boolean>;

export interface ModifyOptions {
  /** Container name — resolves to `<home>/container-configs/<name>.yml`. */
  name: string;
  yes?: boolean;
  logger?: ModifyLogger;
  output?: (line: string) => void;
  confirm?: ConfirmFn;
  /** Override the resolved MONOCEROS_HOME. Tests inject a tmpdir. */
  monocerosHome?: string;
}

export interface AddLanguageInput extends ModifyOptions {
  language: string;
}
export interface AddServiceInput extends ModifyOptions {
  service: string;
  /**
   * Override the compose service name. Required to add the same image
   * more than once (two postgres servers → `--as postgres-app` /
   * `--as postgres-analytics`) and to disambiguate two custom images
   * that derive the same name.
   */
  as?: string;
}
export interface AddAptPackagesInput extends ModifyOptions {
  packages: string[];
}
export interface AddFeatureInput extends ModifyOptions {
  ref: string;
  options?: FeatureOptions;
}
export interface AddFromUrlInput extends ModifyOptions {
  url: string;
}
export interface AddRepoInput extends ModifyOptions {
  url: string;
  /**
   * Explicit destination path under `projects/`. Subfolders allowed
   * via `/` (e.g. `apps/web`). When omitted, the URL-derived single-
   * segment default is used (`https://.../foo.git` → `foo` →
   * `projects/foo/`).
   */
  path?: string;
  /**
   * Optional per-repo git committer identity override. Both name and
   * email must be set together; one alone is a usage error. Falls
   * back to the container-level `git.user` (which itself falls back
   * to the host's `git config --global`) when omitted.
   */
  gitName?: string;
  gitEmail?: string;
  /**
   * Git provider hint. Required when the URL host is not one of the
   * three canonical ones (github.com / gitlab.com / bitbucket.org);
   * optional otherwise. Validated against `PROVIDER_VALUES`.
   */
  provider?: string;
  /**
   * Test injection points for the on-the-fly-clone path (the part
   * that runs after the yml mutation when the container is up).
   */
  containerLookupDocker?: DockerLookupExec;
  containerExec?: ContainerExec;
  credentialsSpawn?: CredentialsSpawn;
}

export interface RemoveLanguageInput extends ModifyOptions {
  language: string;
}
export interface RemoveServiceInput extends ModifyOptions {
  service: string;
}
export interface RemoveAptPackagesInput extends ModifyOptions {
  packages: string[];
}
export interface RemoveFeatureInput extends ModifyOptions {
  ref: string;
}
export interface RemoveFromUrlInput extends ModifyOptions {
  url: string;
}
export interface RemoveRepoInput extends ModifyOptions {
  /** url or (effective) name — `monoceros remove-repo` accepts either. */
  target: string;
}

export interface AddPortInput extends ModifyOptions {
  ports: number[];
  /**
   * When true, the (single) port in `ports` is moved to / inserted at
   * the front of `routing.ports` — making it the bare
   * `<name>.localhost` default route. Only valid with exactly one
   * port in the args; multiple ports + `asDefault` is a usage error.
   */
  asDefault?: boolean;
  /** Override the docker exec used by the Traefik proxy lifecycle. */
  proxyDocker?: ProxyDockerExec;
}
export interface RemovePortInput extends ModifyOptions {
  ports: number[];
  /** Override the docker exec used by the Traefik proxy lifecycle. */
  proxyDocker?: ProxyDockerExec;
}

export type ModifyResult =
  | { status: 'no-change' }
  | { status: 'updated'; changedPaths: string[] }
  | { status: 'aborted' };

type YmlMutator = (doc: Document) => boolean;

// ─── add-* ────────────────────────────────────────────────────────

export function runAddLanguage(input: AddLanguageInput): Promise<ModifyResult> {
  const spec = parseLanguageSpec(input.language);
  if (
    !spec ||
    (!BUILTIN_LANGUAGES.has(spec.name) && !LANGUAGE_CATALOG[spec.name])
  ) {
    throw new Error(
      `Unknown language: ${input.language}. Known: ${knownLanguages().join(', ')}.`,
    );
  }
  // Mirror init: surface the version inline (explicit `:version` wins over the
  // catalog default) and the language's `surface: yml` options as the object
  // form, so the builder sees what's editable.
  const entry = LANGUAGE_CATALOG[spec.name];
  const version = spec.version ?? entry?.defaultVersion;
  const options = entry?.ymlOptions;
  return mutate(input, (doc) =>
    addLanguageToDoc(doc, spec.name, {
      ...(version !== undefined ? { version } : {}),
      ...(options && Object.keys(options).length > 0 ? { options } : {}),
    }),
  );
}

export async function runAddService(
  input: AddServiceInput,
): Promise<ModifyResult> {
  // Curated catalog name → expand to a full active object block.
  // Anything else → treat the argument as an image, derive the service
  // name from it, and drop in a commented scaffold for the fields
  // Monoceros can't know.
  const arg = input.service;
  const curated = isCuratedService(arg);

  // `--as` overrides the compose service name (default: the curated
  // name, or one derived from the image). Validate the override here so
  // the builder gets a focused message rather than a schema round-trip
  // error. Mirrors the schema's SERVICE_NAME_RE.
  if (input.as !== undefined && !/^[a-z0-9][a-z0-9_-]*$/.test(input.as)) {
    throw new Error(
      `Invalid --as name ${JSON.stringify(input.as)}. Use lowercase letters, digits, '_' or '-' (must start with a letter or digit).`,
    );
  }
  const name = input.as ?? (curated ? arg : deriveServiceName(arg));
  const image = curated ? expandCuratedService(arg).image : arg;
  // Render the block under the resolved name. For curated services the
  // expansion carries the catalog name, so override it before rendering.
  const custom = curated ? null : renderCustomService(name, arg);
  const bodyLines = curated
    ? renderServiceObjectBody({ ...expandCuratedService(arg), name })
    : custom!.bodyLines;
  const scaffoldComment = curated ? undefined : custom!.comment;

  const result = await mutate(input, (doc) => {
    const r = addServiceEntryToDoc(
      doc,
      name,
      image,
      bodyLines,
      scaffoldComment,
    );
    if (r.outcome === 'conflict') {
      throw new Error(
        `A service named '${name}' already exists with a different image (${r.existingImage}). ` +
          `Add it under a different name with \`--as <name>\`, or remove the existing one first ` +
          `(\`monoceros remove-service ${input.name} ${name}\`).`,
      );
    }
    return r.outcome === 'added';
  });

  // Curated service → seed its env dev-defaults into <name>.env (the
  // same ${KEY} placeholders the expanded block carries), mirroring
  // init and add-feature. Keys are image-dictated (POSTGRES_USER, …),
  // so --as renaming the service doesn't change them. Custom images
  // get the fill-in-the-scaffold hint instead — Monoceros can't know
  // their vars.
  if (result.status === 'updated') {
    if (curated) {
      const defaults = curatedServiceEnvDefaults(arg);
      if (Object.keys(defaults).length > 0) {
        const home = input.monocerosHome ?? defaultMonocerosHome();
        await ensureEnvGitignored(containerConfigsDir(home));
        const seeded = await ensureEnvVars(
          containerEnvPath(input.name, home),
          input.name,
          defaults,
        );
        if (seeded.added.length > 0) {
          (input.logger ?? defaultLogger()).info(
            `Seeded ${seeded.added.join(', ')} into ${input.name}.env (dev-defaults — change them there if needed).`,
          );
        }
      }
    } else {
      (input.logger ?? defaultLogger()).info(customServiceHint(name));
    }
  }
  return result;
}

export function runAddAptPackages(
  input: AddAptPackagesInput,
): Promise<ModifyResult> {
  if (input.packages.length === 0) {
    throw new Error(
      'No package names given. Usage: monoceros add-apt-packages <containername> -- <pkg> [<pkg> …].',
    );
  }
  return mutate(input, (doc) => addAptPackagesToDoc(doc, input.packages));
}

export async function runAddRepo(input: AddRepoInput): Promise<ModifyResult> {
  const url = input.url.trim();
  if (url.length === 0) {
    throw new Error(
      'Missing repo URL. Usage: monoceros add-repo <containername> <url>.',
    );
  }
  const path = (input.path ?? deriveRepoName(url)).trim();
  // --git-name and --git-email come as a pair. Reject half-set input
  // loudly instead of silently dropping it.
  const hasName =
    typeof input.gitName === 'string' && input.gitName.trim().length > 0;
  const hasEmail =
    typeof input.gitEmail === 'string' && input.gitEmail.trim().length > 0;
  if (hasName !== hasEmail) {
    throw new Error(
      '--git-name and --git-email must be set together. Pass both, or neither.',
    );
  }
  // Validate the email eagerly at the flag entry — the schema defers
  // email format to apply (to allow `${VAR}` placeholders from the
  // hand-edited yml), so a typo'd literal would otherwise only surface
  // at apply. A `${VAR}` placeholder is allowed through here too, in
  // case the builder wants to manage the value in <name>.env.
  if (hasEmail) {
    const email = input.gitEmail!.trim();
    if (!isValidEmail(email) && !hasVarPlaceholder(email)) {
      throw new Error(
        `Invalid --git-email '${email}': must be a valid email or a \${VAR} placeholder resolved from <name>.env.`,
      );
    }
  }
  // --provider validation:
  //   - host is canonical (github.com / gitlab.com / bitbucket.org):
  //       * no --provider → fine, auto-detected at apply time
  //       * --provider matches canonical → accepted, written to yml
  //         (harmless; round-trip stays clean)
  //       * --provider contradicts canonical → reject loudly
  //   - host is non-canonical:
  //       * --provider given (valid enum) → write it
  //       * --provider missing → reject; the apply pre-flight would
  //         fail anyway, fail at add-repo time for a better signal
  //       * --provider invalid value → reject with allowed list
  const explicitProvider = normalizeProvider(input.provider);
  let host: string | undefined;
  try {
    host = url.startsWith('https://') ? new URL(url).hostname : undefined;
  } catch {
    host = undefined;
  }
  const canonical = host ? KNOWN_PROVIDER_HOSTS[host.toLowerCase()] : undefined;
  if (host && !canonical && !explicitProvider) {
    throw new Error(
      `Host '${host}' is not a canonical Git provider Monoceros can auto-detect (github.com / gitlab.com / bitbucket.org). Pass --provider=github|gitlab|bitbucket so the credential-helper hints know which CLI to suggest.`,
    );
  }
  if (canonical && explicitProvider && explicitProvider !== canonical) {
    throw new Error(
      `--provider=${explicitProvider} contradicts host '${host}' (auto-detected as ${canonical}). Drop --provider for canonical hosts, or fix the value.`,
    );
  }
  // For canonical hosts we don't persist `provider:` in the yml even
  // when the flag was passed (matches what auto-detection would do
  // and keeps the yml minimal). Non-canonical hosts: write the
  // explicit value as-is.
  const providerToWrite =
    !canonical && explicitProvider ? explicitProvider : undefined;
  const entry: RepoEntry = {
    url,
    path,
    ...(hasName && hasEmail
      ? {
          gitUser: {
            name: input.gitName!.trim(),
            email: input.gitEmail!.trim(),
          },
        }
      : {}),
    ...(providerToWrite ? { provider: providerToWrite } : {}),
  };
  // When a NEW repo is added and the container has no `git.user` yet,
  // scaffold a container-level identity with `${VAR}` placeholders (and
  // seed the blank keys below) — same env-managed default `init`
  // produces. Rides along in the same diff. An existing `git.user`
  // (literal or placeholder) is left untouched.
  let gitUserScaffolded = false;
  const result = await mutate(input, (doc) => {
    const repoAdded = addRepoToDoc(doc, entry);
    if (repoAdded) gitUserScaffolded = ensureContainerGitUserPlaceholder(doc);
    return repoAdded;
  });
  if (result.status === 'updated' && gitUserScaffolded) {
    const home = input.monocerosHome ?? defaultMonocerosHome();
    await ensureEnvGitignored(containerConfigsDir(home));
    await ensureEnvVars(containerEnvPath(input.name, home), input.name, [
      GIT_IDENTITY_VAR.name,
      GIT_IDENTITY_VAR.email,
    ]);
    (input.logger ?? defaultLogger()).info(
      `Added a container git.user with \${${GIT_IDENTITY_VAR.name}}/\${${GIT_IDENTITY_VAR.email}} placeholders and seeded ${input.name}.env — fill them or leave blank to use your global git identity.`,
    );
  }
  // On-the-fly clone path: if the yml change took AND the container
  // is currently running, clone the repo directly into the
  // container so the builder doesn't have to `monoceros apply`
  // afterwards. Soft-fail with a warn — failures here never roll
  // back the yml write. See ADR 0007's add-port symmetry.
  if (result.status === 'updated') {
    await tryCloneInRunningContainer(input, entry);
  }
  return result;
}

/**
 * Best-effort: if the container is running, fetch HTTPS credentials
 * for the repo host, then `docker exec git clone …` directly into
 * `/workspaces/<name>/projects/<path>/`. Skips silently when:
 *
 *   - the container isn't running (typical case — yml-only is fine,
 *     `monoceros apply` will clone on next bring-up)
 *   - the destination folder already exists (idempotent — matches
 *     post-create.sh's "skip clone if dir exists" rule)
 *
 * Soft-fails with a warn on any error in the clone path. The yml
 * mutation is already persisted; the next `monoceros apply` will
 * retry. Tests inject the docker / credentials spawns; production
 * uses the real ones.
 */
async function tryCloneInRunningContainer(
  input: AddRepoInput,
  entry: RepoEntry,
): Promise<void> {
  const home = input.monocerosHome ?? defaultMonocerosHome();
  const root = containerDir(input.name, home);
  const logger = input.logger ?? defaultLogger();

  let containerId: string | null;
  try {
    containerId = await findRunningContainerByLocalFolder(root, {
      ...(input.containerLookupDocker
        ? { docker: input.containerLookupDocker }
        : {}),
    });
  } catch (err) {
    logger.warn(
      `Could not check whether the container is running: ${err instanceof Error ? err.message : String(err)}. The yml is updated — run \`monoceros apply ${input.name}\` to clone.`,
    );
    return;
  }
  if (!containerId) {
    logger.info(
      `Container not running — yml updated only. Clone happens on \`monoceros apply ${input.name}\`.`,
    );
    return;
  }

  // Credential fetch for the URL's host. Same mechanism apply uses
  // (host-side `git credential fill`), writing into the bind-mounted
  // `.monoceros/git-credentials` file so the in-container clone can
  // pick it up via the credential.helper that post-create already
  // wired.
  let urlHost: string;
  try {
    urlHost = new URL(entry.url).hostname;
  } catch {
    logger.warn(
      `Cannot parse URL host from ${entry.url}. The yml is updated — clone manually inside the container or rerun with a fixed URL.`,
    );
    return;
  }
  const provider = resolveProvider(urlHost, entry.provider);
  if (provider === 'unknown') {
    logger.warn(
      `Could not resolve provider for host ${urlHost}. The yml is updated; clone happens at the next \`monoceros apply\` if you set the provider.`,
    );
    return;
  }
  try {
    const credsResult = await collectGitCredentials(
      root,
      [{ host: urlHost, provider }],
      {
        ...(input.credentialsSpawn ? { spawn: input.credentialsSpawn } : {}),
        logger: { info: () => {}, warn: (m) => logger.warn(m) },
      },
    );
    const status = credsResult.perHost.find((h) => h.host === urlHost);
    if (!status || status.status !== 'ok') {
      const detail = status?.detail ? `: ${status.detail}` : '';
      logger.warn(
        `No HTTPS credentials available for ${urlHost}${detail}. The yml is updated; set up credentials (e.g. \`gh auth login\`) and re-run \`monoceros apply ${input.name}\` or rerun this add-repo.`,
      );
      return;
    }
  } catch (err) {
    logger.warn(
      `Credential fetch for ${urlHost} failed: ${err instanceof Error ? err.message : String(err)}. The yml is updated.`,
    );
    return;
  }

  // The clone itself. mkdir -p ensures nested parents exist. The
  // outer `[ -d <target> ] && exit 0` short-circuit matches the
  // idempotency post-create.sh has — re-running add-repo against the
  // same URL is a yml no-op anyway, but if the folder somehow
  // exists without the yml entry we still don't overwrite.
  //
  // `git -c credential.helper=…` sets the helper INLINE just for
  // this clone, instead of relying on `git config --global` having
  // been set by post-create.sh. That matters because post-create
  // runs once at container up, not on every add-repo — a container
  // that started life without any HTTPS repo wouldn't have a
  // credential.helper configured at all. Inline-setting keeps
  // add-repo self-contained and doesn't mutate the container's
  // global git config as a side effect.
  const containerName = input.name;
  const targetRel = `projects/${entry.path}`;
  const parentRel = entry.path.includes('/')
    ? `projects/${entry.path.split('/').slice(0, -1).join('/')}`
    : 'projects';
  const credentialsFile = `/workspaces/${containerName}/.monoceros/git-credentials`;
  const credentialHelper = `store --file=${credentialsFile}`;
  const script = [
    `set -eu`,
    `cd /workspaces/${containerName}`,
    `if [ -d ${shquote(targetRel)} ]; then`,
    `  echo "[add-repo] ${targetRel} already exists — skipping clone."`,
    `  exit 0`,
    `fi`,
    `mkdir -p ${shquote(parentRel)}`,
    `git -c ${shquote(`credential.helper=${credentialHelper}`)} clone ${shquote(entry.url)} ${shquote(targetRel)}`,
  ];
  if (entry.gitUser) {
    script.push(
      `git -C ${shquote(targetRel)} config user.name ${shquote(entry.gitUser.name)}`,
      `git -C ${shquote(targetRel)} config user.email ${shquote(entry.gitUser.email)}`,
    );
  }
  const execFn = input.containerExec ?? realContainerExec;
  let exit;
  try {
    exit = await execFn(containerId, ['bash', '-c', script.join('\n')]);
  } catch (err) {
    logger.warn(
      `In-container clone for ${entry.url} failed: ${err instanceof Error ? err.message : String(err)}. The yml is updated; \`monoceros apply ${input.name}\` retries.`,
    );
    return;
  }
  if (exit.exitCode !== 0) {
    logger.warn(
      `In-container clone for ${entry.url} exited ${exit.exitCode}. The yml is updated; \`monoceros apply ${input.name}\` retries.`,
    );
    return;
  }
  logger.info(
    `Cloned ${entry.url} into /workspaces/${containerName}/${targetRel} inside the running container.`,
  );
  void path; // path import is reserved for future relative-path work
}

/**
 * Minimal shell-quote — single-quotes the value, escaping any
 * embedded single-quote via `'\\''`. The clone script runs inside a
 * `bash -c` invocation, so input that came from the yml (URLs,
 * paths, identity names) must be safely quoted to avoid trivial
 * injection or accidental shell-meta interpretation.
 */
function shquote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeProvider(raw: string | undefined): RepoProvider | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const lowered = trimmed.toLowerCase() as RepoProvider;
  if (!(PROVIDER_VALUES as readonly string[]).includes(lowered)) {
    throw new Error(
      `Invalid --provider value: ${JSON.stringify(raw)}. Allowed: ${PROVIDER_VALUES.join(', ')}.`,
    );
  }
  return lowered;
}

export function runAddFromUrl(input: AddFromUrlInput): Promise<ModifyResult> {
  const url = input.url.trim();
  if (url.length === 0) {
    throw new Error(
      'Missing URL. Usage: monoceros add-from-url <containername> <url>.',
    );
  }
  return mutate(input, (doc) => addInstallUrlToDoc(doc, url));
}

export async function runAddPort(input: AddPortInput): Promise<ModifyResult> {
  if (input.ports.length === 0) {
    throw new Error(
      'No ports given. Usage: monoceros add-port <containername> -- <port> [<port> …].',
    );
  }
  const ports = normalizePorts(input.ports);
  if (input.asDefault && ports.length > 1) {
    throw new Error(
      `--default takes exactly one port. Got: ${ports.join(', ')}. Run add-port once with --default for the new default, then again (without --default) for the rest.`,
    );
  }
  const result = await mutate(input, (doc) => {
    if (input.asDefault) {
      // --default semantics: ensure the port exists AND sits at index
      // 0. setDefaultPortInDoc covers both (insert-or-move).
      return setDefaultPortInDoc(doc, ports[0]!);
    }
    return addPortsToDoc(doc, ports);
  });
  // Hot-reload path: when the yml actually changed, push the new
  // route set to the Traefik dynamic-config directory and make sure
  // the proxy is up. The yml is the source of truth — we re-read it
  // so the dynamic config reflects the FULL port list (including
  // entries that pre-existed this `add-port` call), not just the
  // delta. Proxy failures surface as warns but never roll back the
  // yml write. See ADR 0007.
  if (result.status === 'updated') {
    await syncPortsToProxy(input);
  }
  return result;
}

/**
 * Validate each entry as an integer in [1, 65535] and dedupe — same
 * port listed twice in the CLI args is treated as one. Throws on
 * any non-integer or out-of-range value with the offending input
 * verbatim so the builder can fix the typo.
 */
function normalizePorts(raw: readonly (number | string)[]): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    const n = typeof item === 'number' ? item : Number(item);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(
        `Invalid port: ${JSON.stringify(item)}. Expected an integer between 1 and 65535.`,
      );
    }
    if (seen.has(n)) continue;
    seen.add(n);
    result.push(n);
  }
  return result;
}

export async function runAddFeature(
  input: AddFeatureInput,
): Promise<ModifyResult> {
  const raw = input.ref.trim();
  if (raw.length === 0) {
    throw new Error(
      'Missing feature ref. Usage: monoceros add-feature <containername> <feature>.',
    );
  }
  const resolved = await resolveFeatureRefOrShortname(raw);
  // User-supplied `-- key=value` options override the catalog-driven
  // defaults that come with a short name. For a full OCI ref the
  // resolver returns no defaults, so this is just `input.options`.
  const merged: FeatureOptions = {
    ...resolved.defaultOptions,
    ...(input.options ?? {}),
  };
  // A sub-tool selector (`atlassian/twg`) merges additively into an
  // already-present entry; a plain feature / raw ref keeps the
  // overwrite-protected behavior. `raw` is the form the builder typed,
  // echoed in the conflict error so the remove-feature hint matches.
  const result = await mutate(input, (doc) =>
    addFeatureToDoc(doc, resolved.ref, merged, {
      isPreset: resolved.isPreset,
      displayName: raw,
    }),
  );

  // Seed the feature's credential vars into <name>.env (the same
  // ${VAR} placeholders addFeatureToDoc just wrote into the yml), so
  // the builder only fills values. Skips keys already set with an
  // active `-- key=value`. Mirrors init; remove-feature does NOT touch
  // the env file.
  if (result.status === 'updated') {
    const summary = loadFeatureManifestSummary(resolved.ref);
    const vars = featureOptionHints(
      summary,
      resolved.ref,
      Object.keys(merged),
    ).map((h) => h.envVar);
    if (vars.length > 0) {
      const home = input.monocerosHome ?? defaultMonocerosHome();
      await ensureEnvGitignored(containerConfigsDir(home));
      const seeded = await ensureEnvVars(
        containerEnvPath(input.name, home),
        input.name,
        vars,
      );
      if (seeded.added.length > 0) {
        (input.logger ?? defaultLogger()).info(
          `Seeded ${seeded.added.join(', ')} into ${input.name}.env — fill in the values.`,
        );
      }
    }
  }
  return result;
}

/**
 * Accept either a full OCI feature ref (`ghcr.io/.../foo:1`) or a
 * catalog short-name (`atlassian`, `atlassian/twg`, `claude`, …).
 *
 * Short names map to the matching component's `contributes.features`
 * entry; the entry's `options` (if any) become the default option
 * values the caller's `--` overrides apply on top of. Unknown short
 * names produce an error that lists the available features.
 *
 * `isPreset` marks a sub-tool selector (`atlassian/twg`) as opposed to a
 * bare feature (`atlassian`, `claude`) or a raw OCI ref. Only a preset
 * merges additively into an already-present entry; the rest keep the
 * overwrite-protected behavior (re-adding with different options errors).
 */
async function resolveFeatureRefOrShortname(input: string): Promise<{
  ref: string;
  defaultOptions: FeatureOptions;
  isPreset: boolean;
}> {
  if (REGEX.featureRef.test(input)) {
    return { ref: input, defaultOptions: {}, isPreset: false };
  }
  const catalog = await loadComponentCatalog();
  const component = catalog.get(input);
  if (!component) {
    const featureShorts = [...catalog.values()]
      .filter((c) => c.file.category === 'feature')
      .map((c) => c.name)
      .sort();
    const knownList =
      featureShorts.length > 0 ? featureShorts.join(', ') : '(none)';
    throw new Error(
      `Unknown feature: ${JSON.stringify(input)}. ` +
        `Pass either a catalog short-name (one of: ${knownList}) ` +
        `or a full OCI ref like ` +
        `'ghcr.io/getmonoceros/monoceros-features/<name>:<tag>'.`,
    );
  }
  if (component.file.category !== 'feature') {
    throw new Error(
      `'${input}' is a ${component.file.category}, not a feature. ` +
        `Use 'monoceros add-${component.file.category} <name> ${input}' instead.`,
    );
  }
  const features = component.file.contributes.features ?? [];
  if (features.length === 0) {
    throw new Error(
      `Catalog entry '${input}' contributes no feature ref — bug or stale catalog.`,
    );
  }
  if (features.length > 1) {
    // Practically: Monoceros's own catalog has one ref per feature
    // component. A multi-ref short-name would be ambiguous because
    // `add-feature` only adds one ref at a time.
    throw new Error(
      `'${input}' bundles multiple feature refs (${features
        .map((f) => f.ref)
        .join(
          ', ',
        )}). add-feature handles one at a time — pass the OCI ref directly.`,
    );
  }
  const [first] = features;
  // `base/preset` selectors carry a `/`; a bare selector does not (a raw
  // OCI ref with slashes is handled above).
  return {
    ref: first!.ref,
    defaultOptions: { ...(first!.options ?? {}) },
    isPreset: input.includes('/'),
  };
}

// ─── remove-* ─────────────────────────────────────────────────────

export function runRemoveLanguage(
  input: RemoveLanguageInput,
): Promise<ModifyResult> {
  return mutate(input, (doc) => removeLanguageFromDoc(doc, input.language));
}

export function runRemoveService(
  input: RemoveServiceInput,
): Promise<ModifyResult> {
  return mutate(input, (doc) => removeServiceFromDoc(doc, input.service));
}

export function runRemoveAptPackages(
  input: RemoveAptPackagesInput,
): Promise<ModifyResult> {
  if (input.packages.length === 0) {
    throw new Error(
      'No package names given. Usage: monoceros remove-apt-packages <containername> -- <pkg> [<pkg> …].',
    );
  }
  return mutate(input, (doc) => removeAptPackagesFromDoc(doc, input.packages));
}

export async function runRemoveFeature(
  input: RemoveFeatureInput,
): Promise<ModifyResult> {
  const raw = input.ref.trim();
  if (raw.length === 0) {
    throw new Error(
      'Missing feature ref. Usage: monoceros remove-feature <containername> <feature>.',
    );
  }
  // Same short-name → ref resolution as `add-feature`. Without this
  // the suggestion `monoceros remove-feature atlassian` we print
  // elsewhere wouldn't actually work, only the full OCI form.
  const resolved = await resolveFeatureRefOrShortname(raw);
  return mutate(input, (doc) => removeFeatureFromDoc(doc, resolved.ref));
}

export function runRemoveFromUrl(
  input: RemoveFromUrlInput,
): Promise<ModifyResult> {
  const url = input.url.trim();
  if (url.length === 0) {
    throw new Error(
      'Missing URL. Usage: monoceros remove-from-url <containername> <url>.',
    );
  }
  return mutate(input, (doc) => removeInstallUrlFromDoc(doc, url));
}

export async function runRemovePort(
  input: RemovePortInput,
): Promise<ModifyResult> {
  if (input.ports.length === 0) {
    throw new Error(
      'No ports given. Usage: monoceros remove-port <containername> -- <port> [<port> …].',
    );
  }
  const ports = normalizePorts(input.ports);
  const result = await mutate(input, (doc) => removePortsFromDoc(doc, ports));
  // Hot-reload path: same state-driven sync as add-port. When the
  // last port is gone the dynamic-config file is dropped and the
  // Traefik singleton is offered up for teardown via maybeStopProxy
  // (which no-ops if any other container is still attached). See
  // ADR 0007.
  if (result.status === 'updated') {
    await syncPortsToProxy(input);
  }
  return result;
}

export function runRemoveRepo(input: RemoveRepoInput): Promise<ModifyResult> {
  const target = input.target.trim();
  if (target.length === 0) {
    throw new Error(
      'Missing repo identifier. Usage: monoceros remove-repo <containername> <url-or-name>.',
    );
  }
  return mutate(input, (doc) => removeRepoFromDoc(doc, target));
}

// ─── core mutate skeleton ─────────────────────────────────────────

async function mutate(
  opts: ModifyOptions,
  apply: YmlMutator,
): Promise<ModifyResult> {
  if (!REGEX.solutionName.test(opts.name)) {
    throw new Error(
      `Invalid container name: ${JSON.stringify(opts.name)}. Use letters, digits, '.', '_' or '-'.`,
    );
  }
  const home = opts.monocerosHome ?? defaultMonocerosHome();
  const ymlPath = containerConfigPath(opts.name, home);
  const logger = opts.logger ?? defaultLogger();

  let oldText: string;
  try {
    oldText = await fs.readFile(ymlPath, 'utf8');
  } catch {
    throw new Error(
      `No such config: ${ymlPath}. Run \`monoceros init <template> ${opts.name}\` first.`,
    );
  }

  const parsed = parseConfig(oldText, ymlPath);
  const changed = apply(parsed.doc);

  if (!changed) {
    logger.info('No changes — yml is already in the desired state.');
    return { status: 'no-change' };
  }

  // Centralised post-mutation comment fixup. yaml-lib's parser
  // sometimes attaches a column-0 comment block that visually belongs
  // to the NEXT top-level pair (e.g. the `# Container ports exposed…`
  // header above `routing:`) to the previous pair's deepest trailing
  // node instead. On re-emit via the AST, the comment then drifts
  // into the previous section. We run the relocator once here so
  // every add-*/remove-* mutator gets the fix for free — without it,
  // a sequence like `init` → `add-feature` rearranges the routing /
  // repos section headers into the features block above.
  relocateLeakedSectionComments(parsed.doc);

  // Re-validate via a round-trip so schema violations introduced by
  // the mutation surface here with the regular field-path error, not
  // later at apply time.
  const newText = stringifyConfig(parsed.doc);
  parseConfig(newText, ymlPath);

  const out = opts.output ?? ((line) => process.stdout.write(line + '\n'));
  out(createPatch(ymlPath, oldText, newText, 'before', 'after'));

  if (!opts.yes) {
    const confirm = opts.confirm ?? defaultConfirm;
    const ok = await confirm('Apply these changes to the yml?');
    if (!ok) {
      logger.warn('Aborted by user. The yml was not modified.');
      return { status: 'aborted' };
    }
  }

  await fs.writeFile(ymlPath, newText, 'utf8');
  logger.success(`Updated ${ymlPath}.`);
  logger.info(
    `Run \`monoceros apply ${opts.name}\` to rebuild the dev-container and pick up the change.`,
  );
  return { status: 'updated', changedPaths: [ymlPath] };
}

function defaultLogger(): ModifyLogger {
  return {
    info: (m) => consola.info(m),
    success: (m) => consola.success(m),
    warn: (m) => consola.warn(m),
  };
}

const defaultConfirm: ConfirmFn = async (message) => {
  const result = await consola.prompt(message, {
    type: 'confirm',
    initial: false,
  });
  return result === true;
};

/**
 * State-driven sync between the yml's `ports:` and Traefik's
 * dynamic-config directory + proxy lifecycle. Called from
 * `runAddPort` / `runRemovePort` after a successful yml change.
 *
 *   - ports non-empty → write `<home>/traefik/dynamic/<name>.yml`
 *     and call `ensureProxy()` (idempotent — no-op when Traefik is
 *     already up).
 *   - ports empty → remove the file and call `maybeStopProxy()`
 *     (no-op when other containers still depend on the proxy).
 *
 * Any proxy or filesystem failure is surfaced as a warn but never
 * rolls back the yml write. The yml is the source of truth; proxy
 * state is derived and self-healing on the next apply/start.
 */
async function syncPortsToProxy(
  input: AddPortInput | RemovePortInput,
): Promise<void> {
  const home = input.monocerosHome ?? defaultMonocerosHome();
  const ymlPath = containerConfigPath(input.name, home);
  const logger = input.logger ?? defaultLogger();

  let allPorts: number[];
  try {
    const parsed = await readConfig(ymlPath);
    allPorts = (parsed.config.routing?.ports ?? []).map(portNumber);
  } catch (err) {
    logger.warn(
      `Could not re-read yml after edit to sync Traefik routes: ${err instanceof Error ? err.message : String(err)}. The yml is correct; \`monoceros apply ${input.name}\` will rebuild the routes.`,
    );
    return;
  }

  // Effective host port for the Traefik singleton — falls back to 80
  // when monoceros-config.yml has no `routing.hostPort`. Read once per
  // sync so we have the right value for both ensureProxy and the URLs
  // we print back.
  let hostPort = 80;
  try {
    const globalConfig = await readMonocerosConfig({ monocerosHome: home });
    hostPort = proxyHostPort(globalConfig);
  } catch {
    // Bad monoceros-config.yml is the user's problem to fix; don't
    // strand the sync over it. Default 80 is the right fallback.
  }

  // Pre-flight outside the warn-only try/catch: a held host port is
  // a hard-fail (the route would never come up otherwise), and the
  // builder needs the actionable message verbatim. The yml is
  // already updated at this point — that's fine, it's the source of
  // truth and the next apply heals once the conflict is resolved.
  if (allPorts.length > 0) {
    await preflightHostPort(hostPort, {
      ...(input.proxyDocker ? { docker: input.proxyDocker } : {}),
    });
  }

  try {
    if (allPorts.length > 0) {
      await writeDynamicConfig(input.name, allPorts, { monocerosHome: home });
      await ensureProxy({
        monocerosHome: home,
        hostPort,
        ...(input.proxyDocker ? { docker: input.proxyDocker } : {}),
        logger: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
      });
      const urls = proxyUrlsFor(input.name, allPorts, hostPort);
      const lines = urls.map((u) => {
        const tag = u.isDefault ? ' (default)' : '';
        return `  ${u.url}${tag}`;
      });
      logger.info(`Traefik routes refreshed:\n${lines.join('\n')}`);
    } else {
      await removeDynamicConfig(input.name, { monocerosHome: home });
      await maybeStopProxy({
        monocerosHome: home,
        ...(input.proxyDocker ? { docker: input.proxyDocker } : {}),
        logger: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
      });
    }
  } catch (err) {
    logger.warn(
      `Could not sync Traefik routes after yml edit: ${err instanceof Error ? err.message : String(err)}. The yml is correct; \`monoceros apply ${input.name}\` will rebuild the routes.`,
    );
  }
}
