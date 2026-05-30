import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import {
  containerConfigPath,
  containerDir,
  monocerosHome as defaultMonocerosHome,
  prettyPath,
} from '../config/paths.js';
import { REGEX } from '../config/schema.js';
import {
  composeProjectName,
  spawnBash,
  type ComposeSpawn,
} from '../devcontainer/compose.js';
import { maybeStopProxy, type DockerExec } from '../proxy/index.js';
import { removeDynamicConfig } from '../proxy/dynamic.js';

/**
 * `monoceros remove <name>` — wipe everything belonging to one
 * container.
 *
 * What "everything" means in practice (in this order):
 *
 *   1. Stop and remove docker objects scoped to the container:
 *        - compose containers (label `com.docker.compose.project=<project>`)
 *        - any image-mode container matching `vsc-<name>-*`
 *        - the project network `<project>_default`
 *      Named docker volumes are no longer used as of fea2b3f (DB data
 *      is bind-mounted onto `<container-dir>/data/<svc>/`), so they
 *      go away with the directory delete below.
 *
 *   2. Optionally back up the host-side state:
 *        - `container-configs/<name>.yml`
 *        - `container/<name>/` (entire scaffold incl. `home/`,
 *          `projects/`, `.monoceros/`, `data/`)
 *      Lands at `container-backups/<name>-<timestamp>/`. Plain
 *      directory copy — readable with normal filesystem tools.
 *
 *   3. Delete the host-side state.
 *
 * Shared docker images (`monoceros-runtime:dev`, feature build
 * images, postgres/mysql/redis base images) are NOT removed — they
 * are shared across containers and pruning them is a separate
 * operation the builder can do with `docker image prune` when they
 * actually want to free that disk.
 */

export interface RunRemoveOptions {
  name: string;
  /** When true, skip the backup step. */
  noBackup?: boolean;
  /** Override of the user-data home. Tests inject a tmpdir. */
  monocerosHome?: string;
  /** Override the timestamp embedded in the backup directory name. */
  now?: Date;
  /** Bash spawn for the docker cleanup script. Tests inject a stub. */
  dockerSpawn?: ComposeSpawn;
  /** Override the docker exec used by the Traefik proxy lifecycle. */
  proxyDocker?: DockerExec;
  logger?: {
    info: (msg: string) => void;
    success: (msg: string) => void;
    warn?: (msg: string) => void;
  };
}

export interface RunRemoveResult {
  /** Path the yml was at before deletion, or `null` if it didn't exist. */
  configPath: string | null;
  /** Path the container scaffold was at before deletion, or `null`. */
  containerPath: string | null;
  /** Directory of the backup, or `null` when --no-backup was passed. */
  backupPath: string | null;
  /** Exit code of the docker cleanup step (0 on success). */
  dockerExitCode: number;
}

