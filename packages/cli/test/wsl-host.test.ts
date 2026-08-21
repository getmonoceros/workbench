import { describe, expect, it } from 'vitest';
import { isManagedWslDistro } from '../src/util/wsl.js';

describe('isManagedWslDistro', () => {
  it('is true only inside the managed distro', () => {
    expect(isManagedWslDistro('linux', { WSL_DISTRO_NAME: 'monoceros' })).toBe(
      true,
    );
    expect(isManagedWslDistro('linux', { WSL_DISTRO_NAME: 'Monoceros' })).toBe(
      true,
    );
  });

  it('is false for someone else’s WSL distro', () => {
    expect(isManagedWslDistro('linux', { WSL_DISTRO_NAME: 'Ubuntu' })).toBe(
      false,
    );
  });

  it('is false off WSL', () => {
    expect(isManagedWslDistro('darwin', { WSL_DISTRO_NAME: 'monoceros' })).toBe(
      false,
    );
  });
});
