import { existsSync, promises as fs } from 'node:fs';
import { consola } from 'consola';
import {
  type MonocerosConfig,
  proxyHostPort,
  readMonocerosConfig,
} from '../config/global.js';
import { parseConfig, readConfig, stringifyConfig } from '../config/io.js';
import {
  containerConfigPath,
  containerConfigsDir,
  containerDir,
  containerEnvPath,
  monocerosHome as defaultMonocerosHome,
  prettyPath,
} from '../config/paths.js';
import {
  readEnvFile,
  interpolateServices,
  interpolateFeatureOptions,
  formatMissingVarsError,
  ensureEnvGitignored,
  resolveGitUserFields,
} from '../config/env-file.js';
import { REGEX, isValidEmail } from '../config/schema.js';
import {
  buildStateFile,
  readStateFile,
  writeStateFile,
} from '../config/state.js';
import type { SolutionConfig } from '../config/schema.js';
import { solutionConfigToCreateOptions } from '../config/transform.js';
import {
  resolveRuntimeImage,
  runtimeSupportsSshAttach,
} from '../create/catalog.js';
import {
  type KeygenSpawn,
  setupSshAttach,
} from '../devcontainer/ssh-attach.js';
import {
  needsCompose,
  normalizeOptions,
  validateOptions,
  writeScaffold,
} from '../create/scaffold.js';
import { cyan, dim, sectionLine, stripAnsi } from '../util/format.js';
import { migrateDeprecatedFeatureRef } from '../util/ref.js';
import { createApplyLog, teeApplyLogger } from './apply-log.js';
import {
  type ApplyProgress,
  createApplyProgress,
  createSigintAbort,
  logFileOnlyLogger,
  progressTeeLogger,
} from './apply-progress.js';
import { buildApplySummary, formatApplySummary } from './apply-summary.js';
import { writeBriefing } from '../briefing/index.js';
import { loadComponentCatalog } from '../init/components.js';
import { type DockerExec, runContainerCycle } from '../devcontainer/compose.js';
import { resolveContainerImageId } from '../devcontainer/images.js';
import {
  DEFAULT_UPGRADE_STALE_DAYS,
  readMachineState,
  recordBuiltImage,
  upgradeNudge,
} from '../config/machine-state.js';
import {
  type CredentialsSpawn,
  collectGitCredentials,
  uniqueHttpsHosts,
  formatMissingCredentialsError,
  formatUnknownProviderError,
} from '../devcontainer/credentials.js';
import {
  type DockerInfoSpawn,
  detectDockerMode,
  formatRootlessNotSupportedError,
} from '../devcontainer/docker-mode.js';
import { type DevcontainerSpawn } from '../devcontainer/cli.js';
import {
  ensureProxy,
  defaultDockerExec,
  type DockerExec as ProxyDockerExec,
} from '../proxy/index.js';
import { removeDynamicConfig, writeDynamicConfig } from '../proxy/dynamic.js';
import { preflightHostPort } from '../proxy/port-check.js';
import {
  collectGitIdentity,
  type IdentityPrompt,
  type IdentityScopePrompt,
  type IdentitySpawn,
} from '../devcontainer/identity.js';
import { writeGlobalDefaultGitUser } from '../config/global.js';
import { setContainerGitUserInDoc } from '../modify/yml.js';

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
  /**
   * Rebuild feature layers from scratch (`--build-no-cache`), so feature
   * tools re-pull their latest versions instead of reusing the frozen cached
   * layer. Set by `monoceros upgrade`; a routine `apply` leaves it false and
   * uses the cache. See ADR 0018.
   */
  rebuild?: boolean;
  /**
   * When true, stream the raw `@devcontainers/cli` output to stderr
   * exactly like before ADR 0013 step 2 — no spinner, no phase
   * detection, full transcript live. Also forced on when stderr is
   * not a TTY (CI, piped output). Defaults to false.
   */
  verbose?: boolean;
  /**
   * Override the stream the spinner writes to. Tests inject an
   * in-memory writable so the progress UI doesn't touch process.stderr.
   */
  progressOut?: NodeJS.WriteStream;
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
  dockerExec?: DockerExec;
  devcontainerSpawn?: DevcontainerSpawn;
  credentialsSpawn?: CredentialsSpawn;
  dockerInfoSpawn?: DockerInfoSpawn;
  identitySpawn?: IdentitySpawn;
  identityPrompt?: IdentityPrompt;
  identityScopePrompt?: IdentityScopePrompt;
  /** Override the docker exec used by the Traefik proxy lifecycle. */
  proxyDocker?: ProxyDockerExec;
  /** Override `ssh-keygen` for the SSH attach point (ADR 0022). Tests stub this. */
  sshKeygen?: KeygenSpawn;
  /** Override the user `.ssh` dir for SSH attach config (ADR 0022). Tests inject a tmpdir. */
  sshUserSshDir?: string;
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

  // The runtime image version must be pinned in the yml (ADR 0017). We
  // never silently adopt a default and re-image an existing container —
  // an unpinned yml is rejected with an actionable hint. `init` writes
  // the pin for new containers; pre-pinning ymls are pinned explicitly
  // or the container is recreated.
  if (!parsed.config.runtimeVersion) {
    throw new Error(
      `No runtime pinned for '${opts.name}': the yml has no 'runtimeVersion'. ` +
        `Pin it with \`monoceros upgrade ${opts.name} <version>\` (or add ` +
        `\`runtimeVersion: <version>\` to the yml), then re-apply.`,
    );
  }

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

  // Read the per-container env file (container-configs/<name>.env) — the
  // source for `${VAR}` references — BEFORE the transform, because
  // feature options must be resolved before they're merged with the
  // monoceros-config `defaults.features` cascade.
  const envPath = containerEnvPath(opts.name, home);
  await ensureEnvGitignored(containerConfigsDir(home));
  const envVars = readEnvFile(envPath);

  // Resolve `${VAR}` in FEATURE options first. A missing/empty value
  // becomes "" so the transform's merge skips it → the option falls
  // through to the global default (or stays unset). A filled value
  // overrides. This lets credential placeholders (`apiKey: ${VAR}`) be
  // active in the yml with a blank `.env` seed.
  const resolvedFeatures = interpolateFeatureOptions(
    parsed.config.features,
    envVars,
  );

  // Shape validation happened in readConfig; catalog validation
  // (which language/service exists) happens here against
  // create/scaffold's known set.
  const createOpts = normalizeOptions(
    solutionConfigToCreateOptions(
      { ...parsed.config, features: resolvedFeatures },
      globalConfig?.defaults?.features ?? {},
    ),
  );

  // Resolve `${VAR}` in SERVICE fields (post-transform — services don't
  // merge with defaults). Unlike features, an unresolved reference here
  // is a hard error: a silently-empty DB password fails far more
  // opaquely later.
  const interpServices = interpolateServices(createOpts.services, envVars);
  if (interpServices.missing.length > 0) {
    throw new Error(
      formatMissingVarsError(interpServices.missing, prettyPath(envPath)),
    );
  }
  createOpts.services = interpServices.services;

  // Resolve `${VAR}` in git identities — the container-level `git.user`
  // and each repo's `git.user` — against the same env file. UNLIKE
  // services/features, a missing var is NOT an error here: the identity
  // falls through to the existing cascade (monoceros-config defaults →
  // host → prompt). Only a fully-resolved-but-malformed email is a hard
  // error, checked now that the actual value is known (the schema defers
  // email format to apply on purpose).
  //
  //   - container `git.user`: per field. A resolved field is used; an
  //     unresolved one is dropped so the cascade fills it (the cascade
  //     already resolves name/email independently).
  //   - repo `git.user`: all-or-nothing. A single missing var drops the
  //     whole per-repo override, so the repo inherits the container
  //     identity (.monoceros/gitconfig) — no Frankenstein name-from-env +
  //     email-from-cascade.
  const gitUserErrors: string[] = [];
  let containerGitOverride: { name?: string; email?: string } | undefined;
  if (parsed.config.git?.user) {
    const f = resolveGitUserFields(parsed.config.git.user, envVars);
    if (f.email.value !== undefined && !isValidEmail(f.email.value)) {
      gitUserErrors.push(
        `git.user.email resolved to "${f.email.value}", which is not a valid email`,
      );
    }
    const override = {
      ...(f.name.value !== undefined ? { name: f.name.value } : {}),
      ...(f.email.value !== undefined ? { email: f.email.value } : {}),
    };
    if (Object.keys(override).length > 0) containerGitOverride = override;
  }
  for (const repo of createOpts.repos ?? []) {
    if (!repo.gitUser) continue;
    const f = resolveGitUserFields(repo.gitUser, envVars);
    if (f.name.value === undefined || f.email.value === undefined) {
      // All-or-nothing: a field with no usable value (missing/empty var)
      // drops the whole per-repo override → the repo inherits the
      // container identity, which itself climbs the cascade.
      delete repo.gitUser;
      continue;
    }
    if (!isValidEmail(f.email.value)) {
      gitUserErrors.push(
        `repos[${repo.path}].git.user.email resolved to "${f.email.value}", which is not a valid email`,
      );
      continue;
    }
    repo.gitUser = { name: f.name.value, email: f.email.value };
  }
  if (gitUserErrors.length > 0) {
    throw new Error(
      `Invalid git identity after resolving ${prettyPath(envPath)}:\n` +
        gitUserErrors.map((e) => `  - ${e}`).join('\n') +
        `\n\nFix the value in the env file (or the yml).`,
    );
  }

  validateOptions(createOpts);
  logger.success(`yml validated ${dim(`(${prettyPath(ymlPath)})`)}`);

  // Refresh host git identity and HTTPS credentials before the
  // container teardown so they're in place when post-create.sh runs.
  // Identity resolution priority: yml override → monoceros-config.yml
  // defaults → host global → persisted .monoceros/gitconfig → prompt.
  //
  // Skip identity collection entirely when there's no obvious reason
  // to need one: no repos to clone, no explicit yml.git.user, no
  // defaults.git.user. Without those, asking the builder for a
  // committer identity is pure friction — they didn't ask for git
  // and might just want a sandbox container. They can `monoceros
  // add-repo` later, at which point the next apply re-evaluates and
  // collects identity then.
  const hasRepos = (createOpts.repos ?? []).length > 0;
  const hasContainerGitUser = parsed.config.git?.user !== undefined;
  const hasDefaultGitUser = globalConfig?.defaults?.git?.user !== undefined;
  const idLogger = {
    info: logger.info,
    warn: logger.warn ?? logger.info,
  };
  if (hasRepos || hasContainerGitUser || hasDefaultGitUser) {
    const identity = await collectGitIdentity(targetDir, {
      ...(opts.identitySpawn ? { spawn: opts.identitySpawn } : {}),
      ...(opts.identityPrompt ? { prompt: opts.identityPrompt } : {}),
      ...(opts.identityScopePrompt
        ? { scopePrompt: opts.identityScopePrompt }
        : {}),
      ...(containerGitOverride
        ? { containerOverride: containerGitOverride }
        : {}),
      ...(globalConfig?.defaults?.git?.user
        ? { defaults: globalConfig.defaults.git.user }
        : {}),
      logger: idLogger,
    });

    // Persist a freshly-prompted identity to whichever scope the
    // builder picked. Scope `g` writes monoceros-config.yml's
    // `defaults.git.user`; `c` writes this container yml's
    // `git.user`; `b` does both. The `.monoceros/gitconfig` file
    // collectGitIdentity already wrote stays the in-container
    // mechanism — these writes are about making the value
    // recoverable on the next apply / next container without
    // re-prompting.
    if (identity.prompted) {
      await persistPromptedIdentity(identity.prompted, ymlPath, home, logger);
    }
  }
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

  // NOTE: repos are cloned IN the container (post-create.sh), using the
  // container's network + the mounted credential helper. We deliberately
  // do NOT probe or clone repos host-side: the host's network/credential
  // context isn't the container's (a host may fail to resolve a remote
  // the container reaches fine), so host-side gating produced spurious
  // pre-flight failures across platforms. The in-container clone is the
  // single source of truth and reports a real error if a repo genuinely
  // can't be reached. (The host-side clone added in ADR 0012 — for
  // service bind-mounts of repo files like init.sql — was reverted; that
  // ordering needs a container-side solution instead.)

  // ── Scaffold ─────────────────────────────────────────────────
  section('Scaffold');

  // Probe the host docker daemon. Two purposes today:
  //   - Refuse to apply on rootless Docker, which doesn't work with
  //     our bind-mount model (host/container file ownership doesn't
  //     line up; Docker doesn't expose the `idmap` mount option that
  //     would fix this). The refusal lands before any docker build
  //     or container start, so the builder gets a clear actionable
  //     message instead of permission-denied surprises mid-clone.
  //   - Plumb the mode through to scaffold for any future mode-
  //     dependent code paths (parameter is currently unused after
  //     the idmap revert — kept so the wiring is in place).
  const dockerMode = await detectDockerMode({
    ...(opts.dockerInfoSpawn ? { spawn: opts.dockerInfoSpawn } : {}),
  });
  if (dockerMode === 'rootless') {
    throw new Error(formatRootlessNotSupportedError());
  }

  await fs.mkdir(targetDir, { recursive: true });
  await writeScaffold(createOpts, targetDir, { dockerMode });
  await writeStateFile(
    targetDir,
    buildStateFile({
      origin: opts.name,
      cliVersion: opts.cliVersion,
      runtimeImage: resolveRuntimeImage(createOpts.runtimeVersion),
      ...(opts.now ? { now: opts.now } : {}),
    }),
  );

  // SSH attach point (ADR 0022): mint a per-container keypair and
  // register a `Host monoceros-<name>` block so any SSH-capable IDE or a
  // plain `ssh monoceros-<name>` attaches to the running container with
  // zero config. Gated on the pinned runtime shipping sshd (>= 1.2.0);
  // older images have no sshd, so the config would point at a dead port.
  // Non-fatal: an ssh-keygen / config hiccup must not strand the apply.
  if (runtimeSupportsSshAttach(createOpts.runtimeVersion)) {
    try {
      const ssh = await setupSshAttach({
        name: opts.name,
        targetDir,
        home,
        ...(opts.sshKeygen ? { keygen: opts.sshKeygen } : {}),
        ...(opts.sshUserSshDir ? { userSshDir: opts.sshUserSshDir } : {}),
        logger: idLogger,
      });
      if (ssh.configured) {
        logger.info(
          `SSH attach: \`ssh ${ssh.hostAlias}\` (or pick it in your IDE)`,
        );
      }
    } catch (err) {
      (logger.warn ?? logger.info)(
        `SSH attach setup skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Briefing files for AI tools inside the container. Lives next to
  // the scaffold (AGENTS.md / CLAUDE.md at the workspace root,
  // .monoceros/commands.md). See ADR 0014. Failure here is logged but
  // does not abort apply — a missing briefing degrades AI-tool UX but
  // the container itself is functional.
  try {
    const components = await loadComponentCatalog();
    await writeBriefing({ targetDir, createOpts, components });
  } catch (err) {
    const msg = `briefing files not written: ${err instanceof Error ? err.message : String(err)}`;
    (logger.warn ?? logger.info)(msg);
  }

  logger.success(`materialized into ${prettyPath(targetDir)}`);

  // Repos are cloned in-container by post-create.sh (see the NOTE above
  // the Scaffold section) — no host-side clone here.

  // ── Container ────────────────────────────────────────────────
  section('Container');

  // Open the per-apply log file under `<container>/logs/`. From this
  // point on, the wrapped `containerLogger` mirrors info/warn/success
  // into the log alongside the terminal, and `applyLog.sink` is teed
  // into the devcontainer-cli stream via `runContainerCycle`'s
  // `logSink` option. See ADR 0013.
  const applyLog = createApplyLog({
    name: opts.name,
    home,
    cliVersion: opts.cliVersion,
    configPath: ymlPath,
    ...(opts.now ? { now: opts.now } : {}),
  });

  // Decide between interactive (spinner) and verbose (raw stream)
  // mode. ADR 0013: spinner is default; `--verbose` and non-TTY
  // environments fall back to the live stream so CI logs and
  // builder-driven debugging stay intact.
  const progressOut = opts.progressOut ?? process.stderr;
  const interactive = (progressOut.isTTY ?? false) && !opts.verbose;
  const progress: ApplyProgress | null = interactive
    ? createApplyProgress({ out: progressOut, interactive: true })
    : null;

  // Loggers used inside the container section:
  //  - `containerLogger` carries status lines that must surface on
  //    screen (Features list, Traefik routing warning). In spinner
  //    mode these print above the spinner via println; in verbose
  //    mode they go through consola as before.
  //  - `internalLogger` is the chatter from compose pre-cleanup. In
  //    spinner mode it goes to the log file only — the spinner phase
  //    label already conveys "cleaning up". In verbose mode it goes
  //    to screen too.
  const containerLogger = progress
    ? progressTeeLogger(progress, applyLog.sink)
    : teeApplyLogger(logger, applyLog.sink);
  const internalLogger = progress
    ? logFileOnlyLogger(applyLog.sink)
    : containerLogger;

  // SIGINT cleanup. Without a handler, Ctrl+C leaves the spinner's
  // last frame stuck on screen (cursor mid-line, shell prompt glued
  // to it), the log file misses its last write-buffer chunk, and the
  // exit code is whatever Node defaults to. With the handler we stop
  // the spinner, write a final marker into the log, close it cleanly,
  // and exit with 130 (128 + SIGINT, conventional for Ctrl+C).
  //
  // The docker child is left to die from signal propagation — what
  // it leaves behind (half-created container, partial layer) is
  // cleaned up on the next `apply` via `--remove-existing-container`
  // / the compose pre-cleanup, so we do not try to undo it here.
  const onSigint = createSigintAbort({
    progress,
    out: progressOut,
    log: applyLog,
    formatLogPointer: (p) => dim(`log: ${prettyPath(p)}`),
    onExit: () => process.exit(130),
  });
  process.on('SIGINT', onSigint);

  let exitCode: number;
  try {
    // First-apply context: devcontainer-cli prints "Error fetching image
    // details: No manifest found for …" for multi-arch GHCR images, then
    // sits silent for ~1 min while Docker pulls the runtime image.
    // Both are non-fatal — the buildx step right after consumes the
    // image fine. In spinner mode the phase label ("starting container…")
    // covers this, so the warning lives in the log file only. In verbose
    // mode it stays on screen as before.
    const pullWarning =
      'Pulling runtime image and building feature layers. First apply takes ~1–2 min (Docker downloads the multi-arch base); subsequent applies are cached and fast. devcontainer-cli may log a "No manifest found" line — harmless, the pull continues.';
    if (progress) {
      applyLog.stream.write(`# note: ${pullWarning}\n\n`);
    } else {
      containerLogger.info(dim(pullWarning));
    }

    // Bring up the shared Traefik singleton ahead of the devcontainer
    // when the yml declares ports, and refresh the dynamic config so
    // the routes match whatever the yml currently says. `ensureProxy`
    // and `writeDynamicConfig` are both idempotent; a second
    // devcontainer that also wants Traefik just joins the already-
    // running proxy. See ADR 0007.
    const ports = createOpts.ports ?? [];
    const hasPorts = ports.length > 0;
    if (hasPorts) {
      // Pre-flight: bail with an actionable hint before `docker run`
      // tries to bind a held port. Throws on conflict — the message
      // names the routing.hostPort escape hatch and asks the builder
      // to either free the port or set a different one.
      await preflightHostPort(proxyHostPort(globalConfig), {
        ...(opts.proxyDocker ? { docker: opts.proxyDocker } : {}),
      });
    }

    try {
      if (hasPorts) {
        await writeDynamicConfig(opts.name, ports, { monocerosHome: home });
        await ensureProxy({
          ...(opts.proxyDocker ? { docker: opts.proxyDocker } : {}),
          monocerosHome: home,
          hostPort: proxyHostPort(globalConfig),
          logger: containerLogger,
        });
      } else {
        // `ports:` is empty (or was removed since the last apply) —
        // drop any stale dynamic-config file. Filesystem only; the
        // proxy itself is offered for teardown by stop/remove, not
        // here (apply ends with the container up, not stopped).
        await removeDynamicConfig(opts.name, { monocerosHome: home });
      }
    } catch (err) {
      // Don't strand the apply if Traefik bookkeeping fails — surface
      // as a warn and keep going. The devcontainer itself is still
      // usable; the builder loses only the `<name>.localhost` routing,
      // which the next apply / `add-port` will retry.
      containerLogger.warn?.(
        `Could not sync Traefik routes: ${err instanceof Error ? err.message : String(err)}. The container will start, but \`<name>.localhost\` routing may not work until the next \`monoceros apply\`.`,
      );
    }

    // Seed the spinner phase before the actual work so the builder
    // sees an immediate hint of what is happening. The stream-driven
    // triggers in apply-progress.ts take over once devcontainer-cli
    // starts emitting recognizable lines.
    if (progress) {
      progress.setPhase(
        needsCompose(createOpts)
          ? 'cleaning up previous containers…'
          : 'starting container…',
      );
    }

    exitCode = await runContainerCycle(targetDir, {
      hasCompose: needsCompose(createOpts),
      ...(opts.rebuild ? { noCache: true } : {}),
      prewarmImage: resolveRuntimeImage(createOpts.runtimeVersion),
      ...(opts.dockerExec !== undefined ? { dockerExec: opts.dockerExec } : {}),
      ...(opts.devcontainerSpawn !== undefined
        ? { devcontainerSpawn: opts.devcontainerSpawn }
        : {}),
      logSink: applyLog.sink,
      ...(progress ? { progressSink: progress.streamSink, silent: true } : {}),
      logger: internalLogger,
    });

    // Stop the spinner and surface the outcome. In spinner mode the
    // failure path also prints the captured tail (~15 last lines of the
    // devcontainer-cli stream) so the builder sees the actual error
    // without paging through the log file. In verbose mode the stream
    // was already on screen, so there is nothing to replay.
    if (progress) {
      if (exitCode === 0) {
        progress.succeed();
      } else {
        const { tailLines } = progress.fail();
        progressOut.write(`\n✘ apply failed (exit ${exitCode})\n\n`);
        for (const line of tailLines) {
          progressOut.write(`  ${line}\n`);
        }
        if (tailLines.length > 0) progressOut.write('\n');
      }
    }

    // Inventory block on success: shows the builder what their yml just
    // materialized (features, services, languages, repos, ports, apt
    // packages, install URLs). Replaces the cherry-picked "Features: …"
    // line that used to print above the spinner. Mirrored into the log
    // file with ANSI escapes stripped so `cat …apply-….log` stays
    // readable.
    if (exitCode === 0) {
      const summaryLines = buildApplySummary(createOpts);
      if (summaryLines.length > 0) {
        const formatted = formatApplySummary(summaryLines);
        progressOut.write(`\n${formatted}\n`);
        applyLog.stream.write(`\n${stripAnsi(formatted)}\n`);
      }

      // Record the image this apply built, so the upgrade prune can later
      // remove stale builds of this container — and never touch any image
      // Monoceros didn't record (ADR 0018). Best-effort: a docker hiccup here
      // must not fail an otherwise-successful apply.
      const now = opts.now ?? new Date();
      try {
        const imageId = await resolveContainerImageId(
          targetDir,
          opts.dockerExec ?? defaultDockerExec,
        );
        if (imageId) {
          await recordBuiltImage(
            { imageId, container: opts.name, builtAt: now.toISOString() },
            home,
          );
        }
      } catch {
        // ignore — recording is an optimization, not a correctness step
      }

      // Staleness nudge: when the last `monoceros upgrade` is older than the
      // threshold, remind the builder (non-blocking). Silent if no upgrade has
      // ever run — a freshly-built container is current by definition.
      const nudge = upgradeNudge(
        await readMachineState(home),
        now,
        globalConfig?.upgrade?.staleDays ?? DEFAULT_UPGRADE_STALE_DAYS,
      );
      if (nudge) {
        progressOut.write(`\n  ${dim(nudge)}\n`);
      }
    }

    // Close the log before announcing its path — guarantees the file
    // is fully flushed to disk by the time the builder follows the
    // pointer. The path is printed on both the success and failure
    // path; on failure it is the breadcrumb pointing at the full
    // diagnostic above what fits in the tail.
    //
    // Direct write rather than `logger.info` — the default consola
    // logger prefixes info lines with a timestamp, which collides with
    // the structured look of the section. The leading blank line
    // separates the pointer from the summary block above.
    await applyLog.close();
    progressOut.write(`\n  ${dim(`log: ${prettyPath(applyLog.path)}`)}\n`);

    // ── Next steps ───────────────────────────────────────────────
    // Only print the wrap-up on a successful container start;
    // otherwise the failing devcontainer-cli output is the relevant
    // signal and a cheery "shell into it!" line would be misleading.
    if (exitCode === 0) {
      section('Next steps');
      logger.info(`  ${cyan(`monoceros shell ${opts.name}`)}`);
    }
  } finally {
    process.off('SIGINT', onSigint);
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

/**
 * Persist an identity that came from the interactive prompt. Called
 * with the builder's scope pick (`g`/`c`/`b`); logs to the apply
 * stream where the values landed (or why they couldn't, e.g. global
 * default was already set and we left it alone).
 *
 * Pulled out of runApply for readability — runApply already carries
 * a lot of pre-flight ceremony, and this is a self-contained
 * persistence step.
 */
async function persistPromptedIdentity(
  prompted: { name: string; email: string; scope: 'g' | 'c' | 'b' },
  ymlPath: string,
  home: string,
  logger: {
    info: (msg: string) => void;
    warn?: (msg: string) => void;
  },
): Promise<void> {
  const wantGlobal = prompted.scope === 'g' || prompted.scope === 'b';
  const wantContainer = prompted.scope === 'c' || prompted.scope === 'b';

  if (wantGlobal) {
    try {
      const result = await writeGlobalDefaultGitUser(
        { name: prompted.name, email: prompted.email },
        { monocerosHome: home },
      );
      if (result.alreadySet) {
        logger.warn?.(
          `monoceros-config.yml already has a defaults.git.user — left it alone. To replace, edit ${prettyPath(result.filePath)} by hand.`,
        );
      } else if (result.created) {
        logger.info(
          `Saved identity globally — created ${prettyPath(result.filePath)} with defaults.git.user.`,
        );
      } else {
        logger.info(
          `Saved identity globally — wrote defaults.git.user into ${prettyPath(result.filePath)}.`,
        );
      }
    } catch (err) {
      logger.warn?.(
        `Could not persist identity to monoceros-config.yml: ${err instanceof Error ? err.message : String(err)}. The values are still active for this apply via .monoceros/gitconfig.`,
      );
    }
  }

  if (wantContainer) {
    try {
      const text = await fs.readFile(ymlPath, 'utf8');
      const parsed = parseConfig(text, ymlPath);
      const changed = setContainerGitUserInDoc(parsed.doc, {
        name: prompted.name,
        email: prompted.email,
      });
      if (changed) {
        const out = stringifyConfig(parsed.doc);
        await fs.writeFile(ymlPath, out, 'utf8');
        logger.info(
          `Saved identity in this container — wrote git.user into ${prettyPath(ymlPath)}.`,
        );
      }
    } catch (err) {
      logger.warn?.(
        `Could not persist identity to ${prettyPath(ymlPath)}: ${err instanceof Error ? err.message : String(err)}. The values are still active for this apply via .monoceros/gitconfig.`,
      );
    }
  }
}
