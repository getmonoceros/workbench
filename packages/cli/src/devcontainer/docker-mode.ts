import { spawn } from 'node:child_process';

/**
 * Whether the host's docker daemon runs as root (rootful) or under a
 * user namespace (rootless). The mode decides whether bind-mounts
 * need the `idmap` option.
 *
 * Why this matters: in rootless Docker the host user's UID is mapped
 * to container UID 0 (root), and the container's non-root user
 * (uid 1000 inside) lives at a shifted host UID (uid 65536+1000+ via
 * /etc/subuid). Without `idmap`, files written by either side end up
 * with the wrong ownership on the other — host can't read what the
 * container created, container's node user can't write into what the
 * host pre-created (which is what bit M5 testing on Ubuntu rootless).
 *
 * The Linux kernel supports `idmap` as a bind-mount option since 5.12;
 * Docker exposes it since 25.x. Ubuntu 24.04 and other modern distros
 * are well past both. Older kernels (RHEL 8 with 4.18) would fail the
 * mount with an "unsupported" error — accepted trade-off, the error
 * surfaces clearly.
 *
 * On macOS / Windows Docker Desktop, idmap is a no-op at best and a
 * mount-error at worst because those platforms use their own
 * file-sharing layer (VirtioFS / WSL2 + Plan9) instead of native
 * Linux bind mounts. We MUST only emit idmap when the daemon is
 * actually rootless on Linux — otherwise we'd break the working
 * Mac/Windows cases.
 */
export type DockerMode = 'rootful' | 'rootless';

/**
 * Spawn signature for `docker info`. Returns stdout + exit code.
 * Injected by tests.
 */
export type DockerInfoSpawn = () => Promise<{
  stdout: string;
  exitCode: number;
}>;

const realDockerInfo: DockerInfoSpawn = () => {
  return new Promise((resolve, reject) => {
    // `--format '{{json .SecurityOptions}}'` returns a JSON array like
    // `["name=seccomp,profile=builtin","name=rootless"]` on rootless,
    // or `["name=seccomp,profile=builtin"]` on rootful. Cheaper to
    // parse than the full human-readable `docker info` output.
    const child = spawn(
      'docker',
      ['info', '--format', '{{json .SecurityOptions}}'],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ stdout, exitCode: code ?? 0 }));
  });
};

/**
 * Probe the host docker daemon and return its mode. Defaults to
 * `'rootful'` whenever we can't reliably determine otherwise — the
 * downstream `docker run` would surface a clearer error if the
 * daemon is unreachable, so we don't pre-emptively fail here.
 */
export async function detectDockerMode(
  options: { spawn?: DockerInfoSpawn } = {},
): Promise<DockerMode> {
  const spawnFn = options.spawn ?? realDockerInfo;
  try {
    const result = await spawnFn();
    if (result.exitCode !== 0) return 'rootful';
    // Match both the bare `rootless` token and the modern
    // `name=rootless` form. Case-insensitive to be defensive against
    // future docker output tweaks.
    return /\brootless\b/i.test(result.stdout) ? 'rootless' : 'rootful';
  } catch {
    return 'rootful';
  }
}
