import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DockerExec, DockerResult } from '../src/proxy/index.js';
import { writeMachineState } from '../src/config/machine-state.js';
import { pruneStaleImages, selectStaleImages } from '../src/upgrade/prune.js';

const rec = (imageId: string, container: string, builtAt: string) => ({
  imageId,
  container,
  builtAt,
});

describe('selectStaleImages', () => {
  it('keeps the newest image per existing container, marks older ones stale', () => {
    const registry = [
      rec('sha:old', 'demo', '2026-06-01T00:00:00.000Z'),
      rec('sha:new', 'demo', '2026-06-05T00:00:00.000Z'),
    ];
    const { stale, keep } = selectStaleImages(registry, new Set(['demo']));
    expect(keep.map((r) => r.imageId)).toEqual(['sha:new']);
    expect(stale.map((r) => r.imageId)).toEqual(['sha:old']);
  });

  it('marks ALL images of a removed container stale', () => {
    const registry = [
      rec('sha:a', 'gone', '2026-06-01T00:00:00.000Z'),
      rec('sha:b', 'gone', '2026-06-05T00:00:00.000Z'),
      rec('sha:c', 'live', '2026-06-05T00:00:00.000Z'),
    ];
    const { stale, keep } = selectStaleImages(registry, new Set(['live']));
    expect(keep.map((r) => r.imageId)).toEqual(['sha:c']);
    expect(stale.map((r) => r.imageId).sort()).toEqual(['sha:a', 'sha:b']);
  });

  it('keeps everything when each container has a single current image', () => {
    const registry = [rec('sha:1', 'a', 't'), rec('sha:2', 'b', 't')];
    const { stale } = selectStaleImages(registry, new Set(['a', 'b']));
    expect(stale).toEqual([]);
  });
});

describe('pruneStaleImages', () => {
  let home: string;
  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mono-prune-'));
  });
  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
  });

  const fakeExec =
    (behaviour: Record<string, DockerResult>): DockerExec =>
    (args) => {
      const id = args[args.length - 1]!;
      return Promise.resolve(
        behaviour[id] ?? { stdout: '', stderr: '', exitCode: 0 },
      );
    };

  it('removes stale images and drops them from the registry; keeps survivors', async () => {
    await writeMachineState(
      {
        builtImages: [
          rec('sha:old', 'demo', '2026-06-01T00:00:00.000Z'),
          rec('sha:new', 'demo', '2026-06-05T00:00:00.000Z'),
          rec('sha:gone', 'removed', '2026-06-01T00:00:00.000Z'),
        ],
      },
      home,
    );
    const removed: string[] = [];
    const exec: DockerExec = (args) => {
      if (args[0] === 'rmi') removed.push(args[1]!);
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    };
    const result = await pruneStaleImages({
      home,
      currentContainerNames: new Set(['demo']),
      exec,
    });
    expect(result.removed).toBe(2);
    expect(removed.sort()).toEqual(['sha:gone', 'sha:old']);
    const state = JSON.parse(
      await fsp.readFile(path.join(home, '.machine-state.json'), 'utf8'),
    );
    expect(
      state.builtImages.map((r: { imageId: string }) => r.imageId),
    ).toEqual(['sha:new']);
  });

  it('keeps an in-use image tracked for a later retry', async () => {
    await writeMachineState(
      {
        builtImages: [
          rec('sha:old', 'demo', '2026-06-01T00:00:00.000Z'),
          rec('sha:new', 'demo', '2026-06-05T00:00:00.000Z'),
        ],
      },
      home,
    );
    const exec = fakeExec({
      'sha:old': {
        stdout: '',
        stderr: 'Error: conflict: unable to delete (image is being used)',
        exitCode: 1,
      },
    });
    const result = await pruneStaleImages({
      home,
      currentContainerNames: new Set(['demo']),
      exec,
    });
    expect(result.removed).toBe(0);
    const state = JSON.parse(
      await fsp.readFile(path.join(home, '.machine-state.json'), 'utf8'),
    );
    expect(
      state.builtImages.map((r: { imageId: string }) => r.imageId).sort(),
    ).toEqual(['sha:new', 'sha:old']);
  });
});
