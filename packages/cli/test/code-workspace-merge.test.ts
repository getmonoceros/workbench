import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCodeWorkspaceJson,
  computeExtensionRecommendations,
  extractRepoHost,
  mergeCodeWorkspace,
  mergeVscodeSettings,
  writeIfChanged,
} from '../src/create/scaffold.js';
import type { CreateOptions } from '../src/create/types.js';
import type { ResolvedService } from '../src/create/types.js';

function opts(over: Partial<CreateOptions> = {}): CreateOptions {
  return { name: 'sandbox', languages: [], services: [], ...over };
}

function svc(name: string): ResolvedService {
  return { name, image: `${name}:latest`, env: {}, volumes: [] };
}

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

  it('fills the generic name onto an existing nameless `.` root (re-apply over a pre-label file)', () => {
    const existing = {
      folders: [{ path: '.' }, { path: 'projects/api', name: 'api' }],
    };
    const gen = buildCodeWorkspaceJson(opts());
    const merged = mergeCodeWorkspace(existing, gen) as {
      folders: Array<{ path: string; name?: string }>;
    };
    expect(merged.folders[0]).toEqual({ path: '.', name: '🦄 Monoceros' });
    // the builder's own folder is untouched
    expect(merged.folders[1]).toEqual({ path: 'projects/api', name: 'api' });
  });

  it('preserves a builder-chosen name on the `.` root', () => {
    const existing = { folders: [{ path: '.', name: 'My Root' }] };
    const gen = buildCodeWorkspaceJson(opts());
    const merged = mergeCodeWorkspace(existing, gen) as {
      folders: Array<{ path: string; name?: string }>;
    };
    expect(merged.folders[0]).toEqual({ path: '.', name: 'My Root' });
  });

  it('preserves top-level builder additions (settings, launch, …)', () => {
    const existing = {
      folders: [{ path: '.' }],
      settings: { 'editor.formatOnSave': true },
      launch: { configurations: [{ type: 'node', name: 'Run' }] },
    };
    const gen = { folders: [{ path: '.' }, { path: 'projects/api' }] };
    const merged = mergeCodeWorkspace(existing, gen);
    expect(merged.settings).toEqual({ 'editor.formatOnSave': true });
    expect(merged.launch).toEqual({
      configurations: [{ type: 'node', name: 'Run' }],
    });
  });

  it('unions extensions.recommendations: builder first, generator-only appended, deduped', () => {
    const existing = {
      folders: [{ path: '.' }],
      extensions: { recommendations: ['esbenp.prettier-vscode'] },
    };
    const gen = {
      folders: [{ path: '.' }],
      extensions: {
        recommendations: [
          'esbenp.prettier-vscode', // already present → not duplicated
          'cweijan.vscode-database-client2',
        ],
      },
    };
    const merged = mergeCodeWorkspace(existing, gen) as {
      extensions: { recommendations: string[] };
    };
    expect(merged.extensions.recommendations).toEqual([
      'esbenp.prettier-vscode',
      'cweijan.vscode-database-client2',
    ]);
  });

  it('preserves unwantedRecommendations (the builder escape hatch) while unioning recommendations', () => {
    const existing = {
      folders: [{ path: '.' }],
      extensions: {
        recommendations: [],
        unwantedRecommendations: ['GitHub.vscode-github-actions'],
      },
    };
    const gen = {
      folders: [{ path: '.' }],
      extensions: { recommendations: ['GitLab.gitlab-workflow'] },
    };
    const merged = mergeCodeWorkspace(existing, gen) as {
      extensions: {
        recommendations: string[];
        unwantedRecommendations: string[];
      };
    };
    expect(merged.extensions.recommendations).toEqual([
      'GitLab.gitlab-workflow',
    ]);
    expect(merged.extensions.unwantedRecommendations).toEqual([
      'GitHub.vscode-github-actions',
    ]);
  });
});

describe('buildCodeWorkspaceJson', () => {
  it('labels the `.` root with the generic Monoceros name', () => {
    const ws = buildCodeWorkspaceJson(opts());
    expect(ws.folders[0]).toEqual({ path: '.', name: '🦄 Monoceros' });
  });

  it('omits extensions entirely when nothing is inferred', () => {
    const ws = buildCodeWorkspaceJson(opts());
    expect(ws.extensions).toBeUndefined();
  });

  it('emits the DB client recommendation for a postgres service', () => {
    const ws = buildCodeWorkspaceJson(opts({ services: [svc('postgres')] }));
    expect(ws.extensions?.recommendations).toEqual([
      'cweijan.vscode-database-client2',
    ]);
  });
});

