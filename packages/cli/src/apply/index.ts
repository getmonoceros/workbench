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
import { cyan, dim, sectionLine } from '../util/format.js';
import { migrateDeprecatedFeatureRef } from '../util/ref.js';
import {
  type ComposeSpawn,
  runContainerCycle,
} from '../devcontainer/compose.js';
import {
  type CredentialsSpawn,
  collectGitCredentials,
  uniqueHttpsHosts,
  formatMissingCredentialsError,
  formatUnknownProviderError,
} from '../devcontainer/credentials.js';
import {
  type ReachabilitySpawn,
  checkRepoReachability,
  formatUnreachableReposError,
} from '../devcontainer/repo-reachability.js';
import {
  type DockerInfoSpawn,
  detectDockerMode,
} from '../devcontainer/docker-mode.js';
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
    /**
     * Print a structural section marker (`▸ Configuration` etc).
     * Optional — tests typically pass a silent logger without one,
     * in which case section markers are no-ops.
     */
    section?: (label: string) => void;
  };
  cleanupSpawn?: ComposeSpawn;
  devcontainerSpawn?: DevcontainerSpawn;
  credentialsSpawn?: CredentialsSpawn;
  reachabilitySpawn?: ReachabilitySpawn;
  dockerInfoSpawn?: DockerInfoSpawn;
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
    // Default section renderer: empty line, bold-underlined "▸ Label",
    // empty line. Mirrors install.sh's section visuals.
    section: (label) => process.stderr.write(`\n${sectionLine(label)}\n\n`),
  };
  const section = (label: string) => logger.section?.(label);

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

  // ── Configuration ────────────────────────────────────────────
  section('Configuration');

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
  logger.success(`yml validated ${dim(`(${prettyPath(ymlPath)})`)}`);

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
  // Pre-fetch HTTPS credentials for every unique host derived from
  // the declared repos. Pre-flight: if any host returns no credentials,
  // fail fast with provider-specific setup hints — much more
  // actionable than letting the in-container `git clone` later die
  // with "could not read Username".
  //
  // First pass: reject hosts whose provider couldn't be resolved
  // (non-canonical host without an explicit `provider:` in the yml).
  // Those produce a separate "set provider:" error message — much
  // more useful than a generic "no credentials" hint because the
  // builder might actually have credentials in their helper, but we
  // wouldn't know which CLI to suggest.
  const hostsToFetch = uniqueHttpsHosts(createOpts.repos ?? []);
  const unknownProviderHosts = hostsToFetch
    .filter((h) => h.provider === 'unknown')
    .map((h) => h.host);
  if (unknownProviderHosts.length > 0) {
    throw new Error(formatUnknownProviderError(unknownProviderHosts));
  }
  if (hostsToFetch.length > 0) {
    const credResult = await collectGitCredentials(targetDir, hostsToFetch, {
      ...(opts.credentialsSpawn ? { spawn: opts.credentialsSpawn } : {}),
      logger: idLogger,
    });
    const missing = credResult.perHost.filter((p) => p.status !== 'ok');
    if (missing.length > 0) {
      throw new Error(formatMissingCredentialsError(missing));
    }
  }

  // Pre-flight stage 2: now that credentials are in place, probe each
  // declared repo URL via host-side `git ls-remote`. Catches the
  // "repo doesn't exist / token can't see it / DNS broken" failure
  // modes before the docker build runs — saving ~1–2 min on first
  // apply and replacing the noisy devcontainer-cli stack trace with
  // a focused per-repo error.
  const declaredRepos = createOpts.repos ?? [];
  if (declaredRepos.length > 0) {
    const reachability = await checkRepoReachability(declaredRepos, {
      ...(opts.reachabilitySpawn ? { spawn: opts.reachabilitySpawn } : {}),
    });
    const unreachable = reachability.filter((r) => !r.ok);
    if (unreachable.length > 0) {
      throw new Error(formatUnreachableReposError(unreachable));
    }
  }

  // ── Scaffold ─────────────────────────────────────────────────
  section('Scaffold');

  // Probe the host docker daemon for its mode (rootful vs rootless).
  // The result drives whether the generated devcontainer.json /
  // compose.yaml include `idmap` on their bind mounts — required for
  // rootless Docker on Linux where bind mounts otherwise apply a
  // user-namespace shift that breaks file ownership across the
  // host/container boundary. See docker-mode.ts for the rationale.
  const dockerMode = await detectDockerMode({
    ...(opts.dockerInfoSpawn ? { spawn: opts.dockerInfoSpawn } : {}),
  });

  await fs.mkdir(targetDir, { recursive: true });
  await writeScaffold(createOpts, targetDir, { dockerMode });
  await writeStateFile(
    targetDir,
    buildStateFile({
      origin: opts.name,
      cliVersion: opts.cliVersion,
      ...(opts.now ? { now: opts.now } : {}),
    }),
  );
  logger.success(`materialized into ${prettyPath(targetDir)}`);

  // ── Container ────────────────────────────────────────────────
  section('Container');

  // Pre-announce the feature list so the builder knows what's about
  // to be installed before devcontainer-cli's stream takes over.
  // Empty list = base-image-only container, no features section needed.
  const featureRefs = parsed.config.features.map((f) => f.ref);
  if (featureRefs.length > 0) {
    logger.info(`Features: ${featureRefs.map((r) => cyan(r)).join(', ')}`);
  }

  // First-apply UX: devcontainer-cli's upstream output prints
  // `Error fetching image details: No manifest found for …` for
  // multi-arch GHCR images, then sits silent for ~1 min while
  // Docker actually pulls the runtime image. Both are non-fatal —
  // the docker buildx step right after consumes the image just
  // fine. Flag in dim grey so it reads as ambient context.
  logger.info(
    dim(
      'Pulling runtime image and building feature layers. First apply takes ~1–2 min (Docker downloads the multi-arch base); subsequent applies are cached and fast. devcontainer-cli may log a "No manifest found" line — harmless, the pull continues.',
    ),
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

  // ── Next steps ───────────────────────────────────────────────
  // Only print the wrap-up on a successful container start;
  // otherwise the failing devcontainer-cli output is the relevant
  // signal and a cheery "shell into it!" line would be misleading.
  if (exitCode === 0) {
    section('Next steps');
    logger.info(`  ${cyan(`monoceros shell ${opts.name}`)}`);
  }

  return { targetDir, configPath: ymlPath, containerExitCode: exitCode };
}

