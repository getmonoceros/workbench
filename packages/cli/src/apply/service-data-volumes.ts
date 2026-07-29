import fs from 'node:fs/promises';
import path from 'node:path';

import type { DockerExec } from '../proxy/index.js';
import { serviceDataVolume } from '../create/scaffold.js';
import { composeProjectName } from '../devcontainer/compose.js';
import type { ResolvedService } from '../create/types.js';

// Same throw-away copy image `remove` uses for its root-owned-files
// fallback. Pinned, tiny, and `cp -a` is all we need from it.
const COPY_IMAGE = 'alpine:3.21';

/**
 * One-time migration of a pre-ADR-0036 container's service data.
 *
 * Until 1.41.x a service's data files lived in a host bind mount at
 * `<container-dir>/data/<svc>/`; they now live in the docker volume
 * `monoceros-<name>-data-<svc>`. Existing containers therefore carry a
 * populated host directory and an empty volume, and starting them without
 * this step would present the service an empty data directory, a database
 * that looks wiped. So: when the volume does not exist yet and the old
 * host directory has content, create the volume and copy the content in.
 *
 * The copy runs in a throw-away container, not in Node, for two reasons:
 * the volume is only reachable from inside docker, and the files are owned
 * by the service's uid (root, 999, …), which the unprivileged monoceros
 * process cannot read on Linux. `cp -a` keeps ownership and modes, which
 * is the whole point: the engine checks them on start.
 *
 * The service is stopped first. At this point in apply the PREVIOUS
 * container generation is still up (compose services carry
 * `restart: unless-stopped`, and `devcontainer up` only recreates them
 * later), so it still holds the old bind mount open. Copying a live
 * database directory file by file yields a torn cluster, not even a
 * crash-consistent one. `docker stop` gives the engine its normal
 * shutdown, which is exactly what makes the copy safe to start from.
 *
 * The old host directory is left in place. Deleting a builder's database
 * on their behalf is not this command's business; the ADR says to remove
 * it once the container is verified. Re-running apply is a no-op: the
 * volume now exists and is never touched again.
 *
 * The same path restores a backup: `monoceros restore` writes
 * `data/<svc>/` back as a plain directory, and the next apply moves it
 * into the volume from there.
 */
export async function migrateServiceDataVolumes(opts: {
  name: string;
  targetDir: string;
  services: readonly ResolvedService[];
  dockerExec: DockerExec;
  logger: { info: (msg: string) => void; warn?: (msg: string) => void };
}): Promise<void> {
  const { name, targetDir, services, dockerExec, logger } = opts;
  for (const svc of services) {
    if (!svc.volumes.some((v) => v.split(':')[0] === 'data')) continue;
    const hostDir = path.join(targetDir, 'data', svc.name);
    if (!(await hasContent(hostDir))) continue;
    const volume = serviceDataVolume(name, svc.name);
    if (await volumeExists(volume, dockerExec)) continue;

    logger.info(
      `Migrating ${svc.name} data from data/${svc.name}/ into the docker volume ${volume}…`,
    );
    await stopService(targetDir, svc.name, dockerExec);
    const created = await dockerExec(['volume', 'create', volume]);
    if (created.exitCode !== 0) {
      throw new Error(
        `Could not create the data volume ${volume} for service '${svc.name}'` +
          `${created.stderr.trim() ? `: ${created.stderr.trim()}` : ''}.`,
      );
    }
    const copied = await dockerExec([
      'run',
      '--rm',
      '-v',
      `${hostDir}:/src:ro`,
      '-v',
      `${volume}:/dst`,
      COPY_IMAGE,
      'sh',
      '-c',
      'cp -a /src/. /dst/',
    ]);
    if (copied.exitCode !== 0) {
      // Leave no half-filled volume behind: the next apply would see it,
      // skip the migration and start the service on a truncated database.
      await dockerExec(['volume', 'rm', '-f', volume]);
      throw new Error(
        `Could not copy data/${svc.name}/ into the volume ${volume}` +
          `${copied.stderr.trim() ? `: ${copied.stderr.trim()}` : ''}. ` +
          `The old directory is untouched; re-run apply to retry.`,
      );
    }
    logger.info(
      `${svc.name} data migrated. Once the container is up and the data is there, ` +
        `you can delete data/${svc.name}/.`,
    );
  }
}

/**
 * Stop the still-running container of one compose service so its data
 * directory is quiescent for the copy. Filters on the compose project +
 * service labels, so it hits this container's service and nothing else,
 * and no-ops when the service isn't running. `docker stop` sends SIGTERM,
 * which a database turns into its ordinary shutdown; the following
 * `devcontainer up` brings the service back on the volume.
 */
async function stopService(
  targetDir: string,
  serviceName: string,
  dockerExec: DockerExec,
): Promise<void> {
  const project = composeProjectName(targetDir);
  const { stdout, exitCode } = await dockerExec([
    'ps',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    `label=com.docker.compose.service=${serviceName}`,
  ]);
  if (exitCode !== 0) return;
  const ids = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (ids.length === 0) return;
  await dockerExec(['stop', ...ids]);
}

/** True when the path is a directory with at least one entry. */
async function hasContent(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function volumeExists(
  volume: string,
  dockerExec: DockerExec,
): Promise<boolean> {
  const { exitCode } = await dockerExec(['volume', 'inspect', volume]);
  return exitCode === 0;
}
