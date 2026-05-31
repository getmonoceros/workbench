import { describe, expect, it, vi } from 'vitest';
import {
  bootstrapWslBackend,
  hasWsl2Distro,
} from '../src/devcontainer/wsl-backend-bootstrap.js';

describe('hasWsl2Distro', () => {
  it('detects a VERSION 2 distro from typical `wsl -l -v` output', () => {
    const out = [
      '  NAME      STATE           VERSION',
      '* Ubuntu    Running         2',
    ].join('\n');
    expect(hasWsl2Distro(out)).toBe(true);
  });

  it("counts Docker Desktop's own docker-desktop distro", () => {
    const out = [
      '  NAME              STATE           VERSION',
      '* docker-desktop    Running         2',
    ].join('\n');
    expect(hasWsl2Distro(out)).toBe(true);
  });

  it('returns false when only a WSL 1 distro is registered', () => {
    const out = [
      '  NAME      STATE           VERSION',
      '* Legacy    Stopped         1',
    ].join('\n');
    expect(hasWsl2Distro(out)).toBe(false);
  });

  it('returns false for an empty listing', () => {
    expect(hasWsl2Distro('')).toBe(false);
  });

  it('survives UTF-16LE-as-UTF-8 output (NUL bytes between chars)', () => {
    // Simulate what `wsl -l -v` emits when WSL_UTF8 isn't honored.
    const utf16ish = '  NAME  STATE  VERSION\n* Ubuntu  Running  2\n'
      .split('')
      .join(String.fromCharCode(0));
    expect(hasWsl2Distro(utf16ish)).toBe(true);
  });
});

describe('bootstrapWslBackend', () => {
  it('is a no-op off Windows', () => {
    const warn = vi.fn();
    const wslDistros = vi.fn(() => null);
    bootstrapWslBackend({ platform: 'linux', warn, wslDistros });
    expect(warn).not.toHaveBeenCalled();
    expect(wslDistros).not.toHaveBeenCalled();
  });

  it('stays silent when a WSL 2 distro exists (and never probes docker)', () => {
    const warn = vi.fn();
    const probe = vi.fn(() => 1);
    bootstrapWslBackend({
      platform: 'win32',
      warn,
      probe,
      wslDistros: () => '  NAME  STATE  VERSION\n* Ubuntu  Running  2',
    });
    expect(warn).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('stays silent when no distro but docker is not installed', () => {
    const warn = vi.fn();
    bootstrapWslBackend({
      platform: 'win32',
      warn,
      probe: () => 1, // `docker --version` fails
      wslDistros: () => null,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when docker is installed but no WSL 2 distro is registered', () => {
    const warn = vi.fn();
    bootstrapWslBackend({
      platform: 'win32',
      warn,
      probe: () => 0, // `docker --version` succeeds
      wslDistros: () => '  NAME  STATE  VERSION\n* Legacy  Stopped  1',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('wsl --install -d Ubuntu');
  });

  it('warns when wsl query fails entirely and docker is installed', () => {
    const warn = vi.fn();
    bootstrapWslBackend({
      platform: 'win32',
      warn,
      probe: () => 0,
      wslDistros: () => null,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
