import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveClaudeDefaultMode,
  writeClaudePermissionMode,
} from '../src/create/claude-settings.js';

const CLAUDE_REF = 'ghcr.io/getmonoceros/monoceros-features/claude-code:1';

describe('resolveClaudeDefaultMode', () => {
  it('defaults to bypassPermissions (the safe-in-a-container default)', () => {
    expect(resolveClaudeDefaultMode(undefined)).toBe('bypassPermissions');
    expect(resolveClaudeDefaultMode('')).toBe('bypassPermissions');
    expect(resolveClaudeDefaultMode('bypass')).toBe('bypassPermissions');
  });

  it('maps `ask` to Claude’s `default` mode', () => {
    expect(resolveClaudeDefaultMode('ask')).toBe('default');
  });

  it('passes Claude raw values through, and falls back on garbage', () => {
    expect(resolveClaudeDefaultMode('acceptEdits')).toBe('acceptEdits');
    expect(resolveClaudeDefaultMode('plan')).toBe('plan');
    expect(resolveClaudeDefaultMode('bypassPermissions')).toBe(
      'bypassPermissions',
    );
    expect(resolveClaudeDefaultMode('nonsense')).toBe('bypassPermissions');
  });
});

describe('writeClaudePermissionMode', () => {
  let dir: string;
  const settings = (): string =>
    path.join(dir, 'home', '.claude', 'settings.json');
  const read = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await fsp.readFile(settings(), 'utf8'));

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mono-claude-settings-'));
    await fsp.mkdir(path.join(dir, 'home', '.claude'), { recursive: true });
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('writes the default bypass mode when the feature has no option', async () => {
    await writeClaudePermissionMode(dir, { [CLAUDE_REF]: {} });
    const cfg = await read();
    expect((cfg.permissions as Record<string, unknown>).defaultMode).toBe(
      'bypassPermissions',
    );
  });

  it('honours an explicit `ask` option', async () => {
    await writeClaudePermissionMode(dir, {
      [CLAUDE_REF]: { permissionMode: 'ask' },
    });
    const cfg = await read();
    expect((cfg.permissions as Record<string, unknown>).defaultMode).toBe(
      'default',
    );
  });

  it('merges: preserves other settings + other permissions keys', async () => {
    await fsp.writeFile(
      settings(),
      JSON.stringify({
        theme: 'dark',
        permissions: { allow: ['Read'] },
      }),
    );
    await writeClaudePermissionMode(dir, {
      [CLAUDE_REF]: { permissionMode: 'bypass' },
    });
    const cfg = await read();
    expect(cfg.theme).toBe('dark');
    const perms = cfg.permissions as Record<string, unknown>;
    expect(perms.allow).toEqual(['Read']);
    expect(perms.defaultMode).toBe('bypassPermissions');
  });

  it('is a no-op when no claude-code feature is present', async () => {
    await writeClaudePermissionMode(dir, {
      'ghcr.io/getmonoceros/monoceros-features/github-cli:1': {},
    });
    const { existsSync } = await import('node:fs');
    expect(existsSync(settings())).toBe(false);
  });

  it('does not throw on malformed existing settings.json', async () => {
    await fsp.writeFile(settings(), 'not json {');
    await expect(
      writeClaudePermissionMode(dir, { [CLAUDE_REF]: {} }),
    ).resolves.toBeUndefined();
    const cfg = await read();
    expect((cfg.permissions as Record<string, unknown>).defaultMode).toBe(
      'bypassPermissions',
    );
  });
});
