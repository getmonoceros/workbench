import { describe, expect, it, vi } from 'vitest';
import { waitForDockerDaemon } from '../src/devcontainer/daemon-ready.js';

const ok = { exitCode: 0, stdout: '', stderr: '' };
const fail = { exitCode: 1, stdout: '', stderr: '' };

describe('waitForDockerDaemon', () => {
  it('returns true immediately when the daemon answers on the first probe', async () => {
    const exec = vi.fn(async () => ok);
    const sleep = vi.fn(async () => {});
    const ready = await waitForDockerDaemon({ exec, sleep });
    expect(ready).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries through the cold-start blip and returns true once it recovers', async () => {
    // Two empty-stderr exit-1 failures (the WSL cold-start race), then ok.
    let calls = 0;
    const exec = vi.fn(async () => (++calls < 3 ? fail : ok));
    const sleep = vi.fn(async () => {});
    const onWait = vi.fn();
    const ready = await waitForDockerDaemon({ exec, sleep, onWait });
    expect(ready).toBe(true);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    // onWait fires once, on the first failed probe.
    expect(onWait).toHaveBeenCalledTimes(1);
  });

  it('treats a spawn error as not-ready and keeps retrying', async () => {
    let calls = 0;
    const exec = vi.fn(async () => {
      if (++calls < 2) throw new Error('spawn docker ENOENT');
      return ok;
    });
    const ready = await waitForDockerDaemon({ exec, sleep: async () => {} });
    expect(ready).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('returns false when the budget is exhausted without giving up fatally', async () => {
    const exec = vi.fn(async () => fail);
    const sleep = vi.fn(async () => {});
    const ready = await waitForDockerDaemon({
      exec,
      sleep,
      attempts: 3,
      delayMs: 10,
    });
    expect(ready).toBe(false);
    expect(exec).toHaveBeenCalledTimes(3);
    // Sleeps between attempts only — not after the last one.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('probes with `docker ps` (the command that fails during the race)', async () => {
    const exec = vi.fn(async () => ok);
    await waitForDockerDaemon({ exec, sleep: async () => {} });
    expect(exec).toHaveBeenCalledWith(['ps', '-q']);
  });
});
