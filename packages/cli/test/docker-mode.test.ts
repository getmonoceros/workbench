import { describe, expect, it } from 'vitest';
import { detectDockerMode } from '../src/devcontainer/docker-mode.js';

describe('detectDockerMode', () => {
  it('returns "rootless" when SecurityOptions includes name=rootless', async () => {
    const mode = await detectDockerMode({
      spawn: async () => ({
        stdout: '["name=seccomp,profile=builtin","name=rootless"]',
        exitCode: 0,
      }),
    });
    expect(mode).toBe('rootless');
  });

  it('returns "rootless" when stdout contains a bare rootless token', async () => {
    // Older docker versions formatted SecurityOptions without the
    // `name=` prefix — keep the matcher tolerant.
    const mode = await detectDockerMode({
      spawn: async () => ({ stdout: '[" rootless "]', exitCode: 0 }),
    });
    expect(mode).toBe('rootless');
  });

  it('returns "rootful" on a normal (non-rootless) daemon', async () => {
    const mode = await detectDockerMode({
      spawn: async () => ({
        stdout: '["name=seccomp,profile=builtin"]',
        exitCode: 0,
      }),
    });
    expect(mode).toBe('rootful');
  });

  it('returns "rootful" when docker info exits non-zero (defensive default)', async () => {
    // Daemon unreachable / wrong context / permission denied. The
    // real failure will surface later in `docker run`; pre-emptively
    // failing here would worsen the diagnostic. Default to rootful
    // so we don't add idmap to a mount that wouldn't tolerate it.
    const mode = await detectDockerMode({
      spawn: async () => ({ stdout: '', exitCode: 1 }),
    });
    expect(mode).toBe('rootful');
  });

  it('returns "rootful" if the spawn itself throws (docker not on PATH)', async () => {
    const mode = await detectDockerMode({
      spawn: async () => {
        throw new Error('ENOENT: docker not on PATH');
      },
    });
    expect(mode).toBe('rootful');
  });

  it('case-insensitive match (defensive against future docker output tweaks)', async () => {
    const mode = await detectDockerMode({
      spawn: async () => ({ stdout: '["name=Rootless"]', exitCode: 0 }),
    });
    expect(mode).toBe('rootless');
  });
});
