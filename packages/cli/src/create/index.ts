import { promises as fs } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import {
  collectGitIdentity,
  type IdentityPrompt,
  type IdentitySpawn,
} from '../devcontainer/identity.js';
import {
  buildReadmeStub,
  buildStackJson,
  normalizeOptions,
  validateOptions,
  writeScaffold,
} from './scaffold.js';
import type { CreateOptions, StackFile } from './types.js';

export type { CreateOptions, StackFile } from './types.js';

export interface RunCreateLogger {
  success: (message: string) => void;
  info: (message: string) => void;
  warn?: (message: string) => void;
}

export interface RunCreateOptions {
  cliVersion: string;
  cwd?: string;
  now?: Date;
  logger?: RunCreateLogger;
  /**
   * Host-side `git config --global --get` spawn used to capture the
   * builder's user.name and user.email into `.monoceros/gitconfig`.
   * Tests inject a fake; production uses the real git binary.
   */
  identitySpawn?: IdentitySpawn;
  /**
   * Interactive fallback when the host has no global identity and no
   * persisted gitconfig from a previous run. Tests inject a canned
   * answer; production uses `consola.prompt` (skipped in
   * non-interactive contexts).
   */
  identityPrompt?: IdentityPrompt;
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

  // Materialize devcontainer + compose + post-create + .code-workspace +
  // .claude/settings.json + .monoceros/.gitignore + projects/.gitkeep.
  // Shared with `runApplyFromYml`.
  await writeScaffold(opts, targetDir);

  // README.md is a once-only stub — runApplyFromYml deliberately does
  // NOT touch it on re-apply (builder may have edited).
  await fs.writeFile(path.join(targetDir, 'README.md'), buildReadmeStub(opts));

  // stack.json is the legacy M2 source of truth. Phase 3 replaces it
  // with `state.json` + an external yml, but `runCreate` keeps writing
  // it until Task 7 migrates the create path too.
  const monocerosDir = path.join(targetDir, '.monoceros');
  const stack = buildStackJson(opts, runOpts.cliVersion, runOpts.now);
  await fs.writeFile(
    path.join(monocerosDir, 'stack.json'),
    JSON.stringify(stack, null, 2) + '\n',
  );

  // Capture host git identity (user.name + user.email) into
  // `.monoceros/gitconfig` so the first `monoceros start` already
  // gives the builder a working `git commit` inside the container.
  // `monoceros apply` re-runs this and overwrites with fresh values.
  await collectGitIdentity(targetDir, {
    ...(runOpts.identitySpawn ? { spawn: runOpts.identitySpawn } : {}),
    ...(runOpts.identityPrompt ? { prompt: runOpts.identityPrompt } : {}),
    logger: {
      info: () => {},
      warn: logger.warn ?? (() => {}),
    },
  });

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
