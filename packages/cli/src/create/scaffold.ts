import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASE_IMAGE,
  BUILTIN_LANGUAGES,
  LANGUAGE_CATALOG,
  SERVICE_CATALOG,
  WORKBENCH_CONTAINER_PATH,
  knownLanguages,
  knownServices,
} from './catalog.js';
import type { CreateOptions, StackFile } from './types.js';

let cachedRepoRoot: string | null = null;

function findRepoRoot(): string {
  if (cachedRepoRoot) return cachedRepoRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const marker = path.join(
      dir,
      'templates',
      'default',
      '.devcontainer',
      'devcontainer.json',
    );
    if (existsSync(marker)) {
      cachedRepoRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        'Could not locate monoceros templates/default/.devcontainer/. Make sure the CLI is run from a workbench checkout.',
      );
    }
    dir = parent;
  }
}

export function defaultTemplateDir(): string {
  return path.join(findRepoRoot(), 'templates', 'default');
}

export function workbenchRoot(): string {
  return findRepoRoot();
}

// Debian/Ubuntu apt package name rules: start with alphanumeric, then
// alphanumerics + `.+-` are allowed. We intentionally don't allow shell
// metacharacters (`;`, `&`, `|`, `$`, `(`, …) so a typo can't smuggle
// arbitrary shell into the apt-packages feature config.
const APT_PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9.+-]*$/;

// Devcontainer feature refs are OCI image refs:
// `<registry>/<namespace>/<feature>:<tag>`. Permissive but no shell
// metacharacters or spaces.
const FEATURE_REF_RE = /^[a-z0-9.-]+(\/[a-z0-9._-]+)+:[a-z0-9._-]+$/;

// Install URLs must be https:// (no plain http, no other schemes) and
// contain only URL-safe characters. We deliberately reject shell
// metacharacters even inside a query string — the URL is embedded into
// a generated bash script, and a stray `$` or backtick would be a
// shell-injection vector.
const INSTALL_URL_RE = /^https:\/\/[A-Za-z0-9.\-_~/:?#[\]@!&'()*+,;=%]+$/;

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
  return {
    name: opts.name,
    languages,
    services,
    postgresUrl: opts.postgresUrl,
    ...(aptPackages.length > 0 ? { aptPackages } : {}),
    ...(features && Object.keys(features).length > 0 ? { features } : {}),
    ...(installUrls && installUrls.length > 0 ? { installUrls } : {}),
  };
}

export function needsCompose(opts: CreateOptions): boolean {
  return opts.services.length > 0;
}

interface DevcontainerCustomizations {
  vscode?: {
    extensions?: string[];
  };
}

interface DevcontainerImageMode {
  name: string;
  image: string;
  remoteUser: string;
  mounts: string[];
  // Required so the runtime image's entrypoint can configure iptables
  // egress rules. Without it the entrypoint logs a warning and falls
  // through to unrestricted egress (no silent fail-open). See ADR 0002.
  runArgs: string[];
  forwardPorts: number[];
  postCreateCommand: string;
  customizations: DevcontainerCustomizations;
  features?: Record<string, Record<string, unknown>>;
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
  customizations: DevcontainerCustomizations;
  features?: Record<string, Record<string, unknown>>;
}