/**
 * `<MONOCEROS_HOME>/container/<name>/` is safe to (re-)materialize iff:
 *   - it doesn't exist or is empty (fresh apply), OR
 *   - it already carries `.monoceros/state.json` with the same origin
 *     (re-apply against the same yml), OR
 *   - the only top-level entry is `.monoceros/` and there's no
 *     state.json — that's a partial-apply remnant: pre-flight wrote
 *     `gitconfig` / `git-credentials` into `.monoceros/` before
 *     something (reachability failure, Ctrl-C, expired token, …)
 *     aborted the apply ahead of `writeStateFile`. We own
 *     `.monoceros/`, so re-running is safe.
 *
 * Anything else — state.json with a different origin, or files
 * outside `.monoceros/` that aren't ours — stays an error so we
 * don't clobber unrelated work.
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

  // No state.json. If the only top-level entry is `.monoceros/`, this
  // is a partial-apply remnant from a failed earlier run — pre-flight
  // writes `.monoceros/gitconfig` and `.monoceros/git-credentials`
  // BEFORE the scaffold + state.json sequence, so a mid-apply abort
  // leaves exactly this shape behind. Treat it as recoverable.
  if (entries.length === 1 && entries[0] === '.monoceros') {
    return;
  }

  throw new Error(
    `Refusing to materialize into non-empty directory ${targetDir} (no Monoceros state.json found, and the directory has files we don't recognise). Delete the directory before re-running.`,
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
