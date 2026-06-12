import { existsSync, readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { bundledFeaturesDir, workbenchCheckoutRoot } from '../config/paths.js';
import { matchMonocerosFeature } from '../util/ref.js';
import { writeClaudePermissionMode } from './claude-settings.js';
import {
  BUILTIN_LANGUAGES,
  LANGUAGE_CATALOG,
  SERVICE_CATALOG,
  knownLanguages,
  parseLanguageSpec,
  resolveRuntimeImage,
  runtimeSupportsIdeVolumes,
  serviceConnectionEnv,
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
  // Services arrive here already resolved (curated strings expanded
  // against the catalog, objects taken as-is — see resolveService).
  // What's left to enforce are the cross-service invariants the schema
  // can't see: each name is unique and none collides with the reserved
  // `workspace` compose service.
  const seenServiceNames = new Set<string>();
  for (const svc of opts.services) {
    if (!svc.image) {
      throw new Error(
        `Service ${JSON.stringify(svc.name)} has no image. Every service needs an 'image:'.`,
      );
    }
    if (svc.name === 'workspace') {
      throw new Error(
        `Invalid service name 'workspace': it collides with the reserved devcontainer workspace service. Pick another name.`,
      );
    }
    if (seenServiceNames.has(svc.name)) {
      throw new Error(
        `Duplicate service name: ${JSON.stringify(svc.name)}. Each services[] entry must have a unique name.`,
      );
    }
    seenServiceNames.add(svc.name);
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
  // Dedupe services by name (last write wins) and sort by name so the
  // generated compose/devcontainer output is deterministic regardless
  // of yml order. An external `--postgres-url` drops a curated postgres
  // service — the workspace talks to the external DB instead.
  const serviceByName = new Map<string, (typeof opts.services)[number]>();
  for (const svc of opts.services) {
    if (opts.postgresUrl && svc.name === 'postgres') continue;
    serviceByName.set(svc.name, svc);
  }
  const services = [...serviceByName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
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
  // Ports: preserve insertion order — the first entry doubles as the
  // default route under `<name>.localhost`, so reordering would
  // silently change which app the bare hostname points at. Dedupe to
  // keep the dynamic config and `forwardPorts` deterministic.
  const ports = opts.ports ? [...new Set(opts.ports)] : undefined;
  return {
    name: opts.name,
    ...(opts.runtimeVersion !== undefined
      ? { runtimeVersion: opts.runtimeVersion }
      : {}),
    languages,
    services,
    postgresUrl: opts.postgresUrl,
    ...(aptPackages.length > 0 ? { aptPackages } : {}),
    ...(features && Object.keys(features).length > 0 ? { features } : {}),
    ...(installUrls && installUrls.length > 0 ? { installUrls } : {}),
    ...(repos && repos.length > 0 ? { repos } : {}),
    ...(ports && ports.length > 0 ? { ports } : {}),
    ...(opts.vscodeAutoForward !== undefined
      ? { vscodeAutoForward: opts.vscodeAutoForward }
      : {}),
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
  // Bind mount that puts the host's container folder onto a known
  // path inside the container. Pairs with `workspaceFolder` below.
  // Always emitted; the host-side source uses devcontainer-cli's
  // `${localWorkspaceFolder}` variable so the tooling expands it.
  workspaceMount?: string;
  // Where the workspace lives inside the container. VS Code's Dev
  // Containers extension uses this to translate host-side paths
  // (from .code-workspace files, "Open Folder in Container", …) to
  // their container counterpart. Without it, VS Code passes the raw
  // host path through and aborts because that path doesn't exist
  // inside the container.
  workspaceFolder?: string;
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
  // (toggled by `ide.vscodeAutoForward` from the yml). Future
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
 * Root directory holding per-feature source dirs
 * (`<root>/<name>/devcontainer-feature.json`), or null when none is
 * available. When a root is returned and it contains the feature, the
 * CLI builds that feature from local source (copied into
 * `.devcontainer/features/<name>`, referenced as `./features/<name>`)
 * instead of pulling its published GHCR artifact.
 *
 * `MONOCEROS_FEATURES_DIR_OVERRIDE` wins when set — the feature-side
 * analogue of `MONOCEROS_BASE_IMAGE_OVERRIDE` for the runtime image. It
 * lets the prod-installed CLI build features from a checkout's
 * `images/features/`, which is how e2e exercises the BRANCH feature
 * source rather than the last-published one. With no override we use
 * the workbench checkout (dev); failing that, null — a plain prod
 * install then pulls from GHCR. Empty/whitespace-only values are
 * ignored so an accidentally-blank var doesn't suppress the fallback.
 */
function featuresSourceRoot(): string | null {
  const override = process.env.MONOCEROS_FEATURES_DIR_OVERRIDE?.trim();
  if (override && override.length > 0) return override;
  const checkout = workbenchCheckoutRoot();
  return checkout ? path.join(checkout, 'images', 'features') : null;
}

/**
 * Compute the feature list for `opts`. Detects Monoceros-owned refs
 * (`ghcr.io/getmonoceros/monoceros-features/<name>:<tag>`) and, if
 * a local feature source is available (workbench checkout or
 * `MONOCEROS_FEATURES_DIR_OVERRIDE`), rewrites the key to
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
    // Catalog defaults first, then the spec's version layers on top
    // (an explicit `version` always wins over any default).
    const options: Record<string, unknown> = {
      ...(entry.defaultOptions ?? {}),
    };
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
        // Build from local feature source when one is available: the
        // workbench checkout under `images/features/` (dev), or the
        // `MONOCEROS_FEATURES_DIR_OVERRIDE` env (see featuresSourceRoot).
        // That makes feature edits testable without a publish — it's how
        // e2e exercises the BRANCH feature source instead of the last
        // published GHCR artifact. With no source root (plain prod
        // install) we fall through to the GHCR-ref passthrough.
        const sourceRoot = featuresSourceRoot();
        const localSourceDir = sourceRoot ? path.join(sourceRoot, name) : null;
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
        // Prod path: the feature is pulled from GHCR (passthrough ref),
        // but its persistent-home entries still ship in the CLI bundle
        // under `features/<name>/` (synced from `images/features/` at
        // publish). Read them from there so the per-feature home binds
        // (e.g. `.claude`, `.claude.json`) are emitted — without this,
        // tool auth/config is not persisted and is lost on every
        // `apply` rebuild.
        const { paths, files } = readBundledPersistentHomeEntries(name);
        resolved.push({
          devcontainerKey: rawRef,
          options,
          persistentHomePaths: paths,
          persistentHomeFiles: files,
        });
        continue;
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

/**
 * Prod-path counterpart to `readPersistentHomeEntries`: read a feature's
 * persistent-home entries from the manifest shipped inside the CLI
 * bundle (`features/<name>/`, synced from `images/features/` at
 * publish). Used when the feature is referenced by GHCR ref (no local
 * checkout source) so the per-feature home binds are still emitted.
 * Best-effort: returns empty arrays if the bundle root can't be located
 * or the manifest is missing, never throws.
 */
function readBundledPersistentHomeEntries(name: string): {
  paths: string[];
  files: PersistentHomeFile[];
} {
  try {
    return readPersistentHomeEntries(path.join(bundledFeaturesDir(), name));
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

interface IdeStateVolume {
  /** Docker volume name — unique per container so two containers don't share IDE state. */
  volume: string;
  /** In-container mount target under `~/.vscode-server`. */
  target: string;
}

/**
 * Named volumes that persist VS Code's IDE state across a `monoceros
 * apply` rebuild: installed extensions and the user-scoped settings /
 * extension storage. This is the mechanism VS Code documents for
 * "avoid extension reinstalls" — a named **volume** on the relevant
 * `~/.vscode-server` sub-directories.
 *
 * Why volumes on sub-dirs (not a host bind of the whole dir): VS Code
 * owns `~/.vscode-server` (server binaries under `bin/`, etc.). Taking
 * the whole directory over with a host bind fights that ownership and
 * triggers an endless "configuration changed — rebuild?" loop. Mounting
 * only `extensions/` and `data/User/` leaves the server location under
 * VS Code's control. Named volumes survive container removal (`apply`
 * preserves volumes), so the persisted state outlives a rebuild; the
 * runtime image pre-creates these paths owned by `node` so the fresh
 * volumes initialise node-owned (required for the non-root user per VS
 * Code's docs). `monoceros remove` deletes the volumes. See ADR 0015.
 */
export function ideStateVolumes(name: string): IdeStateVolume[] {
  return [
    {
      volume: `monoceros-${name}-vscode-extensions`,
      target: '/home/node/.vscode-server/extensions',
    },
    {
      volume: `monoceros-${name}-vscode-userdata`,
      target: '/home/node/.vscode-server/data/User',
    },
  ];
}

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
  // Builders can flip it via `ide.vscodeAutoForward: true` in the
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
                'remote.autoForwardPorts': opts.vscodeAutoForward ?? false,
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
      ...(opts.services.length > 0
        ? { runServices: opts.services.map((s) => s.name) }
        : {}),
      workspaceFolder: `/workspaces/${opts.name}`,
      remoteUser: 'node',
      forwardPorts: ports,
      postCreateCommand: '.devcontainer/post-create.sh',
      ...(featuresField ?? {}),
      ...(customizationsField ?? {}),
    };
  }

  // Image-mode mounts: per-feature persistent-home binds, plus the VS
  // Code IDE-state volumes (extensions + user settings) — but only when
  // the pinned runtime supports them (ADR 0015/0017); otherwise they'd
  // break on an image without the node-owned dirs.
  const ideMounts = runtimeSupportsIdeVolumes(opts.runtimeVersion)
    ? ideStateVolumes(opts.name).map(
        (v) => `source=${v.volume},target=${v.target},type=volume`,
      )
    : [];
  const mounts: string[] = [...homeMounts, ...ideMounts];
  const mountsField = mounts.length > 0 ? { mounts } : {};

  // Image-mode workspaces: pin both `workspaceMount` AND
  // `workspaceFolder` explicitly so VS Code's Dev Containers
  // extension knows how the host folder maps into the container.
  //
  // Without these two, "Open Folder in Container" / "Open Workspace
  // in Container" on a `.code-workspace` falls back to passing the
  // raw host path (e.g. `/Users/.../.local/container/sandbox`) as
  // the container-side workspace path. The container of course has
  // no such directory and VS Code aborts with "Arbeitsbereich nicht
  // vorhanden" / "Workspace does not exist". Setting workspaceFolder
  // tells VS Code where the workspace lives inside the container
  // (matches what we already do for compose-mode); workspaceMount
  // pins the bind that puts the host folder there.
  //
  // Source path uses `${localWorkspaceFolder}` — devcontainer-cli
  // expands it to the host folder containing the .devcontainer/, no
  // hand-substitution needed on our side.
  const workspaceMountField = {
    workspaceMount: `source=\${localWorkspaceFolder},target=/workspaces/${opts.name},type=bind,consistency=cached`,
    workspaceFolder: `/workspaces/${opts.name}`,
  };

  // Image-mode: when ports are declared, hook the container into the
  // `monoceros-proxy` network so the Traefik singleton can reach it
  // by yml name (`http://<name>:<port>`). `--network` replaces
  // docker's default bridge — for image-mode that's the only network
  // in play, so swapping is fine. ensureProxy() (called from
  // apply/start) creates the network before this `runArgs` value is
  // used.
  //
  // `--network-alias` pins a stable DNS name on the network: by
  // default devcontainer-cli labels image-mode containers with random
  // names like `thirsty_bartik`, which would make Traefik's backend
  // URL non-deterministic. With the alias we know the route in the
  // dynamic config can always point at `http://<name>:<port>`.
  const runArgs = ['--cap-add=NET_ADMIN'];
  if (ports.length > 0) {
    runArgs.push('--network=monoceros-proxy');
    runArgs.push(`--network-alias=${opts.name}`);
  }

  return {
    name: opts.name,
    image: resolveRuntimeImage(opts.runtimeVersion),
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

// Double-quote a YAML scalar, escaping the chars that matter inside a
// double-quoted YAML string. Always quoting keeps arbitrary service env
// values (passwords with `:` / `#` / spaces, interpolated secrets, shell
// commands) safe without pulling in a YAML serializer.
export function composeScalar(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

// Rewrite a service volume's source segment to a path relative to the
// `.devcontainer/` directory (where compose runs). The `data` shorthand
// maps to the per-service bind-mounted data dir under `../data/<name>`;
// any other (relative, validated) host path is prefixed with `../` to
// reach up to the container root. The destination + mode segments pass
// through verbatim.
export function composeVolumeSource(spec: string, serviceName: string): string {
  const parts = spec.split(':');
  const src = parts[0]!;
  const rest = parts.slice(1).join(':');
  if (src === 'data') return `../data/${serviceName}:${rest}`;
  // Host-relative source: strip a leading `./` (compose habit) so the
  // `../` prefix that walks up to the container root stays clean.
  const relative = src.startsWith('./') ? src.slice(2) : src;
  return `../${relative}:${rest}`;
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

  const ideVolumes = runtimeSupportsIdeVolumes(opts.runtimeVersion)
    ? ideStateVolumes(opts.name)
    : [];

  lines.push('  workspace:');
  lines.push(`    image: ${resolveRuntimeImage(opts.runtimeVersion)}`);
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
    // monoceros-proxy network (so Traefik can route to it). Use the
    // long form so we can pin a stable DNS alias on monoceros-proxy:
    // without the alias every compose-mode container would show up
    // as `workspace` (compose service name) and collide between
    // multiple monoceros containers. The alias is the yml name; the
    // dynamic config writes routes against `http://<name>:<port>`.
    // See ADR 0007.
    lines.push('    networks:');
    lines.push('      default: {}');
    lines.push('      monoceros-proxy:');
    lines.push('        aliases:');
    lines.push(`          - ${opts.name}`);
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
  // VS Code IDE-state persistence (extensions + user settings) via named
  // volumes — see ideStateVolumes / ADR 0015. Gated on the pinned
  // runtime version; declared at the top-level `volumes:` block below.
  for (const v of ideVolumes) {
    lines.push(`      - ${v.volume}:${v.target}`);
  }
  // Connection env for curated services (DATABASE_URL / REDIS_URL / PG* …)
  // so the app and the in-container agent can connect without knowing the
  // dev-default credentials. Derived from the already-resolved service env.
  const wsEnv = serviceConnectionEnv(opts.services);
  const wsEnvKeys = Object.keys(wsEnv);
  if (wsEnvKeys.length > 0) {
    lines.push('    environment:');
    for (const k of wsEnvKeys) {
      lines.push(`      ${k}: ${composeScalar(wsEnv[k]!)}`);
    }
  }
  for (const svc of opts.services) {
    // `${VAR}` env values were already resolved against <name>.env in
    // apply, so everything here is a literal. Per-service data dirs are
    // bind-mounted from the host (`data:` volume shorthand → ../data/<name>)
    // so DB content is visible at `<container-dir>/data/<name>/` and is
    // part of remove-backups. See ADR 0003. Pre-created in writeScaffold
    // so docker doesn't auto-mkdir them as root.
    lines.push(`  ${svc.name}:`);
    lines.push(`    image: ${svc.image}`);
    if (svc.restart) {
      lines.push(`    restart: ${svc.restart}`);
    }
    if (svc.command !== undefined) {
      lines.push(`    command: ${composeScalar(svc.command)}`);
    }
    const envKeys = Object.keys(svc.env);
    if (envKeys.length > 0) {
      lines.push('    environment:');
      for (const k of envKeys) {
        lines.push(`      ${k}: ${composeScalar(svc.env[k]!)}`);
      }
    }
    if (svc.volumes.length > 0) {
      lines.push('    volumes:');
      for (const vol of svc.volumes) {
        lines.push(`      - ${composeVolumeSource(vol, svc.name)}`);
      }
    }
    if (svc.healthcheck) {
      const hc = svc.healthcheck;
      lines.push('    healthcheck:');
      if (Array.isArray(hc.test)) {
        // Compose exec-form: a flow sequence of quoted args.
        lines.push(`      test: [${hc.test.map(composeScalar).join(', ')}]`);
      } else {
        lines.push(`      test: ${composeScalar(hc.test)}`);
      }
      if (hc.interval) lines.push(`      interval: ${hc.interval}`);
      if (hc.timeout) lines.push(`      timeout: ${hc.timeout}`);
      if (hc.retries !== undefined) lines.push(`      retries: ${hc.retries}`);
      if (hc.startPeriod) {
        lines.push(`      start_period: ${hc.startPeriod}`);
      }
    }
  }

  // Top-level declaration of the IDE-state named volumes. `name:` pins
  // the exact Docker volume name (no compose project prefix) so the
  // names match image-mode and `monoceros remove` can delete them
  // deterministically. Only emitted when the pinned runtime supports
  // them (else there are no IDE volumes to declare).
  if (ideVolumes.length > 0) {
    lines.push('volumes:');
    for (const v of ideVolumes) {
      lines.push(`  ${v.volume}:`);
      lines.push(`    name: ${v.volume}`);
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
  extensions?: { recommendations: string[] };
}

// Generic, container-independent label for the workspace-root folder.
// Without a `name`, VS Code falls back to the container directory's
// basename — which collides visually with a repo root of the same name
// (a repo cloned into projects/<container-name> then shows two
// identical Explorer entries). A fixed, branded label disambiguates the
// root and reads as intentional. See ADR 0016. (Monoceros is the
// unicorn constellation.)
const WORKSPACE_ROOT_LABEL = '🦄 Monoceros';

// Host → VS Code extensions to *recommend* when a repo from that host
// is present. Context-derived (inferred from the repo URL), so these
// are soft recommendations, not auto-installs. bitbucket.org is
// deliberately absent — its `Atlassian.atlascode` extension is
// auto-installed by the atlassian feature when that feature is in the
// yml, so recommending it here would be redundant. See ADR 0016.
const REPO_HOST_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'github.com': [
    'github.vscode-pull-request-github',
    'GitHub.vscode-github-actions',
  ],
  'gitlab.com': ['GitLab.gitlab-workflow'],
};

/**
 * Extract the bare host from a git repo URL. Handles the three forms
 * the repo model accepts: `https://host/…`, `scp`-style
 * `git@host:path`, and `ssh://git@host[:port]/…`. Returns the
 * lowercased host (no port, no userinfo), or null when none can be
 * parsed — recommendation lookup just skips a null.
 */
export function extractRepoHost(url: string): string | null {
  // scheme://[user@]host[:port]/path
  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)/i.exec(url);
  if (schemeMatch) return schemeMatch[1]!.toLowerCase();
  // scp-style: [user@]host:path
  const scpMatch = /^(?:[^@/]+@)?([^/:]+):/.exec(url);
  if (scpMatch) return scpMatch[1]!.toLowerCase();
  return null;
}

/**
 * Compute the deduped, sorted set of context-derived extension
 * recommendations for `opts`: one entry per curated service that
 * declares `vscodeExtensions` (e.g. a DB client when postgres/mysql/
 * redis is present), plus the host-specific extensions for each repo.
 * Feature-bound extensions are NOT included — features auto-install
 * their own via the manifest. See ADR 0016.
 */
export function computeExtensionRecommendations(opts: CreateOptions): string[] {
  const recs = new Set<string>();
  for (const svc of opts.services) {
    const catalogEntry = SERVICE_CATALOG[svc.name];
    for (const ext of catalogEntry?.vscodeExtensions ?? []) {
      recs.add(ext);
    }
  }
  for (const repo of opts.repos ?? []) {
    const host = extractRepoHost(repo.url);
    if (!host) continue;
    for (const ext of REPO_HOST_EXTENSIONS[host] ?? []) {
      recs.add(ext);
    }
  }
  return [...recs].sort((a, b) => a.localeCompare(b));
}

/**
 * The `<name>.code-workspace` file VS Code uses to open the solution as
 * a multi-root workspace. The first entry is `.` (labelled with a
 * generic root name) so the workspace root stays available in the
 * Explorer. Each repo added via `monoceros add-repo` appears as a
 * sibling root pointing at `projects/<name>/`. Context-derived
 * extension recommendations (DB client, repo-host tooling) ride along
 * under `extensions.recommendations`.
 */
export function buildCodeWorkspaceJson(opts: CreateOptions): CodeWorkspaceFile {
  const folders: CodeWorkspaceFolder[] = [
    { path: '.', name: WORKSPACE_ROOT_LABEL },
  ];
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
  const recommendations = computeExtensionRecommendations(opts);
  return {
    folders,
    ...(recommendations.length > 0 ? { extensions: { recommendations } } : {}),
  };
}

/**
 * Merge a generator-produced workspace into whatever the builder may
 * have hand-edited into the on-disk file. The `.code-workspace` is
 * conceptually a builder artifact — VS Code lets people add local
 * folders to it, drop in `settings:` / `extensions:` blocks, reorder
 * roots, etc. A blind overwrite on every `apply` would silently nuke
 * all of that.
 *
 * Merge rules (favour-builder):
 *
 *   - Every folder the builder has in their `folders[]` stays, in
 *     the same order. We don't touch labels or paths the user
 *     already wrote — with one exception: the workspace-root (`.`)
 *     label is generator-owned and is filled in when the existing `.`
 *     entry has no `name` (so a container made before the label
 *     existed picks it up on re-apply). A deliberate rename of `.` is
 *     still preserved.
 *   - Any folder from the generator that ISN'T present in the
 *     builder's `folders[]` (matched by `path`) is appended at the
 *     end. That covers the typical case "I just added a new repo via
 *     `monoceros add-repo` and want it to show up automatically".
 *   - Folders that exist in the builder file but no longer come from
 *     the generator (e.g. yml repo removed) are NOT dropped — the
 *     builder may have kept the folder around on purpose. Cleanup
 *     is a manual edit.
 *   - `extensions.recommendations` is unioned: the builder's entries
 *     stay (in order), generator-derived ones not already present are
 *     appended, and nothing is auto-removed. Sibling keys like
 *     `unwantedRecommendations` (the builder's escape hatch to suppress
 *     a recommendation) carry through verbatim.
 *   - Top-level fields other than `folders` / `extensions` (e.g.
 *     `settings`, `launch`, `tasks`, `remoteAuthority`) carry through
 *     verbatim.
 *   - If `existing` is null / undefined / unparseable / missing
 *     `folders`, the generator output is taken as-is.
 *
 * Pure function — no I/O. `writeScaffold` is the one site that
 * reads + writes; this just transforms.
 */
export function mergeCodeWorkspace(
  existing: unknown,
  generated: CodeWorkspaceFile,
): Record<string, unknown> {
  // Bail out to the generator when the existing file isn't a sane
  // workspace document. We could try to repair partial shapes but
  // the simpler invariant is: a hand-edit that breaks JSON or drops
  // `folders` is the builder's problem to fix.
  if (
    !existing ||
    typeof existing !== 'object' ||
    Array.isArray(existing) ||
    !Array.isArray((existing as { folders?: unknown }).folders)
  ) {
    return { ...generated };
  }
  const existingObj = existing as Record<string, unknown>;
  const existingFolders = existingObj.folders as CodeWorkspaceFolder[];
  const existingPaths = new Set(
    existingFolders
      .map((f) => (f && typeof f === 'object' ? f.path : undefined))
      .filter((p): p is string => typeof p === 'string'),
  );

  // Preserve builder-side folders verbatim; append generator-only ones.
  const merged: CodeWorkspaceFolder[] = [...existingFolders];
  for (const g of generated.folders) {
    if (!existingPaths.has(g.path)) merged.push(g);
  }

  // The workspace-root (`.`) label is generator-owned. The append loop
  // above never touches an existing `.` entry (its path is already
  // present), so a container materialized before the label existed —
  // or any pre-existing file with a bare `{ path: "." }` — would never
  // pick up the generic name on re-apply. Fill it in here. A *deliberate*
  // builder rename of `.` is preserved: we only set the name when the
  // existing entry has none.
  const generatedRootName = generated.folders.find((f) => f.path === '.')?.name;
  if (generatedRootName) {
    const idx = merged.findIndex(
      (f) => f && typeof f === 'object' && f.path === '.',
    );
    if (idx >= 0 && !merged[idx]!.name) {
      merged[idx] = { ...merged[idx]!, name: generatedRootName };
    }
  }

  // Top-level pass-through: keep all builder-set keys, overwrite
  // only `folders`. Order: builder's keys first (to keep their
  // structure recognizable on round-trip), then folders.
  const out: Record<string, unknown> = { ...existingObj };
  out.folders = merged;

  // Union `extensions.recommendations`: builder entries first (verbatim
  // order), generator-only ones appended, deduped. Any other extension
  // keys the builder set (notably `unwantedRecommendations`) survive via
  // the `...existingExt` spread. When the generator has no
  // recommendations, the builder's `extensions` (if any) already passed
  // through untouched in the spread above.
  const generatedRecs = generated.extensions?.recommendations ?? [];
  if (generatedRecs.length > 0) {
    const existingExtRaw = existingObj.extensions;
    const existingExt =
      existingExtRaw &&
      typeof existingExtRaw === 'object' &&
      !Array.isArray(existingExtRaw)
        ? (existingExtRaw as Record<string, unknown>)
        : {};
    const existingRecs = Array.isArray(existingExt.recommendations)
      ? (existingExt.recommendations as unknown[]).filter(
          (r): r is string => typeof r === 'string',
        )
      : [];
    const existingRecSet = new Set(existingRecs);
    const mergedRecs = [...existingRecs];
    for (const r of generatedRecs) {
      if (!existingRecSet.has(r)) mergedRecs.push(r);
    }
    out.extensions = { ...existingExt, recommendations: mergedRecs };
  }

  return out;
}

// Explorer denoise for the workspace-root (`.`) folder. The root holds
// the whole materialized scaffold; the builder only cares about a few
// entries. These globs hide the rest, leaving `home/`, `logs/`,
// `AGENTS.md`, and `CLAUDE.md` visible. `.vscode` hides itself (the
// exclude only affects the Explorer view, not whether VS Code reads the
// settings). This MUST live in a folder-scoped
// `<root>/.vscode/settings.json` — a workspace-wide `files.exclude` in
// the `.code-workspace` would also hide these names inside the project
// repo roots (a repo's own `.gitignore` / `data/`). See ADR 0016.
const ROOT_DENOISE_EXCLUDES: Readonly<Record<string, boolean>> = {
  '.devcontainer': true,
  '.monoceros': true,
  '.vscode': true,
  '.gitignore': true,
  data: true,
  projects: true,
  '*.code-workspace': true,
};

/**
 * Merge the Monoceros root-denoise `files.exclude` into whatever the
 * builder may have written into `<root>/.vscode/settings.json`. Pure
 * function — `writeScaffold` does the I/O.
 *
 * Favour-builder, like `mergeCodeWorkspace`: every builder-set top-level
 * setting is preserved; only `files.exclude` is touched, and even there
 * the builder's own entries are unioned in (Monoceros keys win on a
 * literal collision, but a builder adding their own hide survives). A
 * null / non-object / unparseable `existing` yields just our excludes.
 */
export function mergeVscodeSettings(
  existing: unknown,
): Record<string, unknown> {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const existingExclude =
    base['files.exclude'] &&
    typeof base['files.exclude'] === 'object' &&
    !Array.isArray(base['files.exclude'])
      ? (base['files.exclude'] as Record<string, unknown>)
      : {};
  return {
    ...base,
    'files.exclude': { ...existingExclude, ...ROOT_DENOISE_EXCLUDES },
  };
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
 * Write `content` to `filePath` only when it differs from what's already
 * on disk; returns whether it actually wrote.
 *
 * Matters for the devcontainer config files (`devcontainer.json`,
 * `compose.yaml`): VS Code's Dev Containers extension watches them and
 * raises a "configuration changed — Rebuild?" prompt on every file
 * change. An unconditional `writeFile` on each `apply` updates their
 * mtime even when the generated content is byte-identical, so a repeat
 * `apply` (or one that changed something unrelated) would keep
 * triggering that prompt. Skipping the no-op write makes `apply`
 * idempotent at the filesystem level and keeps VS Code quiet.
 */
export async function writeIfChanged(
  filePath: string,
  content: string,
): Promise<boolean> {
  try {
    if ((await fs.readFile(filePath, 'utf8')) === content) return false;
  } catch {
    // Missing or unreadable — fall through and write it.
  }
  await fs.writeFile(filePath, content);
  return true;
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
 *   - `.vscode/settings.json` (root-folder Explorer denoise)
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
    // Pre-create one subdir per service that uses the `data:` volume
    // shorthand, so docker bind-mounts onto an existing host path (and
    // doesn't auto-mkdir as root, which breaks postgres/mysql first-run
    // on Linux).
    for (const svc of opts.services) {
      const hasDataVolume = svc.volumes.some((v) => v.split(':')[0] === 'data');
      if (hasDataVolume) {
        await fs.mkdir(path.join(dataDir, svc.name), { recursive: true });
      }
    }
  }

  // Container-root `.gitignore`. Excludes the directories that hold
  // builder-private or container-runtime state and the Monoceros-
  // generated AI-tool briefing files:
  //   - `home/`        — logins, sessions, secrets baked into tool
  //                      config files
  //   - `.monoceros/`  — git-credentials captured from the host
  //                      credential helper, machine-local gitconfig,
  //                      generated commands.md briefing reference
  //   - `data/`        — DB data the compose services write at
  //                      runtime (postgres/mysql/redis), often big,
  //                      always container-specific
  //   - `AGENTS.md`    — generated AI-tool briefing (see ADR 0014);
  //                      Monoceros owns it, rewritten on every apply
  //   - `CLAUDE.md`    — import stub pointing at AGENTS.md
  // Inside `projects/<repo>/` builders have their own `.git` and
  // any wrapping git operation should be at that level, not at the
  // container root — but a stray `git init` at the root is exactly
  // the accident this .gitignore protects against.
  const containerGitignore = path.join(targetDir, '.gitignore');
  await fs.writeFile(
    containerGitignore,
    '/home/\n/.monoceros/\n/data/\n/AGENTS.md\n/CLAUDE.md\n',
  );

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
  await writeIfChanged(
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

  // Claude Code's default permission mode, derived from the claude-code
  // feature's `permissionMode` yml option (default `bypass`). Written here
  // at apply (merged into home/.claude/settings.json) rather than baked into
  // the feature layer, so a yml change takes effect on the next apply and is
  // not frozen by the image cache. No-op without the claude-code feature.
  await writeClaudePermissionMode(targetDir, opts.features);

  await writePostCreateScript(devcontainerDir, opts);

  const composePath = path.join(devcontainerDir, 'compose.yaml');
  if (needsCompose(opts)) {
    await writeIfChanged(composePath, buildComposeYaml(opts, dockerMode));
  } else if (existsSync(composePath)) {
    // Services dropped from the yml — clean up the now-stale file so a
    // later `monoceros start` doesn't pick it up.
    await fs.rm(composePath);
  }

  // `.code-workspace` is a builder artifact, not a pure generator
  // output — VS Code lets people drop local folders, settings,
  // extensions etc. into it. Read what's there, merge with what the
  // generator produces, write back. See mergeCodeWorkspace for the
  // exact rules.
  const workspacePath = path.join(targetDir, `${opts.name}.code-workspace`);
  let existingWorkspace: unknown;
  try {
    const raw = await fs.readFile(workspacePath, 'utf8');
    existingWorkspace = JSON.parse(raw);
  } catch {
    // ENOENT (first apply) or parse error — fall through to the
    // generator output. mergeCodeWorkspace handles both via the
    // null-existing branch.
    existingWorkspace = undefined;
  }
  const generated = buildCodeWorkspaceJson(opts);
  const merged = mergeCodeWorkspace(existingWorkspace, generated);
  await fs.writeFile(workspacePath, JSON.stringify(merged, null, 2) + '\n');

  // Folder-scoped settings for the workspace-root (`.`) folder: the
  // `files.exclude` denoise that hides the scaffold and leaves only
  // `home/`, `logs/`, `AGENTS.md`, `CLAUDE.md` visible. Folder-scoped
  // (not in the `.code-workspace`) so it doesn't bleed into the project
  // repo roots — see ADR 0016. Merge so a builder's own settings here
  // survive a re-apply.
  const vscodeDir = path.join(targetDir, '.vscode');
  const settingsPath = path.join(vscodeDir, 'settings.json');
  let existingSettings: unknown;
  try {
    existingSettings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  } catch {
    existingSettings = undefined;
  }
  await fs.mkdir(vscodeDir, { recursive: true });
  await fs.writeFile(
    settingsPath,
    JSON.stringify(mergeVscodeSettings(existingSettings), null, 2) + '\n',
  );
}
