import { describe, expect, it } from 'vitest';
import {
  buildCodeWorkspaceJson,
  mergeCodeWorkspace,
} from '../src/create/scaffold.js';

/**
 * Pure-function unit tests for the merge step. The end-to-end
 * read-merge-write path through writeScaffold is covered indirectly
 * by apply-yml.test.ts (which materializes a container and inspects
 * the resulting `.code-workspace`).
 */

describe('mergeCodeWorkspace', () => {
  it('treats undefined / null existing as "no file" — generator output wins', () => {
    const gen = buildCodeWorkspaceJson({
      name: 'sandbox',
      languages: [],
      services: [],
    });
    expect(mergeCodeWorkspace(undefined, gen)).toEqual({ ...gen });
    expect(mergeCodeWorkspace(null, gen)).toEqual({ ...gen });
  });

  it('treats a malformed object (no folders[]) as missing — generator wins', () => {
    const gen = buildCodeWorkspaceJson({
      name: 'sandbox',
      languages: [],
      services: [],
    });
    expect(mergeCodeWorkspace({ broken: true }, gen)).toEqual({ ...gen });
    expect(mergeCodeWorkspace({ folders: 'not-an-array' }, gen)).toEqual({
      ...gen,
    });
  });

  it('preserves builder folders verbatim in their original order', () => {
    const existing = {
      folders: [
        { path: '.' },
        { path: '../sibling-on-host', name: 'local notes' },
      ],
    };
    const gen = { folders: [{ path: '.' }] };
    const merged = mergeCodeWorkspace(existing, gen);
    expect(merged.folders).toEqual([
      { path: '.' },
      { path: '../sibling-on-host', name: 'local notes' },
    ]);
  });

  it('appends generator-only folders that the builder did not have', () => {
    const existing = {
      folders: [{ path: '.' }],
    };
    const gen = {
      folders: [
        { path: '.' },
        { path: 'projects/api', name: 'api' },
        { path: 'projects/web', name: 'web' },
      ],
    };
    const merged = mergeCodeWorkspace(existing, gen) as {
      folders: Array<{ path: string; name?: string }>;
    };
    expect(merged.folders).toEqual([
      { path: '.' },
      { path: 'projects/api', name: 'api' },
      { path: 'projects/web', name: 'web' },
    ]);
  });

  it('does NOT remove builder folders that no longer come from the generator', () => {
    // Scenario: builder had three repos via add-repo, then removed
    // one from the yml. The folder still lives under projects/ on
    // disk (remove-repo leaves the dir alone), and a builder may
    // want to keep referring to it from the workspace. Don't auto-
    // delete.
    const existing = {
      folders: [
        { path: '.' },
        { path: 'projects/keep-me', name: 'keep-me' },
        { path: 'projects/orphan', name: 'orphan' },
      ],
    };
    const gen = {
      folders: [{ path: '.' }, { path: 'projects/keep-me', name: 'keep-me' }],
    };
    const merged = mergeCodeWorkspace(existing, gen) as {
      folders: Array<{ path: string }>;
    };
    expect(merged.folders.map((f) => f.path)).toContain('projects/orphan');
  });

  it('does not re-add a generator folder when its `path` is already present (even with a different name)', () => {
    // The builder renamed the display label of a generated entry —
    // their label wins, generator's same-path entry is dropped on the
    // floor.
    const existing = {
      folders: [
        { path: '.' },
        { path: 'projects/api', name: 'API (builder label)' },
      ],
    };
    const gen = {
      folders: [{ path: '.' }, { path: 'projects/api', name: 'api' }],
    };
    const merged = mergeCodeWorkspace(existing, gen) as {
      folders: Array<{ path: string; name?: string }>;
    };
    expect(merged.folders).toHaveLength(2);
    expect(merged.folders[1]).toEqual({
      path: 'projects/api',
      name: 'API (builder label)',
    });
  });

  it('preserves top-level builder additions (settings, extensions, launch, …)', () => {
    const existing = {
      folders: [{ path: '.' }],
      settings: { 'editor.formatOnSave': true },
      extensions: { recommendations: ['esbenp.prettier-vscode'] },
      launch: { configurations: [{ type: 'node', name: 'Run' }] },
    };
    const gen = { folders: [{ path: '.' }, { path: 'projects/api' }] };
    const merged = mergeCodeWorkspace(existing, gen);
    expect(merged.settings).toEqual({ 'editor.formatOnSave': true });
    expect(merged.extensions).toEqual({
      recommendations: ['esbenp.prettier-vscode'],
    });
    expect(merged.launch).toEqual({
      configurations: [{ type: 'node', name: 'Run' }],
    });
  });
});
