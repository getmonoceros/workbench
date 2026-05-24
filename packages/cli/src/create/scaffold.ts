import { existsSync, readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { workbenchCheckoutRoot } from '../config/paths.js';
import { matchMonocerosFeature } from '../util/ref.js';
import {
  BASE_IMAGE,
  BUILTIN_LANGUAGES,
  LANGUAGE_CATALOG,
  SERVICE_CATALOG,
  knownLanguages,
  knownServices,
  parseLanguageSpec,
} from './catalog.js';
import type { CreateOptions } from './types.js';

// Debian/Ubuntu apt package name rules: start with alphanumeric, then
// alphanumerics + `.+-` are allowed. We intentionally don't allow shell
// metacharacters (`;`, `&`, `|`, `$`, `(`, …) so a typo can't smuggle
// arbitrary shell into the apt-packages feature config.
const APT_PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9.+-]*$/;

// Devcontainer feature refs are OCI-style:
//   <registry>/<namespace>/<feature>:<tag>
// e.g. ghcr.io/devcontainers/features/python:1
//      ghcr.io/getmonoceros/monoceros-features/claude-code:1
const FEATURE_REF_RE = /^[a-z0-9.-]+(\/[a-z0-9._-]+)+:[a-z0-9._-]+$/;

// Install URLs must be https:// (no plain http, no other schemes) and
// contain only URL-safe characters. We deliberately reject shell
// metacharacters even inside a query string — the URL is embedded into
// a generated bash script, and a stray `$` or backtick would be a
// shell-injection vector.
const INSTALL_URL_RE = /^https:\/\/[A-Za-z0-9.\-_~/:?#[\]@!&'()*+,;=%]+$/;

// Git URLs: covers HTTPS, SSH (`git@host:path/repo.git`), and
// `ssh://`/`git://` schemes. Permissive but no shell metacharacters.
const REPO_URL_RE = /^[A-Za-z0-9@:/+_~.#=&?-]+$/;

// Repo destination = path under `projects/`. Allows nested subfolders
// (`apps/web`) via `/`; segments use `[A-Za-z0-9._-]` (same charset as
// a leaf folder name). `.` / `..` segments are rejected separately
// because the regex alone allows pure-dot segments.
const REPO_PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/**
 * Derive a repo name from its URL.
 *
 *   `git@github.com:foo/bar.git`     → `bar`
 *   `https://github.com/foo/bar.git` → `bar`
 *   `https://github.com/foo/bar`     → `bar`
 *   `ssh://git@host:22/foo/bar.git`  → `bar`
 */
export function deriveRepoName(url: string): string {
  const lastSep = Math.max(url.lastIndexOf('/'), url.lastIndexOf(':'));
  const tail = url.slice(lastSep + 1);
  return tail.replace(/\.git$/, '');
}

export function validateOptions(opts: CreateOptions): void {
  if (!opts.name || !/^[a-zA-Z0-9._-]+$/.test(opts.name)) {
    throw new Error(
      `Invalid solution name: ${JSON.stringify(opts.name)}. Use letters, digits, '.', '_' or '-'.`,
    );
  }
  for (const langSpec of opts.languages) {
    const parsed = parseLanguageSpec(langSpec);
    if (!parsed) {
      throw new Error(
        `Invalid language spec: ${JSON.stringify(langSpec)}. Expected '<name>' or '<name>:<version>'.`,
      );
    }
    if (!BUILTIN_LANGUAGES.has(parsed.name) && !LANGUAGE_CATALOG[parsed.name]) {
      throw new Error(
        `Unknown language: ${parsed.name}. Known: ${knownLanguages().join(', ')}.`,
      );
    }
  }
  for (const svc of opts.services) {
    if (!SERVICE_CATALOG[svc]) {
      throw new Error(
        `Unknown service: ${svc}. Known: ${knownServices().join(', ')}.`,
      );
    }
  }
  for (const pkg of opts.aptPackages ?? []) {
    if (!APT_PACKAGE_NAME_RE.test(pkg)) {
      throw new Error(
        `Invalid apt package name: ${JSON.stringify(pkg)}. Expected lowercase alphanumeric plus '.+-'.`,
      );
    }
  }
  for (const ref of Object.keys(opts.features ?? {})) {
    if (!FEATURE_REF_RE.test(ref)) {
      throw new Error(
        `Invalid devcontainer feature ref: ${JSON.stringify(ref)}. Expected OCI-image-style ref like 'ghcr.io/devcontainers/features/<name>:<tag>'.`,
      );
    }
  }
  for (const url of opts.installUrls ?? []) {
    if (!INSTALL_URL_RE.test(url)) {
      throw new Error(
        `Invalid install URL: ${JSON.stringify(url)}. Must start with 'https://' and contain only URL-safe characters (no shell metacharacters).`,
      );
    }
  }
  const seenRepoPaths = new Set<string>();
  for (const repo of opts.repos ?? []) {
    if (!REPO_URL_RE.test(repo.url)) {
      throw new Error(
        `Invalid repo URL: ${JSON.stringify(repo.url)}. Use HTTPS or SSH/git@ form; no shell metacharacters.`,
      );
    }
    if (!REPO_PATH_RE.test(repo.path)) {
      throw new Error(
        `Invalid repo path: ${JSON.stringify(repo.path)}. Use letters/digits/'._-', forward slashes for nested folders, no leading or trailing slash.`,
      );
    }
    if (repo.path.split('/').some((seg) => seg === '..' || seg === '.')) {
      throw new Error(
        `Invalid repo path: ${JSON.stringify(repo.path)}. Path segments cannot be "." or "..".`,
      );
    }
    if (seenRepoPaths.has(repo.path)) {
      throw new Error(
        `Duplicate repo path: ${JSON.stringify(repo.path)}. Each projects/<path> folder must be unique — pass --path to disambiguate.`,
      );
    }
    seenRepoPaths.add(repo.path);
  }
}

// Normalize: dedupe + sort + drop postgres from compose services when an
// external --postgres-url is provided.
export function normalizeOptions(opts: CreateOptions): CreateOptions {
  const languages = [...new Set(opts.languages)].sort();
  let services = [...new Set(opts.services)].sort();
  if (opts.postgresUrl) {
    services = services.filter((s) => s !== 'postgres');
  }
  const aptPackages = [...new Set(opts.aptPackages ?? [])].sort();
  // Sort feature refs alphabetically so devcontainer.json + stack.json
  // output is deterministic regardless of insertion order.
  const features = opts.features
    ? Object.fromEntries(
        Object.entries(opts.features).sort(([a], [b]) => a.localeCompare(b)),
      )
    : undefined;
  // Install URLs preserve insertion order (installs may depend on each
  // other), but we deduplicate to keep stack.json stable across re-adds.
  const installUrls = opts.installUrls
    ? [...new Set(opts.installUrls)]
    : undefined;
  // Repos: preserve insertion order, dedupe by (url, name, branch)
  // signature — same triple twice is a no-op, different triples
  // coexist. (Same name with different URL is a validation error
  // in validateOptions, not silently merged here.)
  const repos = opts.repos
    ? Array.from(
        new Map(opts.repos.map((r) => [`${r.url}${r.path}`, r])).values(),
      )
    : undefined;
  return {
    name: opts.name,
    languages,
    services,
    postgresUrl: opts.postgresUrl,
    ...(aptPackages.length > 0 ? { aptPackages } : {}),
    ...(features && Object.keys(features).length > 0 ? { features } : {}),
    ...(installUrls && installUrls.length > 0 ? { installUrls } : {}),
    ...(repos && repos.length > 0 ? { repos } : {}),
  };
}

export function needsCompose(opts: CreateOptions): boolean {
  return opts.services.length > 0;
}

interface DevcontainerImageMode {
  name: string;
  image: string;
  remoteUser: string;
  // Scaffold-level mounts: only the SSH-agent forward for git auth when
  // the yml lists repos. Tool-specific mounts (e.g. ~/.claude for the
  // claude-code feature) come from the feature's own manifest, not from
  // here.
  mounts?: string[];
  // Override of the workspace bind-mount. Set only when the host
  // runs rootless Docker — we append `idmap` so the kernel applies
  // the user-namespace mapping to the mount, which makes files
  // written by either side appear with sane UIDs on the other.
  // Without this, host-pre-created `projects/` appears as root in
  // the container and the non-root `node` user can't write into it.
  workspaceMount?: string;
  // Required so the runtime image's entrypoint can install iptables
  // rules if MONOCEROS_EGRESS=enforce is set. Default mode is `off`
  // (see ADR 0002) so the cap is harmless when unused.
  runArgs: string[];
  forwardPorts: number[];
  postCreateCommand: string;
  features?: Record<string, Record<string, unknown>>;
  // Env vars injected into the workspace container at start time
  // (inherited by postCreateCommand). Used by add-repo to wire the
  // forwarded SSH-agent socket and a permissive SSH host-key policy.
  containerEnv?: Record<string, string>;
  // VS Code-specific overrides written into the materialized
  // devcontainer.json. Today only carries `remote.autoForwardPorts`
  // (toggled by `ide.vscodeAutoForwardPorts` from the yml). Future
  // feature/yml fields can extend the shape additively.
  customizations?: DevcontainerCustomizations;
}

interface DevcontainerComposeMode {
  name: string;
  dockerComposeFile: string;
  service: string;
  // Without runServices, `devcontainer up` only brings up the named service.
  // Listing the auxiliary services here ensures postgres/redis/… come up
  // alongside the workspace container.
  runServices?: string[];
  workspaceFolder: string;
  remoteUser: string;
  forwardPorts: number[];
  postCreateCommand: string;
  features?: Record<string, Record<string, unknown>>;
  customizations?: DevcontainerCustomizations;
}

interface DevcontainerCustomizations {
  vscode?: {
    settings?: Record<string, unknown>;
    extensions?: string[];
  };
}

/**
 * The host docker daemon's mode — passed in by `apply` after a
 * `docker info` probe. Drives whether we emit `idmap` on bind
 * mounts. See `devcontainer/docker-mode.ts` for the rationale.
 */
export type DockerMode = 'rootful' | 'rootless';

// Repo auth note: Monoceros supports HTTPS-only repo URLs (see ADR
// 0006). The host's git credential helper provides the username/token
// per host (osxkeychain on macOS, libsecret on Linux, wincred on
// Windows, plus `gh auth setup-git` for GitHub specifically), the
// apply pipeline writes them to <container-dir>/.monoceros/git-
// credentials, and post-create.sh wires `git config --global
// credential.helper "store --file=…"` so the container reads from
// the same file. SSH-agent forwarding, multi-key wiring, host-OS
// platform-specific socket paths — all that complexity stays out.

export type DevcontainerJson = DevcontainerImageMode | DevcontainerComposeMode;

/**
 * Per-feature plan for the container build.
 *
 *  - `devcontainerKey` — the key used in `devcontainer.json → features`.
 *  - `localSourceDir` / `localName` — set when the workbench has the
 *    feature on disk. `writeScaffold` copies the directory into
 *    `<container>/.devcontainer/features/<name>/` and uses the
 *    relative path `./features/<name>` in devcontainer.json.
 *    (devcontainer-cli accepts relative paths from `.devcontainer/`
 *    but rejects absolute filesystem paths to local features.)
 */
interface ResolvedFeature {
  devcontainerKey: string;
  options: Record<string, unknown>;
  localSourceDir?: string;
  localName?: string;
  /**
   * Subdirectories of `/home/node/` that this feature wants to
   * persist across container rebuilds. Each entry is bind-mounted
   * from `<container-dir>/home/<path>` into `/home/node/<path>` and
   * pre-created as an empty directory on the host. Read from the
   * feature manifest's `x-monoceros.persistentHomePaths` array.
   */
  persistentHomePaths: string[];
  /**
   * Like `persistentHomePaths`, but for individual **files** rather
   * than directories. Necessary for tools that keep state in a
   * dotfile next to (not inside) their config directory — e.g.
   * Claude Code's `~/.claude.json` lives alongside `~/.claude/`.
   *
   * Each entry can be a bare path string (file pre-created empty)
   * or `{ path, initialContent }` so a feature author can seed
   * valid initial content. The latter is needed for tools that
   * refuse to parse an empty file: Claude Code, for instance, errors
   * on an empty `.claude.json` and demands at least `{}`. Read from
   * the feature manifest's `x-monoceros.persistentHomeFiles` array.
   */
  persistentHomeFiles: PersistentHomeFile[];
}

interface PersistentHomeFile {
  path: string;
  initialContent: string;
}

/**
 * Compute the feature list for `opts`. Detects Monoceros-owned refs
 * (`ghcr.io/getmonoceros/monoceros-features/<name>:<tag>`) and, if
 * the workbench has the feature on disk, rewrites the key to
 * `./features/<name>` and records the source for the copy step.
 *
 * Third-party refs and Monoceros refs without a local source pass
 * through verbatim — devcontainer-cli pulls them from the registry.
 */
export function resolveFeatures(opts: CreateOptions): ResolvedFeature[] {
  const resolved: ResolvedFeature[] = [];

  for (const langSpec of opts.languages) {
    const parsed = parseLanguageSpec(langSpec);
    if (!parsed) continue;
    // Builtin only applies to the bare `node` (no version) — the
    // base image's node 22 isn't pinnable, so any `node:<version>`
    // has to go through the upstream feature like everything else.
    if (BUILTIN_LANGUAGES.has(parsed.name) && parsed.version === undefined) {
      continue;
    }
    const entry = LANGUAGE_CATALOG[parsed.name];
    if (!entry) continue;
    const options: Record<string, string> = {};
    if (parsed.version !== undefined) options.version = parsed.version;
    resolved.push({
      devcontainerKey: entry.feature,
      options,
      persistentHomePaths: [],
      persistentHomeFiles: [],
    });
  }
  if (opts.aptPackages && opts.aptPackages.length > 0) {
    resolved.push({
      devcontainerKey: 'ghcr.io/devcontainers-contrib/features/apt-packages:1',
      options: { packages: opts.aptPackages.join(',') },
      persistentHomePaths: [],
      persistentHomeFiles: [],
    });
  }
  if (opts.features) {
    for (const [rawRef, options] of Object.entries(opts.features)) {
      const match = matchMonocerosFeature(rawRef);
      if (match) {
        const name = match.name;
        // Dev-only fallback: when the CLI is run from a workbench
        // checkout, prefer the on-disk copy under `images/features/`
        // so feature edits are testable without a publish. In prod
        // (npm-installed), `workbenchCheckoutRoot()` returns null
        // and we fall through to the GHCR-ref passthrough.
        const checkout = workbenchCheckoutRoot();
        const localSourceDir = checkout
          ? path.join(checkout, 'images', 'features', name)
          : null;
        if (localSourceDir && existsSync(localSourceDir)) {
          const { paths, files } = readPersistentHomeEntries(localSourceDir);
          resolved.push({
            devcontainerKey: `./features/${name}`,
            options,
            localSourceDir,
            localName: name,
            persistentHomePaths: paths,
            persistentHomeFiles: files,
          });
          continue;
        }
      }
      resolved.push({
        devcontainerKey: rawRef,
        options,
        persistentHomePaths: [],
        persistentHomeFiles: [],
      });
    }
  }
  return resolved;
}

/**
 * Read `x-monoceros.persistentHomePaths` and
 * `x-monoceros.persistentHomeFiles` from a feature's manifest on
 * disk. Returns `{paths: [], files: []}` when the manifest doesn't
 * exist, can't be parsed, or the fields are missing — always
 * best-effort, never throws. Both arrays are validated to contain
 * only safe relative subpaths (no `..`, no absolute, no shell
 * metacharacters); anything else is silently dropped, since a bad
 * value here is a feature-author bug, not something a builder can fix.
 */
function readPersistentHomeEntries(localSourceDir: string): {
  paths: string[];
  files: PersistentHomeFile[];
} {
  const manifestPath = path.join(localSourceDir, 'devcontainer-feature.json');
  try {
    const text = readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(text) as {
      'x-monoceros'?: {
        persistentHomePaths?: unknown;
        persistentHomeFiles?: unknown;
      };
    };
    return {
      paths: filterSubpaths(parsed['x-monoceros']?.persistentHomePaths),
      files: filterFileEntries(parsed['x-monoceros']?.persistentHomeFiles),
    };
  } catch {
    return { paths: [], files: [] };
  }
}

function filterSubpaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is string =>
      typeof p === 'string' &&
      p.length > 0 &&
      !p.startsWith('/') &&
      !p.includes('..') &&
      HOME_SUBPATH_RE.test(p),
  );
}

