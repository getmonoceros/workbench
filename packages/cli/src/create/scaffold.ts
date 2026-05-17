import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { workbenchRoot } from '../config/paths.js';
import {
  BASE_IMAGE,
  BUILTIN_LANGUAGES,
  LANGUAGE_CATALOG,
  SERVICE_CATALOG,
  knownLanguages,
  knownServices,
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
//      ghcr.io/monoceros/features/claude-code:1
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

// Repo name = folder name under `projects/`. Must be a safe folder
// name (same shape as solution names — no slashes, no spaces, no
// shell metacharacters).
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

// Git branch names: allow common characters including `/`
// (e.g. `feature/foo`). Reject anything that could be a shell escape.
const REPO_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

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
  for (const lang of opts.languages) {
    if (!BUILTIN_LANGUAGES.has(lang) && !LANGUAGE_CATALOG[lang]) {
      throw new Error(
        `Unknown language: ${lang}. Known: ${knownLanguages().join(', ')}.`,
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
  const seenRepoNames = new Set<string>();
  for (const repo of opts.repos ?? []) {
    if (!REPO_URL_RE.test(repo.url)) {
      throw new Error(
        `Invalid repo URL: ${JSON.stringify(repo.url)}. Use HTTPS or SSH/git@ form; no shell metacharacters.`,
      );
    }
    if (!REPO_NAME_RE.test(repo.name)) {
      throw new Error(
        `Invalid repo name: ${JSON.stringify(repo.name)}. Folder name must match ${REPO_NAME_RE}.`,
      );
    }
    if (repo.branch !== undefined && !REPO_BRANCH_RE.test(repo.branch)) {
      throw new Error(
        `Invalid branch name: ${JSON.stringify(repo.branch)}. Must match ${REPO_BRANCH_RE}.`,
      );
    }
    if (seenRepoNames.has(repo.name)) {
      throw new Error(
        `Duplicate repo name: ${JSON.stringify(repo.name)}. Each projects/<name> folder must be unique — pass --name to disambiguate.`,
      );
    }
    seenRepoNames.add(repo.name);
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
        new Map(
          opts.repos.map((r) => [`${r.url}${r.name}${r.branch ?? ''}`, r]),
        ).values(),
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
}

// Repos-related Git-auth wiring: forward the host SSH-agent socket into
// the container and tell git to auto-accept new host keys (avoids the
// interactive "Are you sure?" prompt that would hang post-create.sh on
// first connect). Builder is expected to have a running ssh-agent
// host-side with the right key loaded — that's the only host-OS-
// specific bit; the mount itself is the same on macOS, Linux, WSL.
const SSH_AGENT_TARGET = '/ssh-agent';
const GIT_SSH_COMMAND = 'ssh -o StrictHostKeyChecking=accept-new';

function buildRepoAuthMounts(): string[] {
  return [
    `source=\${localEnv:SSH_AUTH_SOCK},target=${SSH_AGENT_TARGET},type=bind`,
  ];
}

function buildRepoAuthEnv(): Record<string, string> {
  return {
    SSH_AUTH_SOCK: SSH_AGENT_TARGET,
    GIT_SSH_COMMAND,
  };
}

export type DevcontainerJson = DevcontainerImageMode | DevcontainerComposeMode;

/**
 * Resolve a yml feature ref to whatever string `devcontainer-cli`
 * expects in `devcontainer.json` → `features`.
 *
 * The yml always carries the canonical OCI ref, e.g.
 * `ghcr.io/monoceros/features/claude-code:1`. Same ref in dev and in
 * production — the yml never changes between environments.
 *
 * Dev-mode short-circuit: when the ref points at the Monoceros feature
 * library AND the local workbench has the feature on disk, the resolver
 * swaps in the absolute filesystem path. `devcontainer-cli` reads
 * absolute paths as local features, so the build uses the in-tree
 * source instead of pulling from GHCR. Once GHCR is published in M4,
 * the local file disappears in non-workbench installs and the ref
 * passes through unchanged.
 *
 * Third-party refs (`ghcr.io/devcontainers/...`, etc.) always pass
 * through verbatim.
 */
const MONOCEROS_FEATURE_RE =
  /^ghcr\.io\/monoceros\/features\/([a-z0-9._-]+):[a-z0-9._-]+$/;

export function resolveFeatureRef(ref: string): string {
  const match = MONOCEROS_FEATURE_RE.exec(ref);
  if (!match) return ref;
  const localPath = path.join(workbenchRoot(), 'images', 'features', match[1]!);
  return existsSync(localPath) ? localPath : ref;
}

export function buildDevcontainerJson(opts: CreateOptions): DevcontainerJson {
  const features: Record<string, Record<string, unknown>> = {};
  for (const lang of opts.languages) {
    if (BUILTIN_LANGUAGES.has(lang)) continue;
    const entry = LANGUAGE_CATALOG[lang];
    if (entry) features[entry.feature] = {};
  }
  if (opts.aptPackages && opts.aptPackages.length > 0) {
    // The apt-packages devcontainer feature accepts a comma-separated
    // list of package names. Spaces in the value would trip apt-get, so
    // we join exactly as the feature expects.
    features['ghcr.io/devcontainers-contrib/features/apt-packages:1'] = {
      packages: opts.aptPackages.join(','),
    };
  }
  // Custom features (via `monoceros add-feature` or directly in the
  // yml) are merged last and win on ref collision. Refs starting with
  // `./features/<name>` are rewritten to absolute paths into the
  // workbench's `images/features/` library.
  if (opts.features) {
    for (const [ref, options] of Object.entries(opts.features)) {
      features[resolveFeatureRef(ref)] = options;
    }
  }

  const featuresField =
    Object.keys(features).length > 0 ? { features } : undefined;

  // No scaffold-level VS Code customizations today — extension hints
  // belong with the feature that needs them (e.g. the claude-code
  // feature itself recommends `anthropic.claude-code`).

  const wantsRepoAuth = (opts.repos?.length ?? 0) > 0;
  const repoAuthEnv = wantsRepoAuth ? { containerEnv: buildRepoAuthEnv() } : {};

  if (needsCompose(opts)) {
    // Compose-mode: SSH-agent mount goes onto the workspace service in
    // compose.yaml (see buildComposeYaml); devcontainer.json just
    // forwards the env vars.
    return {
      name: opts.name,
      dockerComposeFile: 'compose.yaml',
      service: 'workspace',
      ...(opts.services.length > 0 ? { runServices: opts.services } : {}),
      workspaceFolder: `/workspaces/${opts.name}`,
      remoteUser: 'node',
      forwardPorts: [3000, 4000],
      postCreateCommand: '.devcontainer/post-create.sh',
      ...(featuresField ?? {}),
      ...repoAuthEnv,
    };
  }

  // Build the mounts array. Today only repo-auth (SSH-agent) needs an
  // explicit scaffold-level mount; everything else (Claude Code's
  // ~/.claude bind, future tool host-deps) is the responsibility of
  // the devcontainer feature that pulls the tool in.
  const mounts: string[] = wantsRepoAuth ? buildRepoAuthMounts() : [];
  const mountsField = mounts.length > 0 ? { mounts } : {};

  return {
    name: opts.name,
    image: BASE_IMAGE,
    remoteUser: 'node',
    ...mountsField,
    runArgs: ['--cap-add=NET_ADMIN'],
    forwardPorts: [3000, 4000],
    postCreateCommand: '.devcontainer/post-create.sh',
    ...(featuresField ?? {}),
    ...repoAuthEnv,
  };
}

// Hand-rolled YAML for compose.yaml. The shape is narrow enough that
// avoiding a YAML dependency outweighs the cost of careful indentation.
export function buildComposeYaml(opts: CreateOptions): string {
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
  lines.push('    volumes:');
  lines.push(`      - ..:/workspaces/${opts.name}:cached`);
  const wantsRepoAuth = (opts.repos?.length ?? 0) > 0;
  if (wantsRepoAuth) {
    // `:-/dev/null` fallback so the compose-up doesn't error when the
    // builder has no SSH agent running host-side — the container starts
    // (with a useless dummy socket), and the git clone fails clearly
    // instead of crashing the whole devcontainer.
    lines.push(`      - \${SSH_AUTH_SOCK:-/dev/null}:${SSH_AGENT_TARGET}`);
    lines.push('    environment:');
    lines.push(`      SSH_AUTH_SOCK: ${SSH_AGENT_TARGET}`);
    lines.push(`      GIT_SSH_COMMAND: "${GIT_SSH_COMMAND}"`);
  }

  const namedVolumes: string[] = [];
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
    if (def.volume) {
      lines.push('    volumes:');
      lines.push(`      - ${def.volume.name}:${def.volume.mount}`);
      namedVolumes.push(def.volume.name);
    }
  }

  if (namedVolumes.length > 0) {
    lines.push('volumes:');
    for (const name of namedVolumes) {
      lines.push(`  ${name}:`);
    }
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
  // Sort repos by name so the Explorer order is deterministic and
  // doesn't depend on insertion order. (Clone order in post-create
  // stays as-added so deps still work.)
  const sortedRepos = [...(opts.repos ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const repo of sortedRepos) {
    folders.push({ path: `projects/${repo.name}`, name: repo.name });
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
      '# into `projects/<name>/` if (and only if) the directory does',
      '# not exist yet. Existing project subfolders are left alone so',
      '# local changes survive `monoceros apply` rebuilds.',
      'mkdir -p projects',
    );
    for (const repo of opts.repos) {
      const branchFlag = repo.branch ? ` --branch ${repo.branch}` : '';
      const branchLabel = repo.branch ? ` (branch: ${repo.branch})` : '';
      lines.push(
        `if [ ! -d "projects/${repo.name}" ]; then`,
        `  echo "→ Cloning ${repo.name} from ${repo.url}${branchLabel}…"`,
        `  git clone${branchFlag} "${repo.url}" "projects/${repo.name}"`,
        `else`,
        `  echo "→ projects/${repo.name} already exists, skipping clone"`,
        `fi`,
      );
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
): Promise<void> {
  const devcontainerDir = path.join(targetDir, '.devcontainer');
  const monocerosDir = path.join(targetDir, '.monoceros');
  const projectsDir = path.join(targetDir, 'projects');
  await fs.mkdir(devcontainerDir, { recursive: true });
  await fs.mkdir(monocerosDir, { recursive: true });
  await fs.mkdir(projectsDir, { recursive: true });

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

  const devcontainerJson = buildDevcontainerJson(opts);
  await fs.writeFile(
    path.join(devcontainerDir, 'devcontainer.json'),
    JSON.stringify(devcontainerJson, null, 2) + '\n',
  );

  await writePostCreateScript(devcontainerDir, opts);

  const composePath = path.join(devcontainerDir, 'compose.yaml');
  if (needsCompose(opts)) {
    await fs.writeFile(composePath, buildComposeYaml(opts));
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
