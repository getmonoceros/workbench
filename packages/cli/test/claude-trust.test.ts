import { existsSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  preApproveClaudeProject,
  resolveContainerCwd,
} from '../src/devcontainer/claude-trust.js';

describe('resolveContainerCwd', () => {
  it('returns the workspace folder when no cwd is given', () => {
    expect(resolveContainerCwd('demo')).toBe('/workspaces/demo');
  });

  it('resolves a relative cwd against the workspace folder', () => {
    expect(resolveContainerCwd('demo', 'projects')).toBe(
      '/workspaces/demo/projects',
    );
    expect(resolveContainerCwd('demo', 'projects/app')).toBe(
      '/workspaces/demo/projects/app',
    );
  });

  it('uses an absolute cwd as-is', () => {
    expect(resolveContainerCwd('demo', '/srv/elsewhere')).toBe(
      '/srv/elsewhere',
    );
  });
});

describe('preApproveClaudeProject', () => {
  let root: string;
  const claudeJson = (): string => path.join(root, 'home', '.claude.json');
  const readConfig = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await fsp.readFile(claudeJson(), 'utf8'));

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mono-trust-'));
    await fsp.mkdir(path.join(root, 'home'), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('seeds trust + external-import approval for the resolved cwd', async () => {
    await fsp.writeFile(claudeJson(), '{}');
    await preApproveClaudeProject({ root, name: 'demo', cwd: 'projects' });

    const config = await readConfig();
    const entry = (config.projects as Record<string, Record<string, unknown>>)[
      '/workspaces/demo/projects'
    ];
    expect(entry).toMatchObject({
      hasTrustDialogAccepted: true,
      hasClaudeMdExternalIncludesApproved: true,
      hasClaudeMdExternalIncludesWarningShown: true,
      projectOnboardingSeenCount: 1,
    });
  });

  it('keys on the workspace root when no cwd is given', async () => {
    await fsp.writeFile(claudeJson(), '{}');
    await preApproveClaudeProject({ root, name: 'demo' });

    const config = await readConfig();
    expect(Object.keys(config.projects as Record<string, unknown>)).toContain(
      '/workspaces/demo',
    );
  });

  it('preserves unrelated existing config (e.g. the OAuth account)', async () => {
    await fsp.writeFile(
      claudeJson(),
      JSON.stringify({
        oauthAccount: { emailAddress: 'a@b.c' },
        projects: { '/workspaces/demo': { allowedTools: ['Read'] } },
      }),
    );
    await preApproveClaudeProject({ root, name: 'demo', cwd: 'projects' });

    const config = await readConfig();
    expect(config.oauthAccount).toEqual({ emailAddress: 'a@b.c' });
    // Pre-existing project entry is left intact; the new one is added alongside.
    const projects = config.projects as Record<string, Record<string, unknown>>;
    expect(projects['/workspaces/demo']!.allowedTools).toEqual(['Read']);
    expect(projects['/workspaces/demo/projects']!.hasTrustDialogAccepted).toBe(
      true,
    );
  });

  it('is a no-op when .claude.json does not exist (no claude-code feature)', async () => {
    await preApproveClaudeProject({ root, name: 'demo', cwd: 'projects' });
    expect(existsSync(claudeJson())).toBe(false);
  });

  it('does not throw on malformed JSON and leaves the file untouched', async () => {
    await fsp.writeFile(claudeJson(), 'not json {');
    await expect(
      preApproveClaudeProject({ root, name: 'demo', cwd: 'projects' }),
    ).resolves.toBeUndefined();
    expect(await fsp.readFile(claudeJson(), 'utf8')).toBe('not json {');
  });

  it('does not rewrite when the cwd is already fully approved', async () => {
    await fsp.writeFile(
      claudeJson(),
      JSON.stringify({
        projects: {
          '/workspaces/demo/projects': {
            hasTrustDialogAccepted: true,
            hasClaudeMdExternalIncludesApproved: true,
            hasClaudeMdExternalIncludesWarningShown: true,
          },
        },
      }),
    );
    const before = await fsp.readFile(claudeJson(), 'utf8');
    await preApproveClaudeProject({ root, name: 'demo', cwd: 'projects' });
    expect(await fsp.readFile(claudeJson(), 'utf8')).toBe(before);
  });
});