/**
 * Accept either bare strings or `{path, initialContent}` objects in
 * `persistentHomeFiles`. Bare string is shorthand for "create an
 * empty file"; the object form lets feature authors provide initial
 * content (e.g. `{}` for a JSON config that the tool refuses to
 * parse when empty).
 */
function filterFileEntries(raw: unknown): PersistentHomeFile[] {
  if (!Array.isArray(raw)) return [];
  const result: PersistentHomeFile[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      if (isValidHomeSubpath(entry)) {
        result.push({ path: entry, initialContent: '' });
      }
      continue;
    }
    if (
      entry !== null &&
      typeof entry === 'object' &&
      'path' in entry &&
      typeof (entry as { path: unknown }).path === 'string'
    ) {
      const e = entry as { path: string; initialContent?: unknown };
      if (!isValidHomeSubpath(e.path)) continue;
      const initialContent =
        typeof e.initialContent === 'string' ? e.initialContent : '';
      result.push({ path: e.path, initialContent });
    }
  }
  return result;
}

function isValidHomeSubpath(p: string): boolean {
  return (
    p.length > 0 &&
    !p.startsWith('/') &&
    !p.includes('..') &&
    HOME_SUBPATH_RE.test(p)
  );
}

// Home subpaths: dot-prefixed dirs and config-like sub-dirs.
// Restrictive on purpose — only `.foo`, `.foo/bar`, `foo`, `foo/bar`,
// no whitespace, no shell metacharacters.
const HOME_SUBPATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export function buildDevcontainerJson(
  opts: CreateOptions,
  dockerMode: DockerMode = 'rootful',
): DevcontainerJson {
  const resolvedFeatures = resolveFeatures(opts);
  const features: Record<string, Record<string, unknown>> = {};
  for (const f of resolvedFeatures) {
    features[f.devcontainerKey] = f.options;
  }

  const featuresField =
    Object.keys(features).length > 0 ? { features } : undefined;

  // Rootless-Docker bind-mount handling is currently a TODO. Earlier
  // attempts (1.6.3 / 1.6.5) appended `,idmap` / `,idmap=true` to the
  // mount string in the belief Docker supports idmapped mounts via
  // `--mount`. It doesn't — verified against the official docs at
  // https://docs.docker.com/engine/storage/bind-mounts/ — there is
  // no `idmap` key in the `--mount` syntax. Podman supports it,
  // Docker presently doesn't expose the kernel feature on the CLI.
  //
  // For now we emit the same mount strings regardless of dockerMode.
  // That leaves the rootless UID-shift problem (host pre-created
  // dirs appear as root in container; container-written files end
  // up at shifted UIDs on the host) unsolved — separate fix needed,
  // most likely via remoteUser=root in rootless mode so the
  // container's "root" maps to the host workspace owner. The
  // dockerMode parameter stays plumbed in so the next attempt can
  // diverge cleanly.
  void dockerMode;
  const idmapSuffix = '';

  // Bind-mounts for per-feature persistent home entries. Source on
  // the host is `<container-dir>/home/<subpath>` (under the
  // localWorkspaceFolder); target inside the container is the same
  // subpath under `/home/node/`. Files and directories both go through
  // the same `type=bind` syntax — docker decides from the source's
  // on-disk type. We pre-create both kinds in writeScaffold so the
  // owner matches the host user (otherwise docker auto-creates as
  // root on Linux, breaking writes inside the container) and so a
  // requested **file** bind doesn't get spawned as a directory.
  const homeMounts: string[] = [];
  for (const f of resolvedFeatures) {
    const allSubs = [
      ...f.persistentHomePaths,
      ...f.persistentHomeFiles.map((entry) => entry.path),
    ];
    for (const sub of allSubs) {
      homeMounts.push(
        `source=\${localWorkspaceFolder}/home/${sub},target=/home/node/${sub},type=bind${idmapSuffix}`,
      );
    }
  }

  // VS Code customizations — currently only the `remote.autoForwardPorts`
  // toggle when ports are declared. The default is `false` (Traefik is
  // the single source of truth for external URLs — VS Code's parallel
  // port-forward would be a confusing second URL for the same app).
  // Builders can flip it via `ide.vscodeAutoForwardPorts: true` in the
  // yml. See ADR 0007. Other extension hints belong with the feature
  // that needs them (e.g. the claude-code feature recommends
  // `anthropic.claude-code`).
  const ports = opts.ports ?? [];
  const customizationsField =
    ports.length > 0
      ? {
          customizations: {
            vscode: {
              settings: {
                'remote.autoForwardPorts': opts.vscodeAutoForwardPorts ?? false,
              },
            },
          },
        }
      : undefined;

  if (needsCompose(opts)) {
    // Compose-mode: per-feature persistent home mounts go onto the
    // workspace service in compose.yaml (see buildComposeYaml). The
    // devcontainer.json just references compose. Network membership
    // (`monoceros-proxy`) lives in compose.yaml's `networks:` block,
    // not here.
    return {
      name: opts.name,
      dockerComposeFile: 'compose.yaml',
      service: 'workspace',
      ...(opts.services.length > 0 ? { runServices: opts.services } : {}),
      workspaceFolder: `/workspaces/${opts.name}`,
      remoteUser: 'node',
      forwardPorts: ports,
      postCreateCommand: '.devcontainer/post-create.sh',
      ...(featuresField ?? {}),
      ...(customizationsField ?? {}),
    };
  }

  // Image-mode mounts: per-feature persistent-home binds.
  const mounts: string[] = [...homeMounts];
  const mountsField = mounts.length > 0 ? { mounts } : {};

  // No workspaceMount override today — see the comment above about
  // the reverted idmap attempt. Once we have a working rootless
  // strategy, the override comes back here.
  const workspaceMountField = {};

  // Image-mode: when ports are declared, hook the container into the
  // `monoceros-proxy` network so the Traefik singleton can reach it
  // by container name. `--network` replaces docker's default bridge —
  // for image-mode that's the only network in play, so swapping is fine.
  // ensureProxy() (called from apply/start) creates the network before
  // this `runArgs` value is used.
  const runArgs = ['--cap-add=NET_ADMIN'];
  if (ports.length > 0) {
    runArgs.push('--network=monoceros-proxy');
  }

  return {
    name: opts.name,
    image: BASE_IMAGE,
    remoteUser: 'node',
    ...workspaceMountField,
    ...mountsField,
    runArgs,
    forwardPorts: ports,
    postCreateCommand: '.devcontainer/post-create.sh',
    ...(featuresField ?? {}),
    ...(customizationsField ?? {}),
  };
}

