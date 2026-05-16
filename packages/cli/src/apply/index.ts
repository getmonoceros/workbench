import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import { configPath } from '../config/paths.js';
import { readConfig } from '../config/io.js';
import { REGEX } from '../config/schema.js';
import {
  buildStateFile,
  readStateFile,
  writeStateFile,
} from '../config/state.js';
import { solutionConfigToCreateOptions } from '../config/transform.js';
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
