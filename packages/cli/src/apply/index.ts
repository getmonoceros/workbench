import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import { configPath, configsDir } from '../config/paths.js';
import { createDoc, readConfig, writeConfig } from '../config/io.js';
import { REGEX } from '../config/schema.js';
import {
  buildStateFile,
  readStateFile,
  writeStateFile,
} from '../config/state.js';
import {
  solutionConfigToCreateOptions,
  stackFileToSolutionConfig,
} from '../config/transform.js';
import type { StackFile } from '../create/types.js';
import {
  needsCompose,
  normalizeOptions,
  validateOptions,
  writeScaffold,
} from '../create/scaffold.js';
import {
  type ComposeSpawn,
  runContainerCycle,
} from '../devcontainer/compose.js';
import {
  type CredentialsSpawn,
  collectGitCredentials,
} from '../devcontainer/credentials.js';
import { type DevcontainerSpawn } from '../devcontainer/cli.js';
import {
  collectGitIdentity,
  type IdentityPrompt,
  type IdentitySpawn,
} from '../devcontainer/identity.js';
import { findSolutionRoot } from '../devcontainer/locate.js';

/**
 * `monoceros apply <name> [<pfad>]` — read the yml at
 * `.local/container-configs/<name>.yml`, materialize the devcontainer
 * scaffold at `targetDir` (default cwd), write `.monoceros/state.json`
 * with `origin: <name>`, then teardown + bring the container up.
 *
 * Idempotent: re-running with the same name + path overwrites the
 * scaffold to match the current yml.
 *
 * Refuses to scaffold into a non-empty directory unless it already
 * carries a `.monoceros/state.json` whose `origin` matches the
 * requested name. That guard protects pre-existing data (M1 solutions,
 * unrelated projects) from accidental overwrite.
 */

export interface RunApplyFromYmlOptions {
  /** Config name — resolves to `.local/container-configs/<name>.yml`. */
  name: string;
  /** Target directory for the devcontainer scaffold. */
  targetDir: string;
  cliVersion: string;
  /** Optional override of the workbench root. Tests inject a tmpdir. */
  workbenchRoot?: string;
  now?: Date;
  logger?: {
    info: (msg: string) => void;
    success: (msg: string) => void;
    warn?: (msg: string) => void;
  };
  cleanupSpawn?: ComposeSpawn;
  devcontainerSpawn?: DevcontainerSpawn;
  credentialsSpawn?: CredentialsSpawn;
  identitySpawn?: IdentitySpawn;
  identityPrompt?: IdentityPrompt;
}

export interface RunApplyFromYmlResult {
  targetDir: string;
  configPath: string;
  containerExitCode: number;
}

export async function runApplyFromYml(
  opts: RunApplyFromYmlOptions,
): Promise<RunApplyFromYmlResult> {
  const logger = opts.logger ?? {
    info: (msg) => consola.info(msg),
    success: (msg) => consola.success(msg),
    warn: (msg) => consola.warn(msg),
  };

  if (!REGEX.solutionName.test(opts.name)) {
    throw new Error(
      `Invalid config name: ${JSON.stringify(opts.name)}. Use letters, digits, '.', '_' or '-'.`,
    );
  }

  const ymlPath = configPath(opts.name, opts.workbenchRoot);
  if (!existsSync(ymlPath)) {
    throw new Error(
      `No such config: ${ymlPath}. Run \`monoceros init <template> ${opts.name}\` first.`,
    );
  }

  const targetDir = path.resolve(opts.targetDir);
  await assertSafeTargetDir(targetDir, opts.name);

  const parsed = await readConfig(ymlPath);
  // Shape validation happened in readConfig; catalog validation
  // (which language/service exists) happens here against
  // create/scaffold's known set.
  const createOpts = normalizeOptions(
    solutionConfigToCreateOptions(parsed.config),
  );
  validateOptions(createOpts);

  await fs.mkdir(targetDir, { recursive: true });
  await writeScaffold(createOpts, targetDir);
  await writeStateFile(
    targetDir,
    buildStateFile({
      origin: opts.name,
      cliVersion: opts.cliVersion,
      ...(opts.now ? { now: opts.now } : {}),
    }),
  );

  // Refresh host git identity and HTTPS credentials before the
  // container teardown so they're in place when post-create.sh runs.
  const idLogger = {
    info: logger.info,
    warn: logger.warn ?? logger.info,
  };
  await collectGitIdentity(targetDir, {
    ...(opts.identitySpawn ? { spawn: opts.identitySpawn } : {}),
    ...(opts.identityPrompt ? { prompt: opts.identityPrompt } : {}),
    logger: idLogger,
  });
  if (
    createOpts.repos &&
    createOpts.repos.some((r) => r.url.startsWith('https://'))
  ) {
    await collectGitCredentials(targetDir, createOpts.repos, {
      ...(opts.credentialsSpawn ? { spawn: opts.credentialsSpawn } : {}),
      logger: idLogger,
    });
  }

  logger.success(
    `Materialized config '${opts.name}' into ${targetDir}. Starting container…`,
  );

  const exitCode = await runContainerCycle(targetDir, {
    hasCompose: needsCompose(createOpts),
    cwd: targetDir,
    ...(opts.cleanupSpawn !== undefined
      ? { cleanupSpawn: opts.cleanupSpawn }
      : {}),
    ...(opts.devcontainerSpawn !== undefined
      ? { devcontainerSpawn: opts.devcontainerSpawn }
      : {}),
    logger,
  });

  return { targetDir, configPath: ymlPath, containerExitCode: exitCode };
}

