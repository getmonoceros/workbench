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
}

// Normalize: dedupe + sort + drop postgres from compose services when an
// external --postgres-url is provided.
export function normalizeOptions(opts: CreateOptions): CreateOptions {
  const languages = [...new Set(opts.languages)].sort();
  let services = [...new Set(opts.services)].sort();
  if (opts.postgresUrl) {
    services = services.filter((s) => s !== 'postgres');
  }
  return {
    name: opts.name,
    languages,
    services,
    postgresUrl: opts.postgresUrl,
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

export async function copyPostCreateScript(
  devcontainerDir: string,
): Promise<void> {
  const src = path.join(
    defaultTemplateDir(),
    '.devcontainer',
    'post-create.sh',
  );
  const dest = path.join(devcontainerDir, 'post-create.sh');
  await fs.copyFile(src, dest);
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
