import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASE_IMAGE,
  BUILTIN_LANGUAGES,
  LANGUAGE_CATALOG,
  SERVICE_CATALOG,
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

interface DevcontainerImageMode {
  name: string;
  image: string;
  remoteUser: string;
  mounts: string[];
  forwardPorts: number[];
  postCreateCommand: string;
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

  if (needsCompose(opts)) {
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
    };
  }

  return {
    name: opts.name,
    image: BASE_IMAGE,
    remoteUser: 'node',
    mounts: [
      'source=${localEnv:HOME}/.claude,target=/home/node/.claude,type=bind,consistency=cached',
    ],
    forwardPorts: [3000, 4000],
    postCreateCommand: '.devcontainer/post-create.sh',
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
  lines.push('    user: node');
  lines.push('    volumes:');
  lines.push(`      - ..:/workspaces/${opts.name}:cached`);
  lines.push('      - ${HOME}/.claude:/home/node/.claude');

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
