import { promises as fs } from 'node:fs';
import { consola } from 'consola';
import { createPatch } from 'diff';
import type { Document } from 'yaml';
import { parseConfig, readConfig, stringifyConfig } from '../config/io.js';
import {
  containerConfigPath,
  monocerosHome as defaultMonocerosHome,
} from '../config/paths.js';
import {
  KNOWN_PROVIDER_HOSTS,
  PROVIDER_VALUES,
  REGEX,
  portNumber,
  type RepoProvider,
} from '../config/schema.js';
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
import {
  BUILTIN_LANGUAGES,
  LANGUAGE_CATALOG,
  SERVICE_CATALOG,
  knownLanguages,
  knownServices,
} from '../create/catalog.js';
import { deriveRepoName } from '../create/scaffold.js';
import type { FeatureOptions, RepoEntry } from '../create/types.js';
import {
  addAptPackagesToDoc,
  addFeatureToDoc,
  addInstallUrlToDoc,
  addLanguageToDoc,
  addPortsToDoc,
  addRepoToDoc,
  addServiceToDoc,
  removeAptPackagesFromDoc,
  removeFeatureFromDoc,
  removeInstallUrlFromDoc,
  removeLanguageFromDoc,
  removePortsFromDoc,
  removeRepoFromDoc,
  removeServiceFromDoc,
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
  if (
    !BUILTIN_LANGUAGES.has(input.language) &&
    !LANGUAGE_CATALOG[input.language]
  ) {
    throw new Error(
      `Unknown language: ${input.language}. Known: ${knownLanguages().join(', ')}.`,
    );
  }
  return mutate(input, (doc) => addLanguageToDoc(doc, input.language));
}

export function runAddService(input: AddServiceInput): Promise<ModifyResult> {
  if (!SERVICE_CATALOG[input.service]) {
    throw new Error(
      `Unknown service: ${input.service}. Known: ${knownServices().join(', ')}.`,
    );
  }
  return mutate(input, (doc) => addServiceToDoc(doc, input.service));
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
  return mutate(input, (doc) => addRepoToDoc(doc, entry));
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
  const result = await mutate(input, (doc) => addPortsToDoc(doc, ports));
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

export function runAddFeature(input: AddFeatureInput): Promise<ModifyResult> {
  const ref = input.ref.trim();
  if (ref.length === 0) {
    throw new Error(
      'Missing feature ref. Usage: monoceros add-feature <containername> <ref>.',
    );
  }
  return mutate(input, (doc) => addFeatureToDoc(doc, ref, input.options ?? {}));
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

export function runRemoveFeature(
  input: RemoveFeatureInput,
): Promise<ModifyResult> {
  const ref = input.ref.trim();
  if (ref.length === 0) {
    throw new Error(
      'Missing feature ref. Usage: monoceros remove-feature <containername> <ref>.',
    );
  }
  return mutate(input, (doc) => removeFeatureFromDoc(doc, ref));
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
    allPorts = parsed.config.ports.map(portNumber);
  } catch (err) {
    logger.warn(
      `Could not re-read yml after edit to sync Traefik routes: ${err instanceof Error ? err.message : String(err)}. The yml is correct; \`monoceros apply ${input.name}\` will rebuild the routes.`,
    );
    return;
  }

  try {
    if (allPorts.length > 0) {
      await writeDynamicConfig(input.name, allPorts, { monocerosHome: home });
      await ensureProxy({
        monocerosHome: home,
        ...(input.proxyDocker ? { docker: input.proxyDocker } : {}),
        logger: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
      });
      const urls = proxyUrlsFor(input.name, allPorts);
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
