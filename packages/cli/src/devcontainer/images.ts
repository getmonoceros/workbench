import { type DockerExec } from '../proxy/index.js';
import { findContainerIds, spawnDocker } from './compose.js';

/**
 * Resolve the image id of the devcontainer rooted at `root`. The
 * devcontainer CLI labels every workspace container it creates with
 * `devcontainer.local_folder=<workspace path>`, so we find the container by
 * that label and inspect its image. Returns null when no such container exists
 * or docker is unreachable — callers treat recording as best-effort.
 */
export async function resolveContainerImageId(
  root: string,
  exec: DockerExec = spawnDocker,
): Promise<string | null> {
  const ids = await findContainerIds(
    [`label=devcontainer.local_folder=${root}`],
    exec,
  );
  const containerId = ids[0];
  if (!containerId) return null;
  const res = await exec(['inspect', '--format', '{{.Image}}', containerId]);
  if (res.exitCode !== 0) return null;
  const imageId = res.stdout.trim();
  return imageId || null;
}

export type RemoveImageOutcome = 'removed' | 'absent' | 'in-use' | 'error';

/**
 * `docker rmi <imageId>`. Best-effort and never throws. Distinguishes:
 *   - `removed`: gone now (we deleted it)
 *   - `absent`:  already gone (no such image) — also safe to forget
 *   - `in-use`:  still referenced by a container — keep tracking it
 *   - `error`:   docker unreachable / anything else — keep tracking it
 * The prune drops `removed`/`absent` from the registry and retries the rest.
 */
export async function removeImage(
  imageId: string,
  exec: DockerExec = spawnDocker,
): Promise<RemoveImageOutcome> {
  try {
    const res = await exec(['rmi', imageId]);
    if (res.exitCode === 0) return 'removed';
    const err = (res.stderr ?? '').toLowerCase();
    if (err.includes('no such image')) return 'absent';
    if (
      err.includes('is being used') ||
      err.includes('conflict') ||
      err.includes('in use')
    ) {
      return 'in-use';
    }
    return 'error';
  } catch {
    return 'error';
  }
}
