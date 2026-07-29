import fs from 'node:fs/promises';
import path from 'node:path';

import type { DockerExec } from '../devcontainer/compose.js';

// Same throw-away copy image the backup/delete fallbacks in remove use.
const COPY_IMAGE = 'alpine:3.21';

export interface ServiceDataVolume {
  /** Compose service the volume belongs to (`postgres`, `redis`, …). */
  service: string;
  /** Docker volume name (`monoceros-<container>-<service>-data`). */
  volume: string;
}

/**
 * The container's service data volumes, read out of its generated
 * `compose.yaml`.
 *
 * The compose file is the authoritative list: it is what actually got
 * applied, so it names exactly the volumes that exist. Deriving them from
 * `docker volume ls` instead would need a substring match over every
 * volume on the machine, which cannot tell container `foo` service
 * `bar-db` from container `foo-bar` service `db`. No compose file means
 * the container was never applied, so there is nothing to find.
 *
 * `monoceros-<container>-data-` is a fixed prefix and everything after it
 * is the service name (see `serviceDataVolume`), so a dashed service name
 * survives and the IDE-state volumes, `…-jetbrains-data` among them,
 * are not mistaken for service data.
 */
export async function composeServiceDataVolumes(
  containerPath: string,
  containerName: string,
): Promise<ServiceDataVolume[]> {
  let text: string;
  try {
    text = await fs.readFile(
      path.join(containerPath, '.devcontainer', 'compose.yaml'),
      'utf8',
    );
  } catch {
    return [];
  }
  const prefix = `monoceros-${containerName}-data-`;
  const found: ServiceDataVolume[] = [];
  // Top-level `volumes:` entries are emitted as `  <name>:` (two spaces)
  // followed by a pinned `    name: <name>`; match the key line.
  for (const line of text.split('\n')) {
    const match = /^ {2}(\S+):$/.exec(line);
    const volume = match?.[1];
    if (!volume || !volume.startsWith(prefix)) continue;
    const service = volume.slice(prefix.length);
    if (service) found.push({ service, volume });
  }
  return found;
}

/**
 * Copy each data volume's content into the backup as a plain directory at
 * `<backup>/container/data/<service>/`.
 *
 * Same layout the pre-ADR-0036 bind mount produced, which keeps two
 * promises: a backup stays a readable directory tree (no volume export
 * format, no docker needed to look inside), and `restore` plus the next
 * `apply` put it back without a special case: apply's
 * `migrateServiceDataVolumes` copies exactly this path into the volume.
 *
 * Runs in a throw-away container: the volume is only reachable from inside
 * docker, and `cp -a` preserves the ownership the engine checks on start.
 * Best-effort per volume: a failed copy is reported and the remove
 * continues, because the alternative is stranding the whole teardown.
 */
export async function backupServiceDataVolumes(opts: {
  volumes: readonly ServiceDataVolume[];
  backupContainerDir: string;
  dockerExec: DockerExec;
  logger: { info: (msg: string) => void; warn?: (msg: string) => void };
}): Promise<void> {
  const { volumes, backupContainerDir, dockerExec, logger } = opts;
  for (const { service, volume } of volumes) {
    const dst = path.join(backupContainerDir, 'data', service);
    await fs.mkdir(dst, { recursive: true });
    const { exitCode, stderr } = await dockerExec([
      'run',
      '--rm',
      '-v',
      `${volume}:/src:ro`,
      '-v',
      `${dst}:/dst`,
      COPY_IMAGE,
      'sh',
      '-c',
      'cp -a /src/. /dst/',
    ]);
    if (exitCode !== 0) {
      (logger.warn ?? logger.info)(
        `[remove] could not back up the ${service} data volume ${volume}` +
          `${stderr.trim() ? `: ${stderr.trim()}` : ''}. Continuing.`,
      );
      continue;
    }
    logger.info(
      `[remove] ${service} data volume backed up to data/${service}/.`,
    );
  }
}
