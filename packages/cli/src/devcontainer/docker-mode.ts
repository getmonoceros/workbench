import { spawn } from 'node:child_process';
import { cyan } from '../util/format.js';

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

/**
 * Builder-facing error rendered when we detect rootless Docker.
 * Kept user-friendly on purpose — no "UID shift" / "subuid" jargon.
 * Frames the consequence ("files you create in the container can't
 * be edited from your host") rather than the cause, and gives the
 * exact switch-to-rootful command block. install.sh duplicates this
 * text in bash (deliberately — we can't share strings across
 * runtimes without ceremony).
 */
export function formatRootlessNotSupportedError(): string {
  return [
    `Monoceros requires Docker in "rootful" mode.`,
    ``,
    `You're running Docker in "rootless" mode right now. That setup`,
    `runs the daemon without root privileges — sounds safer, but it`,
    `remaps user IDs between your host and the container in a way`,
    `that prevents the container from writing into the directories`,
    `Monoceros mounts into it. Cloning your repos, running`,
    `\`npm install\`, building — all fail with permission errors at`,
    `the first attempt.`,
    ``,
    `To fix, switch back to standard rootful Docker:`,
    ``,
    cyan(
      `  systemctl --user stop docker.service docker.socket 2>/dev/null || true`,
    ),
    cyan(`  dockerd-rootless-setuptool.sh uninstall`),
    cyan(`  rootlesskit rm -rf ~/.local/share/docker`),
    cyan(`  unset DOCKER_HOST DOCKER_CONTEXT`),
    cyan(`  sudo systemctl enable --now docker`),
    cyan(`  sudo usermod -aG docker $USER`),
    ``,
    `If you added DOCKER_HOST or DOCKER_CONTEXT to ~/.bashrc /`,
    `~/.profile (the rootless setup may have suggested it), remove`,
    `those lines too — the 'unset' above only affects your current`,
    `shell. Otherwise new terminals keep pointing at the rootless`,
    `socket and Monoceros's auto-recovery has nothing to fall back to.`,
    ``,
    `Then re-run. Background: see ${cyan('docs/docker-on-linux.md')} in`,
    `the workbench repo.`,
  ].join('\n');
}
