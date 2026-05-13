import { promises as fs } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import {
  buildClaudeSettings,
  buildCodeWorkspaceJson,
  buildComposeYaml,
  buildDevcontainerJson,
  buildReadmeStub,
  buildStackJson,
  copyPostCreateScript,
  needsCompose,
  normalizeOptions,
  validateOptions,
} from './scaffold.js';
import type { CreateOptions, StackFile } from './types.js';

export type { CreateOptions, StackFile } from './types.js';

export interface RunCreateLogger {
  success: (message: string) => void;
  info: (message: string) => void;
}

export interface RunCreateOptions {
  cliVersion: string;
  cwd?: string;
  now?: Date;
  logger?: RunCreateLogger;
}

export interface RunCreateResult {
  status: 'created' | 'already-up-to-date';
  targetDir: string;
}

export async function runCreate(
  rawOpts: CreateOptions,
  runOpts: RunCreateOptions,
): Promise<RunCreateResult> {
  validateOptions(rawOpts);
  const opts = normalizeOptions(rawOpts);
  const cwd = runOpts.cwd ?? process.cwd();
  const logger: RunCreateLogger = runOpts.logger ?? {
    success: (msg) => consola.success(msg),
    info: (msg) => consola.info(msg),
  };
  const targetDir = path.resolve(cwd, opts.name);

  const existing = await readExistingStack(targetDir);
  if (existing) {
    if (optionsMatch(existing, opts)) {
      logger.info(
        `Solution ${opts.name} already initialized with these options. Nothing to do.`,
      );
      return { status: 'already-up-to-date', targetDir };
    }
    throw new Error(
      `Solution ${opts.name} exists with different options. Use \`monoceros add-service\` / \`add-language\` to modify.`,
    );
  }

  if ((await pathExists(targetDir)) && !(await isEmptyDir(targetDir))) {
    throw new Error(
      `Refusing to scaffold into non-empty directory: ${targetDir}.`,
    );
  }

  const devcontainerDir = path.join(targetDir, '.devcontainer');
  const monocerosDir = path.join(targetDir, '.monoceros');
  const projectsDir = path.join(targetDir, 'projects');
  await fs.mkdir(devcontainerDir, { recursive: true });
  await fs.mkdir(monocerosDir, { recursive: true });
  await fs.mkdir(projectsDir, { recursive: true });
  // Empty .gitkeep so `projects/` survives a fresh git clone before any
  // sub-project has been added. Harmless when the solution itself isn't
  // a git repo.
  await fs.writeFile(path.join(projectsDir, '.gitkeep'), '');

  const devcontainerJson = buildDevcontainerJson(opts);
  await fs.writeFile(
    path.join(devcontainerDir, 'devcontainer.json'),
    JSON.stringify(devcontainerJson, null, 2) + '\n',
  );

  await copyPostCreateScript(devcontainerDir);

  if (needsCompose(opts)) {
    await fs.writeFile(
      path.join(devcontainerDir, 'compose.yaml'),
      buildComposeYaml(opts),
    );
  }

  const stack = buildStackJson(opts, runOpts.cliVersion, runOpts.now);
  await fs.writeFile(
    path.join(monocerosDir, 'stack.json'),
    JSON.stringify(stack, null, 2) + '\n',
  );

  await fs.writeFile(path.join(targetDir, 'README.md'), buildReadmeStub(opts));

  // VS Code multi-root workspace file. Lists `.` as the only root at
  // create time; `monoceros add-repo` appends each project subfolder
  // later so they appear as sibling roots in the Explorer.
  await fs.writeFile(
    path.join(targetDir, `${opts.name}.code-workspace`),
    JSON.stringify(buildCodeWorkspaceJson(opts), null, 2) + '\n',
  );

  // Register the Monoceros plugin via Claude Code's plugin/marketplace
  // system. Same mechanism is read by the terminal CLI and the VS
  // Code Extension, so slash commands appear in both surfaces.
  const claudeDir = path.join(targetDir, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify(buildClaudeSettings(), null, 2) + '\n',
  );

  logger.success(`Created solution ${opts.name} at ${targetDir}.`);
  return { status: 'created', targetDir };
}

async function readExistingStack(targetDir: string): Promise<StackFile | null> {
  const stackPath = path.join(targetDir, '.monoceros', 'stack.json');
  try {
    const content = await fs.readFile(stackPath, 'utf8');
    return JSON.parse(content) as StackFile;
  } catch {
    return null;
  }
}

function optionsMatch(stack: StackFile, opts: CreateOptions): boolean {
  return (
    stack.name === opts.name &&
    arraysEqual(stack.languages, opts.languages) &&
    arraysEqual(stack.services, opts.services) &&
    (stack.externalServices.postgres ?? undefined) === opts.postgresUrl
  );
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isEmptyDir(p: string): Promise<boolean> {
  const entries = await fs.readdir(p);
  return entries.length === 0;
}
