import { spawn } from 'node:child_process';

/**
 * Find the running docker container that hosts a Monoceros
 * dev-container. The lookup is by the `devcontainer.local_folder`
 * label devcontainer-cli attaches at `up` time — that label is the
 * absolute host path of the materialized container directory, which
 * is the only stable handle (the container name itself is random for
 * image-mode, e.g. `thirsty_bartik`).
 *
 * Returns the container id (12-char prefix as docker prints it) or
 * `null` when nothing matches. `null` is the normal "container not
 * up yet" signal; callers should treat it as "fall back to yml-only,
 * suggest `monoceros apply`".
 */

export interface RunningContainerLookupOptions {
  /** Override the docker exec used to query — tests inject a fake. */
  docker?: DockerLookupExec;
}

export type DockerLookupExec = (
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export const realDockerLookup: DockerLookupExec = (args) => {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args as string[], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      resolve({ stdout, stderr, exitCode: code ?? 0 }),
    );
  });
};

/**
 * Look up the running container by its `devcontainer.local_folder`
 * label. `containerPath` must be the absolute path of the
 * materialized container dir (e.g. `~/.monoceros/container/sandbox`).
 */
export async function findRunningContainerByLocalFolder(
  containerPath: string,
  opts: RunningContainerLookupOptions = {},
): Promise<string | null> {
  const docker = opts.docker ?? realDockerLookup;
  const result = await docker([
    'ps',
    '-q',
    '--filter',
    `label=devcontainer.local_folder=${containerPath}`,
    '--filter',
    'status=running',
  ]);
  if (result.exitCode !== 0) return null;
  const ids = result.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids[0] ?? null;
}

/**
 * `docker exec` wrapper for in-container commands triggered by
 * `add-repo --clone-now`. Streams stdout/stderr to the parent
 * process by default so a `git clone` progress bar shows up live —
 * the spawn override lets tests capture instead.
 */
export type ContainerExec = (
  containerId: string,
  argv: readonly string[],
) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;

export const realContainerExec: ContainerExec = (containerId, argv) => {
  return new Promise((resolve, reject) => {
    // `docker exec` runs as the image's USER (root), bypassing both the
    // entrypoint's gosu drop and the devcontainer `remoteUser`. Force `node`
    // so monoceros-ctl - and the app servers it spawns - run as the same
    // non-root user as interactive shells, keeping pid files, logs and the
    // processes themselves owned by `node`, not root.
    const child = spawn(
      'docker',
      ['exec', '-u', 'node', containerId, ...argv],
      {
        // Inherit stdio so live git output reaches the user.
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    );
    child.on('error', reject);
    child.on('exit', (code) => resolve({ exitCode: code ?? 0 }));
  });
};