/**
 * The target dir is safe to (re-)materialize into iff:
 *   - it doesn't exist or is empty (fresh apply), OR
 *   - it already carries `.monoceros/state.json` with the same origin
 *     (re-apply against the same yml).
 *
 * Anything else — unrelated files, legacy `stack.json`, a state.json
 * with a different origin — is an error. Task 7 will add transparent
 * migration of legacy `stack.json`-backed solutions; until then the
 * builder gets a clear instruction to use the legacy `monoceros apply`
 * (no args).
 */
async function assertSafeTargetDir(
  targetDir: string,
  expectedOrigin: string,
): Promise<void> {
  if (!existsSync(targetDir)) return;
  const entries = await fs.readdir(targetDir);
  if (entries.length === 0) return;

  const state = await readStateFile(targetDir);
  if (state) {
    if (state.origin !== expectedOrigin) {
      throw new Error(
        `${targetDir} is already materialized from config '${state.origin}', not '${expectedOrigin}'. Use \`monoceros apply ${state.origin}\` to re-apply, or delete the directory to re-target.`,
      );
    }
    return; // safe: re-apply same origin
  }

  const legacyStack = path.join(targetDir, '.monoceros', 'stack.json');
  if (existsSync(legacyStack)) {
    throw new Error(
      `${targetDir} is a legacy stack.json-backed solution. Migration to the yml model lands in Task 7. Until then, use \`monoceros apply\` (without arguments) from inside it.`,
    );
  }

  throw new Error(
    `Refusing to materialize into non-empty directory ${targetDir} (no Monoceros state found). Delete the directory or pick another path.`,
  );
}

/**
 * `monoceros apply` without positional arguments. Walks up from cwd
 * to find a Monoceros dev-container root (a directory containing
 * `.devcontainer/`), then dispatches by what kind of solution it is:
 *
 *   - state.json present (Phase 3 solution) → re-apply via
 *     `runApplyFromYml({ name: state.origin, targetDir: <root> })`.
 *     The yml is the source of truth, so re-apply picks up any edits
 *     the builder made (or any `monoceros add-*` / `remove-*` calls).
 *
 *   - stack.json present, no state.json (legacy M1 solution) →
 *     `runApplyLegacy` (the stack.json-centric path). Task 7 swaps
 *     this for a transparent stack.json → yml migration.
 *
 *   - neither present → error with the original "no .devcontainer/"
 *     message so the builder knows to `monoceros create` or `init`.
 */
export interface RunApplyFromCwdOptions {
  cwd?: string;
  project?: string;
  cliVersion: string;
  logger?: {
    info: (msg: string) => void;
    success: (msg: string) => void;
    warn?: (msg: string) => void;
  };
  workbenchRoot?: string;
  cleanupSpawn?: ComposeSpawn;
  devcontainerSpawn?: DevcontainerSpawn;
  credentialsSpawn?: CredentialsSpawn;
  identitySpawn?: IdentitySpawn;
  identityPrompt?: IdentityPrompt;
}

