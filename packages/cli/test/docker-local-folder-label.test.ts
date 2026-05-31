import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dockerLocalFolderLabel } from '../src/devcontainer/compose.js';

/**
 * @devcontainers/cli lowercases the drive letter when stamping the
 * `devcontainer.local_folder` label onto containers. Docker label
 * filters are byte-exact, so our docker-cleanup must match exactly
 * what was stored — otherwise containers stay alive on
 * `monoceros remove`. These tests pin that normalization in both
 * directions: applied on Windows, untouched everywhere else.
 */
describe('dockerLocalFolderLabel', () => {
  const originalPlatform = process.platform;

  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p });
  }

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  describe('on Windows', () => {
    beforeEach(() => {
      setPlatform('win32');
    });

    it('lowercases an uppercase drive letter', () => {
      expect(
        dockerLocalFolderLabel(
          'C:\\Users\\ThorstenKamann\\.monoceros\\container\\foo',
        ),
      ).toBe('c:\\Users\\ThorstenKamann\\.monoceros\\container\\foo');
    });

    it('leaves an already-lowercase drive letter alone', () => {
      expect(dockerLocalFolderLabel('d:\\projects\\foo')).toBe(
        'd:\\projects\\foo',
      );
    });

    it('only touches the drive letter — backslashes and case in the rest stay', () => {
      expect(dockerLocalFolderLabel('E:\\Path\\With\\MixedCase\\Folder')).toBe(
        'e:\\Path\\With\\MixedCase\\Folder',
      );
    });

    it('is a no-op for paths without a drive letter (UNC, relative)', () => {
      expect(dockerLocalFolderLabel('\\\\server\\share\\foo')).toBe(
        '\\\\server\\share\\foo',
      );
      expect(dockerLocalFolderLabel('relative\\path')).toBe('relative\\path');
    });
  });

  describe('off Windows', () => {
    beforeEach(() => {
      setPlatform('linux');
    });

    it('returns the path unchanged on Linux', () => {
      expect(dockerLocalFolderLabel('/home/foo/.monoceros/container/bar')).toBe(
        '/home/foo/.monoceros/container/bar',
      );
    });

    it("does not touch what looks like a drive letter on a POSIX path (can't happen, but no surprises)", () => {
      // Defensive: confirm the regex anchor prevents accidental
      // normalization off-Windows even if a caller hands in something
      // weird. The function is a pure no-op when platform !== win32.
      expect(dockerLocalFolderLabel('C:fake/posix/path')).toBe(
        'C:fake/posix/path',
      );
    });
  });
});
