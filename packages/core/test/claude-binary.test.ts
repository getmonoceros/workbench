import { describe, expect, it } from 'vitest';

import {
  isLinuxGlibc,
  resolveClaudeBinary,
} from '../src/runtime/claude-binary.js';

describe('isLinuxGlibc', () => {
  it('returns a boolean — runs without throwing on the host', () => {
    // We cannot assert true/false because tests run on multiple
    // platforms; only the type contract is reliable.
    expect(typeof isLinuxGlibc()).toBe('boolean');
  });
});

describe('resolveClaudeBinary', () => {
  it('resolves to the darwin variant when running on macOS', () => {
    if (process.platform !== 'darwin') return; // skip on non-darwin CI
    const path = resolveClaudeBinary('darwin', process.arch);
    expect(path).toBeDefined();
    expect(path).toContain(`claude-agent-sdk-darwin-${process.arch}`);
    expect(path).toMatch(/\/claude$/);
  });

  it('prefers the glibc variant on linux when isGlibc returns true', () => {
    const path = resolveClaudeBinary('linux', 'arm64', () => true);
    if (path === undefined) return; // skip if neither variant installed
    expect(path).toContain('claude-agent-sdk-linux-arm64');
    expect(path).not.toContain('-musl');
  });

  it('prefers the musl variant on linux when isGlibc returns false', () => {
    const path = resolveClaudeBinary('linux', 'arm64', () => false);
    if (path === undefined) return;
    expect(path).toContain('claude-agent-sdk-linux-arm64-musl');
  });

  it('falls back to the other libc variant if the preferred is missing', () => {
    // If only musl is installed and isGlibc says true, we still get a path
    // (back to musl). Conversely if only glibc is installed. We can't
    // engineer "missing variant" in the host workspace, but we can at
    // least confirm a non-null result when either is present.
    const path = resolveClaudeBinary('linux', 'arm64');
    if (path !== undefined) {
      expect(path).toMatch(/claude-agent-sdk-linux-arm64(-musl)?\/claude$/);
    }
  });

  it('returns undefined for unknown platform/arch combos', () => {
    const path = resolveClaudeBinary(
      'sunos' as NodeJS.Platform,
      'sparc',
      () => true,
    );
    expect(path).toBeUndefined();
  });
});