export async function runApplyFromCwd(
  opts: RunApplyFromCwdOptions,
): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const startDir = opts.project ? path.resolve(cwd, opts.project) : cwd;
  const root = findSolutionRoot(startDir);
  if (!root) {
    throw new Error(
      `No .devcontainer/ found at or above ${startDir}. Run \`monoceros create\` or \`monoceros init <template> <name>\` first.`,
    );
  }

  const logger = opts.logger ?? {
    info: (msg) => consola.info(msg),
    success: (msg) => consola.success(msg),
    warn: (msg) => consola.warn(msg),
  };

  const state = await readStateFile(root);
  let origin: string;
  if (state) {
    origin = state.origin;
  } else {
    // No state.json — look for a legacy stack.json and migrate.
    const stack = await readLegacyStackFile(root);
    if (!stack) {
      // Should be unreachable: findSolutionRoot succeeded but neither
      // state.json nor stack.json is present. Builder must have hand-
      // crafted a `.devcontainer/`. Surface a clear instruction.
      throw new Error(
        `Found ${root}/.devcontainer/ but no .monoceros/state.json or stack.json. Recreate via \`monoceros init <template> <name>\` + \`monoceros apply <name> ${root}\`.`,
      );
    }
    origin = await migrateStackToYml(root, stack, {
      ...(opts.workbenchRoot ? { workbenchRoot: opts.workbenchRoot } : {}),
      cliVersion: opts.cliVersion,
      logger,
    });
  }

  const result = await runApplyFromYml({
    name: origin,
    targetDir: root,
    cliVersion: opts.cliVersion,
    ...(opts.workbenchRoot ? { workbenchRoot: opts.workbenchRoot } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.cleanupSpawn ? { cleanupSpawn: opts.cleanupSpawn } : {}),
    ...(opts.devcontainerSpawn
      ? { devcontainerSpawn: opts.devcontainerSpawn }
      : {}),
    ...(opts.credentialsSpawn
      ? { credentialsSpawn: opts.credentialsSpawn }
      : {}),
    ...(opts.identitySpawn ? { identitySpawn: opts.identitySpawn } : {}),
    ...(opts.identityPrompt ? { identityPrompt: opts.identityPrompt } : {}),
  });
  return result.containerExitCode;
}

async function readLegacyStackFile(
  root: string,
): Promise<StackFile | undefined> {
  try {
    const text = await fs.readFile(
      path.join(root, '.monoceros', 'stack.json'),
      'utf8',
    );
    return JSON.parse(text) as StackFile;
  } catch {
    return undefined;
  }
}

/**
 * Migrate a legacy M1 solution to the Phase-3 yml model. Writes
 * `.local/container-configs/<stack.name>.yml` from the stack, then
 * archives `.monoceros/stack.json` as `stack.json.legacy` so the next
 * `monoceros apply` doesn't try to migrate again.
 *
 * Returns the chosen config name so the caller can route into
 * runApplyFromYml. state.json is left to runApplyFromYml's normal
 * write step.
 *
 * Refuses to overwrite an existing yml — that situation means the
 * builder already ran `monoceros init <stack.name> …` separately and
 * the migration could clobber hand-edits.
 */
async function migrateStackToYml(
  root: string,
  stack: StackFile,
  opts: {
    workbenchRoot?: string;
    cliVersion?: string;
    logger: { info: (msg: string) => void; success: (msg: string) => void };
  },
): Promise<string> {
  const config = stackFileToSolutionConfig(stack);
  const ymlPath = configPath(config.name, opts.workbenchRoot);

  if (existsSync(ymlPath)) {
    throw new Error(
      `Migration aborted: yml at ${ymlPath} already exists. Delete it or rename the legacy solution (edit stack.json's "name" field) before re-running apply.`,
    );
  }

  await fs.mkdir(configsDir(opts.workbenchRoot), { recursive: true });
  await writeConfig(ymlPath, createDoc(config));

  // Write state.json upfront so the follow-up `runApplyFromYml`
  // recognizes the directory as "already materialized from <name>" and
  // passes its safe-dir check. The materializedAt timestamp is the
  // migration moment, which is good enough — runApplyFromYml will
  // overwrite it with the actual apply timestamp at the end.
  await writeStateFile(
    root,
    buildStateFile({
      origin: config.name,
      cliVersion: opts.cliVersion ?? stack.monocerosCliVersion,
    }),
  );

  // Archive the legacy stack.json so subsequent apply runs route
  // straight into the yml path. Keep the file around (renamed) so a
  // builder can diff against it if something looks off.
  const stackPath = path.join(root, '.monoceros', 'stack.json');
  await fs.rename(stackPath, `${stackPath}.legacy`);

  opts.logger.success(
    `Migrated ${root} to the yml model. yml: ${ymlPath}, stack.json archived as stack.json.legacy.`,
  );
  return config.name;
}
