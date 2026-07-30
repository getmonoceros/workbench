import { describe, expect, it } from 'vitest';
import {
  buildComposeYaml,
  buildDevcontainerJson,
  languageCacheVolumes,
  languageWorkspaceEnv,
} from '../src/create/scaffold.js';
import type { CreateOptions } from '../src/create/types.js';

// Language toolchain caches (issue #71): a compiler's content-addressed caches
// are shared machine-wide (downloaded/compiled once, unaffected by `apply`),
// while what a PROJECT installs stays per container.
const base: CreateOptions = {
  name: 'sandbox',
  languages: [],
  services: [],
};

describe('languageCacheVolumes', () => {
  it('gives Go a shared build and module cache, named without the container', () => {
    expect(languageCacheVolumes(['go:latest'], '1.6.2')).toEqual([
      {
        volume: 'monoceros-cache-go-go-build',
        target: '/home/node/.cache/go-build',
        minRuntime: '1.6.2',
        shared: true,
      },
      {
        volume: 'monoceros-cache-go-go-mod',
        target: '/home/node/.cache/go-mod',
        minRuntime: '1.6.2',
        shared: true,
      },
    ]);
  });

  it('is gated on the runtime that pre-creates the dirs node-owned', () => {
    // 1.6.1 has no node-owned cache dirs, so a fresh volume would initialise
    // root-owned and the toolchain could not write into it.
    expect(languageCacheVolumes(['go'], '1.6.1')).toEqual([]);
    expect(languageCacheVolumes(['go'], undefined)).toEqual([]);
  });

  it('contributes nothing for a language that declares no caches', () => {
    expect(languageCacheVolumes(['node:24.18.0'], '1.6.2')).toEqual([]);
  });
});

describe('languageWorkspaceEnv', () => {
  it('points Go at the shared module cache and the persisted GOBIN', () => {
    expect(languageWorkspaceEnv(['go'])).toEqual({
      GOMODCACHE: '/home/node/.cache/go-mod',
      GOBIN: '/home/node/go/bin',
    });
  });

  it('is empty without a language that declares env', () => {
    expect(languageWorkspaceEnv(['node'])).toEqual({});
  });
});

describe('scaffold wiring', () => {
  const go = { ...base, runtimeVersion: '1.6.2', languages: ['go:latest'] };

  it('mounts the shared caches and binds GOBIN per container (image mode)', () => {
    const dc = buildDevcontainerJson(go);
    if (!('runArgs' in dc)) throw new Error('expected image-mode shape');
    const mounts = (dc.mounts ?? []).join('\n');
    expect(mounts).toContain(
      'source=monoceros-cache-go-go-build,target=/home/node/.cache/go-build,type=volume',
    );
    expect(mounts).toContain(
      'source=monoceros-cache-go-go-mod,target=/home/node/.cache/go-mod,type=volume',
    );
    // GOBIN is a per-container home bind out of container/<name>/home/, not a
    // shared volume: version pins differ per project.
    expect(mounts).toContain('home/go/bin');
    expect(mounts).not.toContain('cache-go-bin');
    expect(dc.containerEnv?.GOBIN).toBe('/home/node/go/bin');
  });

  it('declares the shared caches in compose and hands the env to the workspace', () => {
    const yaml = buildComposeYaml(go);
    expect(yaml).toContain(
      'monoceros-cache-go-go-build:/home/node/.cache/go-build',
    );
    expect(yaml).toContain(
      'monoceros-cache-go-go-mod:/home/node/.cache/go-mod',
    );
    expect(yaml).toContain('GOMODCACHE: "/home/node/.cache/go-mod"');
    expect(yaml).toContain('GOBIN: "/home/node/go/bin"');
  });

  it('leaves a workbench without Go untouched', () => {
    const dc = buildDevcontainerJson({
      ...base,
      runtimeVersion: '1.6.2',
      languages: ['node'],
    });
    if (!('runArgs' in dc)) throw new Error('expected image-mode shape');
    expect((dc.mounts ?? []).join('\n')).not.toContain('monoceros-cache-');
    expect(dc.containerEnv?.GOBIN).toBeUndefined();
  });
});
