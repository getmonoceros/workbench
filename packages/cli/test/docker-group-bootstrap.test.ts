import { describe, expect, it, vi } from 'vitest';
import { bootstrapDockerGroup } from '../src/devcontainer/docker-group-bootstrap.js';

describe('bootstrapDockerGroup', () => {
  it('no-ops on non-linux platforms (Mac / Windows use different access)', () => {
    const reexec = vi.fn(() => 0);
    bootstrapDockerGroup({
      platform: 'darwin',
      reexec,
      runProbe: () => 1,
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  it('no-ops when the re-exec marker is already set (loop guard)', () => {
    const reexec = vi.fn(() => 0);
    bootstrapDockerGroup({
      platform: 'linux',
      marker: '1',
      reexec,
      runProbe: () => 1,
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  it('no-ops when docker is not installed at all', () => {
    // docker --version exit 127 = command not found → bail early,
    // nothing to recover. The downstream "install docker" error
    // will guide the user.
    const reexec = vi.fn(() => 0);
    bootstrapDockerGroup({
      platform: 'linux',
      reexec,
      runProbe: (cmd, args) => {
        if (cmd === 'docker' && args[0] === '--version') return 127;
        return 0;
      },
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  it('no-ops when docker info already works (group is loaded fine)', () => {
    const reexec = vi.fn(() => 0);
    bootstrapDockerGroup({
      platform: 'linux',
      reexec,
      runProbe: (cmd, args) => {
        if (cmd === 'docker' && args[0] === '--version') return 0;
        if (cmd === 'docker' && args[0] === 'info') return 0;
        return 1;
      },
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  // The "docker info fails + user IS in /etc/group docker → re-exec"
  // path can't be tested in isolation without actually shelling out
  // to `getent`, which we don't want to require on the test host.
  // The `isInDockerGroupViaEtcGroup` internals use spawnSync directly
  // and aren't injection-mocked — that's a known coverage gap. The
  // integration test in apply-yml.test.ts exercises the no-op path
  // (rootless / rootful detection coexists with this bootstrap), and
  // the "marker prevents loop" test above verifies the safety guard.

  it('does not exit when no recovery is possible', () => {
    // Even if docker info fails, if the marker is already set we
    // must not re-exec. process.exit would terminate the test
    // process, so this also verifies we never call exit in the
    // no-op paths.
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as never);
    try {
      bootstrapDockerGroup({
        platform: 'linux',
        marker: '1',
        runProbe: () => 1,
        reexec: () => 0,
      });
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});