// Hand-rolled YAML for compose.yaml. The shape is narrow enough that
// avoiding a YAML dependency outweighs the cost of careful indentation.
//
// `dockerMode` is plumbed in for symmetry with buildDevcontainerJson
// and future rootless-specific tweaks, but currently unused (see the
// TODO in buildDevcontainerJson re: docker not exposing idmap on
// `--mount`).
export function buildComposeYaml(
  opts: CreateOptions,
  dockerMode: DockerMode = 'rootful',
): string {
  void dockerMode;
  const hasPorts = (opts.ports?.length ?? 0) > 0;
  const lines: string[] = ['services:'];

  lines.push('  workspace:');
  lines.push(`    image: ${BASE_IMAGE}`);
  lines.push("    command: 'sleep infinity'");
  // No `user:` directive here — the runtime image's entrypoint runs as
  // root to set up iptables, then drops to the `node` user via gosu
  // before exec'ing the command. NET_ADMIN is required for that
  // iptables setup; see ADR 0002.
  lines.push('    cap_add:');
  lines.push('      - NET_ADMIN');
  if (hasPorts) {
    // Workspace joins both the compose-default network (so it can
    // reach postgres/redis/… that share the project) and the
    // monoceros-proxy network (so Traefik can route to it by service
    // name). Compose auto-creates `default` since it's not redeclared
    // at the top-level networks block. See ADR 0007.
    lines.push('    networks:');
    lines.push('      - default');
    lines.push('      - monoceros-proxy');
  }
  lines.push('    volumes:');
  lines.push(`      - ..:/workspaces/${opts.name}:cached`);
  // Per-feature persistent home subpaths (dirs and files alike).
  // Paths inside compose.yaml are relative to the .devcontainer/
  // directory; `..` walks up to the container root, where `home/`
  // lives. Docker reads the host-side inode type to decide whether
  // the mount target inside the container is a file or a directory.
  const resolvedFeatures = resolveFeatures(opts);
  for (const f of resolvedFeatures) {
    const allSubs = [
      ...f.persistentHomePaths,
      ...f.persistentHomeFiles.map((entry) => entry.path),
    ];
    for (const sub of allSubs) {
      lines.push(`      - ../home/${sub}:/home/node/${sub}`);
    }
  }
  for (const svcId of opts.services) {
    const def = SERVICE_CATALOG[svcId];
    if (!def) continue;
    lines.push(`  ${def.id}:`);
    lines.push(`    image: ${def.image}`);
    if (def.env) {
      lines.push('    environment:');
      for (const [k, v] of Object.entries(def.env)) {
        lines.push(`      ${k}: ${v}`);
      }
    }
    if (def.dataMount) {
      // Per-service data dir bind-mounted from the host so DB content
      // is visible at `<container-dir>/data/<svc>/`. See ADR 0003 for
      // the per-container state-model this slots into. Pre-created in
      // writeScaffold so docker doesn't auto-mkdir as root.
      lines.push('    volumes:');
      lines.push(`      - ../data/${def.id}:${def.dataMount}`);
    }
  }

  if (hasPorts) {
    // `external: true` tells compose that `monoceros-proxy` is managed
    // outside this stack (Monoceros's proxy module creates it via
    // `docker network create`). Without this declaration compose would
    // try to create its own scoped network with the same name and
    // collide.
    lines.push('networks:');
    lines.push('  monoceros-proxy:');
    lines.push('    external: true');
  }

  return lines.join('\n') + '\n';
}

