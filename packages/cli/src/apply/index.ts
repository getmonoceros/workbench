import { existsSync, promises as fs } from 'node:fs';
import { consola } from 'consola';
import { type MonocerosConfig, readMonocerosConfig } from '../config/global.js';
import { readConfig } from '../config/io.js';
import {
  containerConfigPath,
  containerDir,
  monocerosHome as defaultMonocerosHome,
  prettyPath,
} from '../config/paths.js';
import { REGEX } from '../config/schema.js';
import {
  buildStateFile,
  readStateFile,
  writeStateFile,
} from '../config/state.js';
import type { SolutionConfig } from '../config/schema.js';
import { solutionConfigToCreateOptions } from '../config/transform.js';
import {
  needsCompose,
  normalizeOptions,
  validateOptions,
  writeScaffold,
} from '../create/scaffold.js';
import { migrateDeprecatedFeatureRef } from '../util/ref.js';
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
 * `monoceros apply <name>` — read the yml at
 * `<MONOCEROS_HOME>/container-configs/<name>.yml`, materialize the
 * devcontainer scaffold at `<MONOCEROS_HOME>/container/<name>/`, write
 * `.monoceros/state.json` with `origin: <name>`, then teardown + bring
 * the container up.
 *
 * The target location is determined by convention, not by cwd or an
 * explicit path argument. That's deliberate: a config is the source of
 * truth, the container directory mirrors it 1:1, and the builder never
 * has to remember "which directory was sandbox materialized into".
 *
 * Idempotent: re-running picks up the current yml, overwrites scaffold
 * files, restarts the container.
 *
 * Refuses to materialize into a non-empty directory whose state.json
 * points at a different origin — protects against accidental clobber
 * if a builder somehow seeded `<MONOCEROS_HOME>/container/<name>/`
 * outside of this command.
 */

export interface RunApplyOptions {
  /** Config name — resolves to `<home>/container-configs/<name>.yml`. */
  name: string;
  cliVersion: string;
  /** Override of the user-data home. Tests inject a tmpdir. */
  monocerosHome?: string;
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

export interface RunApplyResult {
  /** Absolute path to the materialized container directory. */
  targetDir: string;
  /** Absolute path to the source yml. */
  configPath: string;
  /** Exit code of the trailing `devcontainer up` step. */
  containerExitCode: number;
}

export async function runApply(opts: RunApplyOptions): Promise<RunApplyResult> {
  const home = opts.monocerosHome ?? defaultMonocerosHome();
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

  const ymlPath = containerConfigPath(opts.name, home);
  if (!existsSync(ymlPath)) {
    throw new Error(
      `No such config: ${ymlPath}. Run \`monoceros init <template> ${opts.name}\` first.`,
    );
  }

  const targetDir = containerDir(opts.name, home);
  await assertSafeTargetDir(targetDir, opts.name);

  const parsed = await readConfig(ymlPath);
  // Read global defaults early — feature option defaults from
  // `monoceros-config.yml` need to be merged before scaffold codegen,
  // and the git identity logic later in this function also needs the
  // global config.
  const globalConfig = await readMonocerosConfig({ monocerosHome: home });

  // Pre-M4 the canonical feature namespace was
  // `ghcr.io/monoceros/features/…`. After the M4 cut it moved to
  // `ghcr.io/getmonoceros/monoceros-features/…`. Old refs still
  // structurally parse as third-party refs, so apply would silently
  // try to pull them from GHCR and 404. Warn loudly and tell the
  // builder what to write instead — but don't rewrite their yml or
  // fail the apply, so they stay in control of the migration.
  warnOnDeprecatedFeatureRefs(parsed.config.features, globalConfig, logger);

  // Shape validation happened in readConfig; catalog validation
  // (which language/service exists) happens here against
  // create/scaffold's known set.
  const createOpts = normalizeOptions(
    solutionConfigToCreateOptions(
      parsed.config,
      globalConfig?.defaults?.features ?? {},
    ),
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
  // Identity resolution priority: yml override → monoceros-config.yml
  // defaults → host global → persisted .monoceros/gitconfig → prompt.
  const idLogger = {
    info: logger.info,
    warn: logger.warn ?? logger.info,
  };
  await collectGitIdentity(targetDir, {
    ...(opts.identitySpawn ? { spawn: opts.identitySpawn } : {}),
    ...(opts.identityPrompt ? { prompt: opts.identityPrompt } : {}),
    ...(parsed.config.git?.user
      ? { containerOverride: parsed.config.git.user }
      : {}),
    ...(globalConfig?.defaults?.git?.user
      ? { defaults: globalConfig.defaults.git.user }
      : {}),
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
    `Materialized config '${opts.name}' into ${prettyPath(targetDir)}. Starting container…`,
  );

  const exitCode = await runContainerCycle(targetDir, {
    hasCompose: needsCompose(createOpts),
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
 * `<MONOCEROS_HOME>/container/<name>/` is safe to (re-)materialize iff:
 *   - it doesn't exist or is empty (fresh apply), OR
 *   - it already carries `.monoceros/state.json` with the same origin
 *     (re-apply against the same yml).
 *
 * Anything else — unrelated files, or a state.json with a different
 * origin — is an error.
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
        `${targetDir} is already materialized from config '${state.origin}', not '${expectedOrigin}'. Delete the directory to re-target, or run \`monoceros apply ${state.origin}\`.`,
      );
    }
    return; // safe: re-apply same origin
  }

  throw new Error(
    `Refusing to materialize into non-empty directory ${targetDir} (no Monoceros state.json found). Delete the directory before re-running.`,
  );
}

interface MigrationLogger {
  warn?: (msg: string) => void;
  info: (msg: string) => void;
}

function warnOnDeprecatedFeatureRefs(
  containerFeatures: SolutionConfig['features'],
  globalConfig: MonocerosConfig | undefined,
  logger: MigrationLogger,
): void {
  const warn = logger.warn ?? logger.info;
  const seen = new Set<string>();
  const emit = (oldRef: string, source: string) => {
    if (seen.has(oldRef)) return;
    seen.add(oldRef);
    const newRef = migrateDeprecatedFeatureRef(oldRef);
    if (!newRef) return;
    warn(
      `Deprecated feature ref in ${source}: '${oldRef}'. ` +
        `Replace with '${newRef}' — the old namespace is no longer published. ` +
        `See docs/MIGRATION-M4.md for a sed snippet.`,
    );
  };

  for (const entry of containerFeatures) {
    emit(entry.ref, 'container yml');
  }
  const globalDefaults = globalConfig?.defaults?.features;
  if (globalDefaults) {
    for (const ref of Object.keys(globalDefaults)) {
      emit(ref, 'monoceros-config.yml');
    }
  }
}
