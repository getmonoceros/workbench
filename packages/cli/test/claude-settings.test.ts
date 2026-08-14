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

  // The roles keep their plans outside the workspace so they survive an apply,
  // and Claude Code refuses to list a directory that is not a working directory
  // of the session in every mode but auto. A skill's `!`find …`` preamble is not
  // a prompt anyone can approve, so the skill aborts before it loads - which is
  // what Claude Desktop over SSH does, because it attaches in acceptEdits.
  it('allows the plans directory while the roles are installed', async () => {
    const ROLES = 'ghcr.io/getmonoceros/monoceros-features/claude-code-roles:1';
    await writeClaudePermissionMode(dir, { [CLAUDE_REF]: {}, [ROLES]: {} });
    const withRoles = (await read()).permissions as Record<string, unknown>;
    expect(withRoles.additionalDirectories).toEqual([
      '/home/node/.claude/plans',
    ]);

    // Dropping the feature takes the entry with it, and leaves a directory the
    // builder added themselves alone.
    (withRoles.additionalDirectories as string[]).unshift('/opt/shared');
    await fsp.writeFile(
      settings(),
      JSON.stringify({ permissions: withRoles }, null, 2),
    );
    await writeClaudePermissionMode(dir, { [CLAUDE_REF]: {} });
    expect(
      ((await read()).permissions as Record<string, unknown>)
        .additionalDirectories,
    ).toEqual(['/opt/shared']);
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

/**
 * The graphify PreToolUse hooks. Upstream only wires these in project scope,
 * into a repo's own `.claude/settings.json`; Monoceros writes them into the
 * container's global settings instead, so the rule holds without touching the
 * builder's repository (ADR 0049). What has to hold: they appear only when both
 * features are there, they do not multiply on re-apply, they leave a foreign
 * hook alone, and they disappear again when graphify leaves the yml - a hook
 * command that is no longer installed would run on every tool call.
 */
describe('graphify PreToolUse hooks', () => {
  let dir: string;
  const GRAPHIFY_REF = 'ghcr.io/getmonoceros/monoceros-features/graphify:1';
  const settings = (): string =>
    path.join(dir, 'home', '.claude', 'settings.json');
  const read = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await fsp.readFile(settings(), 'utf8'));
  const preToolUse = async (): Promise<
    Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>
  > => {
    const cfg = await read();
    const hooks = (cfg.hooks ?? {}) as Record<string, unknown>;
    return (hooks.PreToolUse ?? []) as Array<{
      matcher?: string;
      hooks?: Array<{ command?: string }>;
    }>;
  };

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mono-claude-hooks-'));
    await fsp.mkdir(path.join(dir, 'home', '.claude'), { recursive: true });
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('wires search and read when graphify is in the same container', async () => {
    await writeClaudePermissionMode(dir, {
      [CLAUDE_REF]: {},
      [GRAPHIFY_REF]: {},
    });
    const entries = await preToolUse();
    expect(entries.map((e) => e.matcher)).toEqual(['Bash|Grep', 'Read|Glob']);
    expect(entries.map((e) => e.hooks?.[0]?.command)).toEqual([
      'graphify hook-guard search',
      'graphify hook-guard read',
    ]);
  });

  it('writes no hooks without the graphify feature', async () => {
    await writeClaudePermissionMode(dir, { [CLAUDE_REF]: {} });
    const cfg = await read();
    expect(cfg.hooks).toBeUndefined();
  });

  it('does not duplicate them on re-apply', async () => {
    const features = { [CLAUDE_REF]: {}, [GRAPHIFY_REF]: {} };
    await writeClaudePermissionMode(dir, features);
    await writeClaudePermissionMode(dir, features);
    expect(await preToolUse()).toHaveLength(2);
  });

  it('keeps a hook the builder added and drops only ours', async () => {
    await fsp.writeFile(
      settings(),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Write', hooks: [{ command: 'my-own-linter' }] },
          ],
          SessionStart: [{ hooks: [{ command: 'say-hello' }] }],
        },
      }),
    );
    await writeClaudePermissionMode(dir, {
      [CLAUDE_REF]: {},
      [GRAPHIFY_REF]: {},
    });
    expect((await preToolUse()).map((e) => e.hooks?.[0]?.command)).toEqual([
      'my-own-linter',
      'graphify hook-guard search',
      'graphify hook-guard read',
    ]);

    // graphify removed from the yml: ours go, the builder's stays, and so does
    // the unrelated event.
    await writeClaudePermissionMode(dir, { [CLAUDE_REF]: {} });
    expect((await preToolUse()).map((e) => e.hooks?.[0]?.command)).toEqual([
      'my-own-linter',
    ]);
    const cfg = await read();
    expect((cfg.hooks as Record<string, unknown>).SessionStart).toBeDefined();
  });

  it('drops the hooks key entirely when nothing is left in it', async () => {
    await writeClaudePermissionMode(dir, {
      [CLAUDE_REF]: {},
      [GRAPHIFY_REF]: {},
    });
    await writeClaudePermissionMode(dir, { [CLAUDE_REF]: {} });
    const cfg = await read();
    expect(cfg.hooks).toBeUndefined();
  });
});