interface CodeWorkspaceFolder {
  path: string;
  name?: string;
}

interface CodeWorkspaceFile {
  folders: CodeWorkspaceFolder[];
}

/**
 * The `<name>.code-workspace` file VS Code uses to open the solution as
 * a multi-root workspace. The first entry is `.` so the workspace root
 * (with its system dotfolders) stays visible in the Explorer. Each
 * repo added via `monoceros add-repo` appears as a sibling root
 * pointing at `projects/<name>/`.
 */
export function buildCodeWorkspaceJson(opts: CreateOptions): CodeWorkspaceFile {
  const folders: CodeWorkspaceFolder[] = [{ path: '.' }];
  // Sort repos by path so the Explorer order is deterministic and
  // doesn't depend on insertion order. (Clone order in post-create
  // stays as-added so deps still work.)
  const sortedRepos = [...(opts.repos ?? [])].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  for (const repo of sortedRepos) {
    // The folder's display label is the leaf segment of the path
    // (the deepest folder name). VS Code shows it in the Explorer
    // tree; for nested clones (`apps/web`) we want `web`, not the
    // whole path.
    const label = repo.path.split('/').pop() ?? repo.path;
    folders.push({ path: `projects/${repo.path}`, name: label });
  }
  return { folders };
}

/**
 * Generate the `post-create.sh` content for a solution. Base sections
 * (git include + pnpm install) are fixed. The `installUrls` and
 * `repos` sections are appended only when those yml fields are
 * populated.
 */
