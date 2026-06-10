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
  it('defaults to auto (no prompts, no warning)', () => {
    expect(resolveClaudeDefaultMode(undefined)).toBe('auto');
    expect(resolveClaudeDefaultMode('')).toBe('auto');
    expect(resolveClaudeDefaultMode('auto')).toBe('auto');
  });

  it('maps the friendly aliases', () => {
    expect(resolveClaudeDefaultMode('ask')).toBe('default');
    expect(resolveClaudeDefaultMode('edits')).toBe('acceptEdits');
    expect(resolveClaudeDefaultMode('bypass')).toBe('bypassPermissions');
  });

  it('passes Claude raw values through, and falls back on garbage', () => {
    expect(resolveClaudeDefaultMode('acceptEdits')).toBe('acceptEdits');
    expect(resolveClaudeDefaultMode('plan')).toBe('plan');
    expect(resolveClaudeDefaultMode('bypassPermissions')).toBe(
      'bypassPermissions',
    );
    expect(resolveClaudeDefaultMode('nonsense')).toBe('auto');
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

  it('defaults to auto + enables it via env when the feature has no option', async () => {
    await writeClaudePermissionMode(dir, { [CLAUDE_REF]: {} });
    const cfg = await read();
    expect((cfg.permissions as Record<string, unknown>).defaultMode).toBe(
      'auto',
    );
    expect(
      (cfg.env as Record<string, unknown>).CLAUDE_CODE_ENABLE_AUTO_MODE,
    ).toBe('1');
    expect(cfg.skipDangerousModePermissionPrompt).toBeUndefined();
  });

  it('honours an explicit `ask` option (no env, no skip)', async () => {
    await writeClaudePermissionMode(dir, {
      [CLAUDE_REF]: { permissionMode: 'ask' },
    });
    const cfg = await read();
    expect((cfg.permissions as Record<string, unknown>).defaultMode).toBe(
      'default',
    );
    expect(cfg.env).toBeUndefined();
    expect(cfg.skipDangerousModePermissionPrompt).toBeUndefined();
  });

  it('pre-accepts the bypass warning when `bypass` is chosen', async () => {
    await writeClaudePermissionMode(dir, {
      [CLAUDE_REF]: { permissionMode: 'bypass' },
    });
    const cfg = await read();
    expect((cfg.permissions as Record<string, unknown>).defaultMode).toBe(
      'bypassPermissions',
    );
    expect(cfg.skipDangerousModePermissionPrompt).toBe(true);
    expect(cfg.env).toBeUndefined();
  });

  it('maps `edits` to acceptEdits', async () => {
    await writeClaudePermissionMode(dir, {
      [CLAUDE_REF]: { permissionMode: 'edits' },
    });
    const cfg = await read();
    expect((cfg.permissions as Record<string, unknown>).defaultMode).toBe(
      'acceptEdits',
    );
  });

  it('cleans up the opposite mode’s key when switching mode', async () => {
    // Start in bypass (sets skip), then switch to auto (should set env, drop skip).
    await writeClaudePermissionMode(dir, {
      [CLAUDE_REF]: { permissionMode: 'bypass' },
    });
    await writeClaudePermissionMode(dir, {
      [CLAUDE_REF]: { permissionMode: 'auto' },
    });
    const cfg = await read();
    expect((cfg.permissions as Record<string, unknown>).defaultMode).toBe(
      'auto',
    );
    expect(cfg.skipDangerousModePermissionPrompt).toBeUndefined();
    expect(
      (cfg.env as Record<string, unknown>).CLAUDE_CODE_ENABLE_AUTO_MODE,
    ).toBe('1');
  });

  it('merges: preserves other settings, permissions keys, and other env keys', async () => {
    await fsp.writeFile(
      settings(),
      JSON.stringify({
        theme: 'dark',
        permissions: { allow: ['Read'] },
        env: { FOO: 'bar' },
      }),
    );
    await writeClaudePermissionMode(dir, {
      [CLAUDE_REF]: { permissionMode: 'auto' },
    });
    const cfg = await read();
    expect(cfg.theme).toBe('dark');
    const perms = cfg.permissions as Record<string, unknown>;
    expect(perms.allow).toEqual(['Read']);
    expect(perms.defaultMode).toBe('auto');
    const env = cfg.env as Record<string, unknown>;
    expect(env.FOO).toBe('bar');
    expect(env.CLAUDE_CODE_ENABLE_AUTO_MODE).toBe('1');
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
      'auto',
    );
  });
});