export async function runRemove(
  opts: RunRemoveOptions,
): Promise<RunRemoveResult> {
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
  const containerPath = containerDir(opts.name, home);
  const hasYml = existsSync(ymlPath);
  const hasContainer = existsSync(containerPath);

  if (!hasYml && !hasContainer) {
    throw new Error(
      `Nothing to remove for '${opts.name}': neither ${ymlPath} nor ${containerPath} exists.`,
    );
  }

  // ── Step 1: stop + remove docker objects ────────────────────────
  const projectName = composeProjectName(containerPath);
  const dockerSpawn = opts.dockerSpawn ?? spawnBash;
  const script = [
    `set -u`,
    `echo "[remove] tearing down docker project ${projectName}…"`,
    // Compose-mode containers, identified by the compose project label.
    `by_label=$(docker ps -aq --filter "label=com.docker.compose.project=${projectName}" 2>/dev/null || true)`,
    // Devcontainer-cli containers (image-mode workspace + feature-
    // build intermediates) all carry this label, value = the absolute
    // container-dir path. Most reliable anchor we have, because
    // @devcontainers/cli lets Docker assign random names like
    // 'kind_cerf' — neither the project-name nor the vsc-<name>-
    // prefix filters below catch those.
    `by_dc_label=$(docker ps -aq --filter "label=devcontainer.local_folder=${containerPath}" 2>/dev/null || true)`,
    // Container-name prefix fallback (catches half-broken state).
    `by_compose_name=$(docker ps -aq --filter "name=^${projectName}-" 2>/dev/null || true)`,
    // Image-mode devcontainer-cli name fallback (only kicks in when
    // the cli used a deterministic name — modern versions don't).
    `by_image_name=$(docker ps -aq --filter "name=^vsc-${opts.name}-" 2>/dev/null || true)`,
    `to_remove=$(printf "%s\\n%s\\n%s\\n%s\\n" "$by_label" "$by_dc_label" "$by_compose_name" "$by_image_name" | sort -u | grep -v "^$" || true)`,
    `if [ -n "$to_remove" ]; then echo "[remove] removing containers: $(echo $to_remove | tr "\\n" " ")"; docker rm -f $to_remove >/dev/null || true; else echo "[remove] no containers found"; fi`,
    `docker network rm ${projectName}_default 2>/dev/null && echo "[remove] network ${projectName}_default removed" || true`,
    `echo "[remove] docker cleanup done"`,
  ].join('; ');
  const dockerExitCode = await dockerSpawn(['-c', script], home);

  // ── Step 2: optional backup ────────────────────────────────────
  let backupPath: string | null = null;
  if (!opts.noBackup && (hasYml || hasContainer)) {
    const ts = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
    backupPath = path.join(home, 'container-backups', `${opts.name}-${ts}`);
    await fs.mkdir(backupPath, { recursive: true });
    if (hasYml) {
      await fs.copyFile(ymlPath, path.join(backupPath, `${opts.name}.yml`));
    }
    if (hasContainer) {
      await fs.cp(containerPath, path.join(backupPath, 'container'), {
        recursive: true,
      });
    }
    logger.info(`Backup written to ${prettyPath(backupPath)}.`);
  }

  // ── Step 3: delete host-side state ─────────────────────────────
  if (hasYml) {
    await fs.rm(ymlPath, { force: true });
  }
  if (hasContainer) {
    try {
      await fs.rm(containerPath, { recursive: true, force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM') {
        throw err;
      }
      // Linux + rootful Docker quirk: bind-mounted service data
      // dirs (postgres, mysql, …) end up owned by the container
      // process's UID — root for the official postgres image. The
      // unprivileged monoceros process can't unlink them.
      //
      // Fall back to docker as the cleanup actor: alpine runs as
      // root, mounts the target dir, deletes everything inside.
      // After that the host-side rm clears the now-empty parent.
      //
      // macOS / Docker Desktop / rootless Docker never hit this
      // branch — the happy fs.rm above succeeds because files are
      // user-owned through the VM / userns layer.
      logger.info(
        `[remove] host-side rm hit ${code} on ${prettyPath(containerPath)}; using a throw-away alpine container to clean root-owned files…`,
      );
      const exit = await dockerSpawn(
        [
          '-c',
          `docker run --rm -v "${containerPath}":/target alpine:3.21 find /target -mindepth 1 -delete`,
        ],
        home,
      );
      if (exit !== 0) {
        throw new Error(
          `docker-based cleanup of ${containerPath} exited ${exit}. Inspect with \`sudo ls -la ${containerPath}\` and clean manually.`,
        );
      }
      await fs.rm(containerPath, { recursive: true, force: true });
    }
  }

  logger.success(
    `Removed '${opts.name}': docker objects gone, container-configs entry deleted, container directory deleted.`,
  );
  if (!backupPath) {
    logger.warn?.(
      'No backup created (--no-backup). The host-side state is gone for good.',
    );
  }

  // Drop the container's Traefik dynamic-config file so a future
  // container with the same yml-name (re-init after remove) starts
  // with a clean slate. No-op when the file is absent.
  try {
    await removeDynamicConfig(opts.name, { monocerosHome: home });
  } catch (err) {
    logger.warn?.(
      `Could not remove Traefik dynamic config for ${opts.name}: ${err instanceof Error ? err.message : String(err)}. Ignored.`,
    );
  }

  // Tear down the Traefik singleton if this was the last container
  // attached to its network. See ADR 0007 (variant A — stop and
  // remove are treated identically).
  try {
    await maybeStopProxy({
      ...(opts.proxyDocker ? { docker: opts.proxyDocker } : {}),
      monocerosHome: home,
      logger: { info: (msg) => logger.info(msg), warn: logger.warn },
    });
  } catch (err) {
    logger.warn?.(
      `Could not tear down the Traefik proxy: ${err instanceof Error ? err.message : String(err)}. Ignored.`,
    );
  }

  return {
    configPath: hasYml ? ymlPath : null,
    containerPath: hasContainer ? containerPath : null,
    backupPath,
    dockerExitCode,
  };
}