export function buildPostCreateScript(opts: CreateOptions): string {
  const lines: string[] = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    '# Inherit host-side git identity (user.name / user.email) captured',
    '# into .monoceros/gitconfig by `monoceros apply`. Container-local',
    "# git config loads first; the include below merges the host's",
    '# identity values in.',
    `git config --global include.path "/workspaces/${opts.name}/.monoceros/gitconfig"`,
    '',
    '# Per-feature post-create hooks. Each Monoceros-curated feature',
    '# may drop a script into /usr/local/share/monoceros/post-create.d/',
    '# during its install.sh — typical job is a non-interactive login',
    '# against bind-mounted state under /home/node, using the option',
    '# values the feature received as env vars at install time. Scripts',
    '# run in lexicographic order, each in its own subshell, and a',
    '# failure aborts post-create (set -e is in effect).',
    'if [ -d /usr/local/share/monoceros/post-create.d ]; then',
    '  for hook in /usr/local/share/monoceros/post-create.d/*.sh; do',
    '    [ -f "$hook" ] || continue',
    '    echo "→ post-create hook: $(basename "$hook")"',
    '    bash "$hook"',
    '  done',
    'fi',
    '',
    '# Bring up Node dependencies if the workspace has a package.json.',
    'if [ -f package.json ]; then',
    '  pnpm install',
    'fi',
  ];

  if (opts.installUrls && opts.installUrls.length > 0) {
    lines.push(
      '',
      '# Custom install URLs added via `monoceros add-from-url`. Each is',
      '# fetched and piped to `sh` on every container rebuild. URLs run',
      '# in insertion order so later installs can build on earlier ones.',
      '#',
      '# Why `sh` (not `bash`): most install scripts target POSIX `sh`',
      '# and some (starship, rustup, …) explicitly refuse to run under',
      '# `bash`. Outer `set -o pipefail` in this script makes a curl',
      '# failure abort the post-create as expected.',
      `echo "→ Running ${opts.installUrls.length} install URL(s) added via add-from-url…"`,
    );
    for (const url of opts.installUrls) {
      lines.push(`echo "→ ${url}"`, `curl -fsSL "${url}" | sh`);
    }
  }

  if (opts.repos && opts.repos.length > 0) {
    const hasHttpsRepo = opts.repos.some((r) => r.url.startsWith('https://'));
    if (hasHttpsRepo) {
      lines.push(
        '',
        '# Wire git to the per-dev-container credentials file populated',
        '# by `monoceros apply` (via `git credential fill` on the host).',
        '# Path uses the workspace bind-mount so the file is reachable',
        '# from inside the container.',
        `git config --global credential.helper "store --file=/workspaces/${opts.name}/.monoceros/git-credentials"`,
      );
    }
    lines.push(
      '',
      '# Repos managed by `monoceros add-repo`. Each entry is cloned',
      '# into `projects/<path>/` if (and only if) the directory does',
      '# not exist yet. Existing project subfolders are left alone so',
      '# local changes survive `monoceros apply` rebuilds. Nested',
      '# `<path>` (e.g. apps/web) is created via `mkdir -p` before the',
      '# clone so the parent directories exist.',
      'mkdir -p projects',
    );
    for (const repo of opts.repos) {
      // For nested paths (`apps/web`), make sure the parent dir
      // exists before git clone — otherwise git fails with "could
      // not create work tree dir".
      const parent = repo.path.includes('/')
        ? repo.path.slice(0, repo.path.lastIndexOf('/'))
        : null;
      if (parent) {
        lines.push(`mkdir -p "projects/${parent}"`);
      }
      lines.push(
        `if [ ! -d "projects/${repo.path}" ]; then`,
        `  echo "→ Cloning ${repo.path} from ${repo.url}…"`,
        `  git clone "${repo.url}" "projects/${repo.path}"`,
        `else`,
        `  echo "→ projects/${repo.path} already exists, skipping clone"`,
        `fi`,
      );
      // Per-repo git identity override: set user.name/email inside
      // the cloned repo, so commits from THIS repo go out under the
      // override identity. Idempotent — git config overwrites the
      // value each run, no duplicate accumulation. Falls outside the
      // `if [ ! -d ... ]` clone-guard so an explicit yml update of
      // gitUser also takes effect on re-apply against an existing
      // clone.
      if (repo.gitUser) {
        const safeName = repo.gitUser.name.replace(/"/g, '\\"');
        const safeEmail = repo.gitUser.email.replace(/"/g, '\\"');
        lines.push(
          `git -C "projects/${repo.path}" config user.name "${safeName}"`,
          `git -C "projects/${repo.path}" config user.email "${safeEmail}"`,
        );
      }
    }
  }

  return lines.join('\n') + '\n';
}

export async function writePostCreateScript(
  devcontainerDir: string,
  opts: CreateOptions,
): Promise<void> {
  const dest = path.join(devcontainerDir, 'post-create.sh');
  await fs.writeFile(dest, buildPostCreateScript(opts));
  await fs.chmod(dest, 0o755);
}

/**
 * Materialize the full devcontainer scaffold for `opts` into
 * `targetDir`. Idempotent overwrite — re-running with different opts
 * produces the new scaffold and overwrites any older files.
 *
 * Writes:
 *   - `.devcontainer/devcontainer.json`
 *   - `.devcontainer/post-create.sh`
 *   - `.devcontainer/compose.yaml` (only when services are configured)
 *   - `.monoceros/.gitignore`
 *   - `projects/.gitkeep`
 *   - `<name>.code-workspace`
 *
 * Does NOT write `README.md` — the README is a once-only stub that
 * `runCreate` produces but `runApplyFromYml` should leave alone (the
 * builder may have edited it).
 *
 * Caller is responsible for `validateOptions(opts)` and
 * `normalizeOptions(opts)`; this function trusts the input.
 */
export async function writeScaffold(
  opts: CreateOptions,
  targetDir: string,
  scaffoldOpts: { dockerMode?: DockerMode } = {},
): Promise<void> {
  const dockerMode: DockerMode = scaffoldOpts.dockerMode ?? 'rootful';
  const devcontainerDir = path.join(targetDir, '.devcontainer');
  const monocerosDir = path.join(targetDir, '.monoceros');
  const projectsDir = path.join(targetDir, 'projects');
  const homeDir = path.join(targetDir, 'home');
  const dataDir = path.join(targetDir, 'data');
  await fs.mkdir(devcontainerDir, { recursive: true });
  await fs.mkdir(monocerosDir, { recursive: true });
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  if (needsCompose(opts)) {
    await fs.mkdir(dataDir, { recursive: true });
    // Pre-create one subdir per service so docker bind-mounts onto
    // an existing host path (and doesn't auto-mkdir as root, which
    // breaks postgres/mysql first-run on Linux).
    for (const svcId of opts.services) {
      const def = SERVICE_CATALOG[svcId];
      if (def?.dataMount) {
        await fs.mkdir(path.join(dataDir, def.id), { recursive: true });
      }
    }
  }

  // Container-root `.gitignore`. Excludes the directories that hold
  // builder-private or container-runtime state:
  //   - `home/`        — logins, sessions, secrets baked into tool
  //                      config files
  //   - `.monoceros/`  — git-credentials captured from the host
  //                      credential helper, machine-local gitconfig
  //   - `data/`        — DB data the compose services write at
  //                      runtime (postgres/mysql/redis), often big,
  //                      always container-specific
  // Inside `projects/<repo>/` builders have their own `.git` and
  // any wrapping git operation should be at that level, not at the
  // container root — but a stray `git init` at the root is exactly
  // the accident this .gitignore protects against.
  const containerGitignore = path.join(targetDir, '.gitignore');
  await fs.writeFile(containerGitignore, '/home/\n/.monoceros/\n/data/\n');

  // `.gitkeep` so `projects/` survives a fresh git clone before any
  // sub-project has been added.
  const gitkeep = path.join(projectsDir, '.gitkeep');
  if (!existsSync(gitkeep)) {
    await fs.writeFile(gitkeep, '');
  }

  // `.monoceros/.gitignore` keeps per-builder runtime state out of any
  // wrapping git repo. Always overwrite — content is fixed.
  await fs.writeFile(
    path.join(monocerosDir, '.gitignore'),
    'git-credentials*\ngitconfig\n',
  );

  const devcontainerJson = buildDevcontainerJson(opts, dockerMode);
  await fs.writeFile(
    path.join(devcontainerDir, 'devcontainer.json'),
    JSON.stringify(devcontainerJson, null, 2) + '\n',
  );

  // Copy any Monoceros-owned features that the workbench has on disk
  // into `<devcontainerDir>/features/<name>/`. The devcontainer.json
  // references them via the relative path `./features/<name>` — the
  // devcontainer-cli accepts relative paths from the `.devcontainer/`
  // directory but rejects absolute filesystem paths to local features.
  //
  // We always rebuild the whole `features/` directory: drop the old
  // copy and recreate from current sources, so a feature that was
  // removed from the yml doesn't linger as stale on-disk content that
  // devcontainer-cli would still see.
  const featuresDir = path.join(devcontainerDir, 'features');
  if (existsSync(featuresDir)) {
    await fs.rm(featuresDir, { recursive: true, force: true });
  }
  const resolvedFeatures = resolveFeatures(opts);
  for (const f of resolvedFeatures) {
    if (!f.localSourceDir || !f.localName) continue;
    const dest = path.join(featuresDir, f.localName);
    await fs.mkdir(dest, { recursive: true });
    await fs.cp(f.localSourceDir, dest, { recursive: true });
  }

  // Pre-create persistent home entries so docker doesn't auto-mkdir
  // them as root at container start. We only ensure existence; any
  // existing content survives, which is the whole point — apply
  // never touches `home/<sub>` once it's there. Directories get
  // mkdir; files get an empty touch (only when missing — already-
  // populated files like a complete .claude.json must not be
  // truncated on re-apply).
  for (const f of resolvedFeatures) {
    for (const sub of f.persistentHomePaths) {
      await fs.mkdir(path.join(homeDir, sub), { recursive: true });
    }
    for (const entry of f.persistentHomeFiles) {
      const filePath = path.join(homeDir, entry.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      if (!existsSync(filePath)) {
        // Seed with the feature-author's initial content (defaults
        // to empty). For JSON configs this should be at least `{}`
        // so the tool doesn't choke on an unparseable empty file.
        await fs.writeFile(filePath, entry.initialContent);
      }
    }
  }

  await writePostCreateScript(devcontainerDir, opts);

  const composePath = path.join(devcontainerDir, 'compose.yaml');
  if (needsCompose(opts)) {
    await fs.writeFile(composePath, buildComposeYaml(opts, dockerMode));
  } else if (existsSync(composePath)) {
    // Services dropped from the yml — clean up the now-stale file so a
    // later `monoceros start` doesn't pick it up.
    await fs.rm(composePath);
  }

  await fs.writeFile(
    path.join(targetDir, `${opts.name}.code-workspace`),
    JSON.stringify(buildCodeWorkspaceJson(opts), null, 2) + '\n',
  );
}
