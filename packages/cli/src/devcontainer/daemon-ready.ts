import { type DockerExec, defaultDockerExec } from '../proxy/index.js';

/**
 * Bounded wait until the Docker daemon answers a trivial `docker ps`.
 *
 * Absorbs the Docker Desktop / WSL2 cold-start window: on the very
 * first apply after the daemon spins up, the first few docker calls can
 * fail transiently with an empty-stderr `exit 1` even though the daemon
 * is nearly ready. That blip is exactly what sinks the proxy-network
 * `docker network create` and devcontainer-cli's own `docker ps` on a
 * fresh Windows/WSL apply — both recover the moment the caller retries.
 *
 * `docker ps` (not `docker info`) is the probe on purpose: it is the
 * same class of command that fails during the race, so a green probe is
 * a real "the next docker step will work" signal.
 *
 * Returns `true` once the daemon answers, `false` if the budget is
 * exhausted. A `false` result is deliberately NOT fatal — the caller
 * proceeds and the real docker call surfaces a clear error, so a
 * genuinely-down daemon behaves exactly as before; only the cold-start
 * blip is smoothed over.
 */
export interface WaitForDockerDaemonOptions {
  /** Docker exec (injected by tests). Defaults to the real spawn. */
  exec?: DockerExec;
  /** Max probe attempts. Default 12. */
  attempts?: number;
  /** Delay between attempts in ms. Default 500 (≈6s total budget). */
  delayMs?: number;
  /** Sleep (injected by tests to avoid real timers). */
  sleep?: (ms: number) => Promise<void>;
  /** Called once, on the first failed probe, so the caller can log a wait hint. */
  onWait?: () => void;
}

export async function waitForDockerDaemon(
  options: WaitForDockerDaemonOptions = {},
): Promise<boolean> {
  const exec = options.exec ?? defaultDockerExec;
  const attempts = options.attempts ?? 12;
  const delayMs = options.delayMs ?? 500;
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await exec(['ps', '-q']);
      if (result.exitCode === 0) return true;
    } catch {
      // A spawn error (docker binary momentarily unavailable during the
      // WSL integration handshake) is just another not-ready signal.
    }
    if (attempt === 0) options.onWait?.();
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return false;
}
