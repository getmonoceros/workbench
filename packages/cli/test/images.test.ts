import { describe, expect, it } from 'vitest';
import type { DockerExec, DockerResult } from '../src/proxy/index.js';
import {
  removeImage,
  resolveContainerImageId,
} from '../src/devcontainer/images.js';

const ok = (stdout: string): DockerResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
});

describe('resolveContainerImageId', () => {
  it('finds the container by local_folder label and returns its image id', async () => {
    const seen: string[][] = [];
    const exec: DockerExec = (args) => {
      seen.push(args);
      if (args[0] === 'ps') return Promise.resolve(ok('container123\n'));
      return Promise.resolve(ok('sha256:image456\n'));
    };
    const id = await resolveContainerImageId('/home/c/demo', exec);
    expect(id).toBe('sha256:image456');
    expect(seen[0]).toContain('label=devcontainer.local_folder=/home/c/demo');
    expect(seen[1]).toEqual([
      'inspect',
      '--format',
      '{{.Image}}',
      'container123',
    ]);
  });

  it('returns null when no container matches', async () => {
    const exec: DockerExec = () => Promise.resolve(ok(''));
    expect(await resolveContainerImageId('/home/c/demo', exec)).toBeNull();
  });
});

describe('removeImage', () => {
  const exec =
    (res: DockerResult): DockerExec =>
    () =>
      Promise.resolve(res);

  it('classifies success, absent, in-use, and error', async () => {
    expect(await removeImage('x', exec(ok('')))).toBe('removed');
    expect(
      await removeImage(
        'x',
        exec({ stdout: '', stderr: 'Error: No such image: x', exitCode: 1 }),
      ),
    ).toBe('absent');
    expect(
      await removeImage(
        'x',
        exec({
          stdout: '',
          stderr: 'conflict: unable to delete (image is being used)',
          exitCode: 1,
        }),
      ),
    ).toBe('in-use');
    expect(
      await removeImage(
        'x',
        exec({ stdout: '', stderr: 'daemon not running', exitCode: 1 }),
      ),
    ).toBe('error');
  });
});