describe('computeExtensionRecommendations', () => {
  it('dedupes the single DB client across multiple DB services', () => {
    const recs = computeExtensionRecommendations(
      opts({ services: [svc('postgres'), svc('mysql'), svc('redis')] }),
    );
    expect(recs).toEqual(['cweijan.vscode-database-client2']);
  });

  it('recommends the curated extensions for a language (ADR 0016)', () => {
    expect(
      computeExtensionRecommendations(opts({ languages: ['python'] })),
    ).toEqual(['ms-python.python', 'ms-python.vscode-pylance']);
    expect(
      computeExtensionRecommendations(opts({ languages: ['go'] })),
    ).toEqual(['golang.go']);
    // node ships no recommendation (native JS/TS support).
    expect(
      computeExtensionRecommendations(opts({ languages: ['node'] })),
    ).toEqual([]);
  });

  it('lists both C# variants so VS Code and Codium each pick their own', () => {
    expect(
      computeExtensionRecommendations(opts({ languages: ['dotnet'] })),
    ).toEqual(['ms-dotnettools.csharp', 'muhammad-sammy.csharp']);
  });

  it('recommends feature extensions too (no longer manifest-only, ADR 0016/0022)', () => {
    const recs = computeExtensionRecommendations(
      opts({
        features: {
          'ghcr.io/getmonoceros/monoceros-features/claude-code:1': {},
        },
      }),
    );
    expect(recs).toContain('anthropic.claude-code');
  });

  it('recommends GitHub PR + Actions for a github repo, GitLab workflow for a gitlab repo', () => {
    const recs = computeExtensionRecommendations(
      opts({
        repos: [
          { url: 'https://github.com/foo/bar.git', path: 'bar' },
          { url: 'git@gitlab.com:foo/baz.git', path: 'baz' },
        ],
      }),
    );
    expect(recs).toEqual([
      'GitHub.vscode-github-actions',
      'github.vscode-pull-request-github',
      'GitLab.gitlab-workflow',
    ]);
  });

  it('recommends nothing for a bitbucket repo (atlascode comes from the atlassian feature)', () => {
    const recs = computeExtensionRecommendations(
      opts({ repos: [{ url: 'git@bitbucket.org:foo/bar.git', path: 'bar' }] }),
    );
    expect(recs).toEqual([]);
  });

  it('ignores unknown / self-hosted hosts', () => {
    const recs = computeExtensionRecommendations(
      opts({
        repos: [{ url: 'https://git.example.com/foo/bar.git', path: 'bar' }],
      }),
    );
    expect(recs).toEqual([]);
  });
});

describe('extractRepoHost', () => {
  it('parses https, scp-style, and ssh:// URLs', () => {
    expect(extractRepoHost('https://github.com/foo/bar.git')).toBe(
      'github.com',
    );
    expect(extractRepoHost('git@gitlab.com:foo/bar.git')).toBe('gitlab.com');
    expect(extractRepoHost('ssh://git@bitbucket.org:22/foo/bar.git')).toBe(
      'bitbucket.org',
    );
  });

  it('lowercases the host and returns null when unparseable', () => {
    expect(extractRepoHost('https://GitHub.com/x/y')).toBe('github.com');
    expect(extractRepoHost('not a url')).toBeNull();
  });
});

describe('writeIfChanged', () => {
  it('writes when missing/changed, skips the no-op write (so apply does not churn config files)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mono-wic-'));
    const f = path.join(dir, 'devcontainer.json');
    expect(await writeIfChanged(f, 'a')).toBe(true); // missing → write
    expect(await writeIfChanged(f, 'a')).toBe(false); // identical → skip
    expect(await writeIfChanged(f, 'b')).toBe(true); // changed → write
    expect(await fs.readFile(f, 'utf8')).toBe('b');
  });

  it('does not touch the file mtime on a no-op write', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mono-wic-'));
    const f = path.join(dir, 'compose.yaml');
    await writeIfChanged(f, 'same');
    const before = (await fs.stat(f)).mtimeMs;
    await writeIfChanged(f, 'same');
    expect((await fs.stat(f)).mtimeMs).toBe(before);
  });
});

describe('mergeVscodeSettings', () => {
  it('writes the denoise excludes when there is no existing file', () => {
    const out = mergeVscodeSettings(undefined) as {
      'files.exclude': Record<string, boolean>;
    };
    expect(out['files.exclude']['projects']).toBe(true);
    expect(out['files.exclude']['.vscode']).toBe(true);
    // the four kept entries are NOT hidden
    expect(out['files.exclude']['home']).toBeUndefined();
    expect(out['files.exclude']['logs']).toBeUndefined();
  });

  it('preserves builder settings and unions their own files.exclude entries', () => {
    const existing = {
      'editor.tabSize': 2,
      'files.exclude': { '**/.DS_Store': true },
    };
    const out = mergeVscodeSettings(existing) as {
      'editor.tabSize': number;
      'files.exclude': Record<string, boolean>;
    };
    expect(out['editor.tabSize']).toBe(2);
    expect(out['files.exclude']['**/.DS_Store']).toBe(true);
    expect(out['files.exclude']['.monoceros']).toBe(true);
  });
});