export type DevcontainerJson = DevcontainerImageMode | DevcontainerComposeMode;

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
  // Custom features (via `monoceros add-feature`) are merged last. If
  // they collide with a curated feature ref (e.g. the apt-packages
  // feature also managed via add-apt-packages), the custom entry wins —
  // the builder added it explicitly.
  if (opts.features) {
    for (const [ref, options] of Object.entries(opts.features)) {
      features[ref] = options;
    }
  }

  const featuresField =
    Object.keys(features).length > 0 ? { features } : undefined;

  // VS Code customizations: auto-install the Claude Code extension when
  // the workspace opens in a Dev Container. Aligns the IDE story with
  // the workbench's positioning around AI-assisted coding. Builders who
  // prefer a different agent (Cline, Continue, …) can edit the
  // extension list in their solution's devcontainer.json.
  const customizations: DevcontainerCustomizations = {
    vscode: {
      extensions: ['anthropic.claude-code'],
    },
  };

  if (needsCompose(opts)) {
    // Compose-mode handles NET_ADMIN via cap_add on the workspace
    // service in compose.yaml — no runArgs needed here.
    return {
      name: opts.name,
      dockerComposeFile: 'compose.yaml',
      service: 'workspace',
      ...(opts.services.length > 0 ? { runServices: opts.services } : {}),
      workspaceFolder: `/workspaces/${opts.name}`,
      remoteUser: 'node',
      forwardPorts: [3000, 4000],
      postCreateCommand: '.devcontainer/post-create.sh',
      customizations,
      ...(featuresField ?? {}),
    };
  }

  return {
    name: opts.name,
    image: BASE_IMAGE,
    remoteUser: 'node',
    mounts: [
      'source=${localEnv:HOME}/.claude,target=/home/node/.claude,type=bind,consistency=cached',
      `source=${workbenchRoot()},target=${WORKBENCH_CONTAINER_PATH},type=bind,consistency=cached`,
    ],
    runArgs: ['--cap-add=NET_ADMIN'],
    forwardPorts: [3000, 4000],
    postCreateCommand: '.devcontainer/post-create.sh',
    customizations,
    ...(featuresField ?? {}),
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
  lines.push('      - ${HOME}/.claude:/home/node/.claude');
  lines.push(`      - ${workbenchRoot()}:${WORKBENCH_CONTAINER_PATH}:cached`);

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

export function buildStackJson(
  opts: CreateOptions,
  cliVersion: string,
  now: Date = new Date(),
): StackFile {
  return {
    name: opts.name,
    createdAt: now.toISOString(),
    monocerosCliVersion: cliVersion,
    languages: opts.languages,
    services: opts.services,
    externalServices: opts.postgresUrl ? { postgres: opts.postgresUrl } : {},
    ...(opts.aptPackages && opts.aptPackages.length > 0
      ? { aptPackages: opts.aptPackages }
      : {}),
    ...(opts.features && Object.keys(opts.features).length > 0
      ? { features: opts.features }
      : {}),
    ...(opts.installUrls && opts.installUrls.length > 0
      ? { installUrls: opts.installUrls }
      : {}),
  };
}

export function buildReadmeStub(opts: CreateOptions): string {
  const lines: string[] = [
    `# ${opts.name}`,
    '',
    'Generated by `monoceros create`. The `.devcontainer/` directory provides',
    'a sandboxed development environment with Claude Code preinstalled.',
    '',
    '## Quick start',
    '',
    '```sh',
    'monoceros shell',
    '```',
    '',
    '## Workspace layout',
    '',
    'This solution is a Monoceros workspace, not a project. The Monoceros',
    'system folders (`.devcontainer/`, `.monoceros/`, `.claude/`) live at',
    'the workspace root. Your actual code goes into `projects/` — one folder',
    'per repository or sub-project:',
    '',
    '```',
    `${opts.name}/`,
    '  .devcontainer/        ← system',
    '  .monoceros/           ← system',
    '  .claude/              ← system',
    `  ${opts.name}.code-workspace`,
    '  projects/',
    '    your-repo-here/     ← clone or `git init`',
    '',
    '```',
    '',
    `Open \`${opts.name}.code-workspace\` in VS Code to see all project folders`,
    'as separate roots in the Explorer alongside the workspace root.',
    '',
    '## Stack',
    '',
    `- Languages: ${opts.languages.length ? opts.languages.join(', ') : '(node only — base image)'}`,
    `- Services: ${opts.services.length ? opts.services.join(', ') : '(none)'}`,
  ];
  if (opts.postgresUrl) {
    lines.push('- External Postgres: configured via `--postgres-url`');
  }
  lines.push(
    '',
    'See `.monoceros/stack.json` for the full audit trail of selected options.',
    '',
    '## Command reference',
    '',
    'Inside the container, every `monoceros …` command has a detail',
    'doc under `/opt/monoceros-workbench/docs/commands/` — start with',
    '`/opt/monoceros-workbench/docs/commands/README.md` for the index.',
    '`monoceros <cmd> --help` shows the short version with flags only.',
    '',
  );
  return lines.join('\n');
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
 * (with its system dotfolders) stays visible in the Explorer. Project
 * subfolders are appended later by `monoceros add-repo` once they
 * exist — at create time the list contains only `.`.
 */
export function buildCodeWorkspaceJson(
  _opts: CreateOptions,
): CodeWorkspaceFile {
  return {
    folders: [{ path: '.' }],
  };
}

/**
 * Generate the `post-create.sh` content for a solution. The base
 * sections (pnpm install, monoceros-plugin wiring) are fixed. The
 * `installUrls` section is appended only when the solution has at
 * least one URL — keeping the script byte-identical with previous
 * versions for the common case.
 */
export function buildPostCreateScript(opts: CreateOptions): string {
  const lines: string[] = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    '# Claude Code CLI is preinstalled in monoceros-runtime:dev. Only thing',
    '# left for postCreate is bringing Node dependencies if the workspace',
    '# has a package.json.',
    'if [ -f package.json ]; then',
    '  pnpm install',
    'fi',
    '',
    '# Wire `monoceros-plugin` into PATH when the workbench is bind-mounted',
    "# at /opt/monoceros-workbench. The workbench's pnpm install must have",
    '# been run host-side first; the workspace symlinks under node_modules/',
    "# come along via the bind mount. pnpm's supportedArchitectures config",
    '# (in pnpm-workspace.yaml) pulls linux esbuild binaries host-side so',
    '# tsx works in the container.',
    '#',
    '# Failing to wire here is non-fatal — the slash commands will surface',
    '# a clear error message at first use.',
    'WORKBENCH=/opt/monoceros-workbench',
    'BIN_PATH=/usr/local/bin/monoceros-plugin',
    'MAIN_TS=$WORKBENCH/packages/plugin/src/main.ts',
    'TSX=$WORKBENCH/node_modules/.bin/tsx',
    'if [ -f "$MAIN_TS" ] && [ -x "$TSX" ]; then',
    '  sudo tee "$BIN_PATH" > /dev/null <<EOF',
    '#!/usr/bin/env bash',
    'exec "$TSX" "$MAIN_TS" "\\$@"',
    'EOF',
    '  sudo chmod 0755 "$BIN_PATH"',
    'elif [ -d "$WORKBENCH/packages/plugin" ]; then',
    '  echo "warn: monoceros-plugin not wired into PATH." >&2',
    '  echo "warn: run \\`pnpm install\\` in the workbench host-side, then restart the container." >&2',
    'fi',
  ];

  if (opts.installUrls && opts.installUrls.length > 0) {
    lines.push(
      '',
      '# Custom install URLs added via `monoceros add-from-url`. Each is',
      '# fetched and piped to bash on every container rebuild. URLs run',
      '# in insertion order so later installs can build on earlier ones.',
      `echo "→ Running ${opts.installUrls.length} install URL(s) added via add-from-url…"`,
    );
    for (const url of opts.installUrls) {
      lines.push(`echo "→ ${url}"`, `bash <(curl -fsSL "${url}")`);
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
 * The `.claude/settings.json` we write into each solution. Registers
 * the workbench checkout as a `directory`-source marketplace and
 * enables the in-tree `monoceros` plugin. Claude Code reads this
 * settings file at session start (terminal CLI and VS Code Extension
 * alike), so the plugin's slash commands appear without per-solution
 * file copying.
 *
 * **Dev only.** When the plugin is published in M4 (likely as a
 * GitHub-source marketplace at `kamann/monoceros`, or via a default
 * marketplace listing), this function returns a settings object that
 * points at the published source instead. The wrapping mechanism
 * (`enabledPlugins` + `extraKnownMarketplaces` in the solution's
 * `.claude/settings.json`) stays the same; only the marketplace
 * source descriptor changes. Plan tracked in
 * [docs/backlog.md](../../../../../docs/backlog.md) under "M4 — Go-Live".
 */
export function buildClaudeSettings(): Record<string, unknown> {
  return {
    extraKnownMarketplaces: {
      'monoceros-workbench': {
        source: {
          source: 'directory',
          path: WORKBENCH_CONTAINER_PATH,
        },
      },
    },
    enabledPlugins: {
      'monoceros@monoceros-workbench': true,
    },
  };
}
