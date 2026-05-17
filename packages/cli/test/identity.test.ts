import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectGitIdentity } from '../src/devcontainer/identity.js';

describe('collectGitIdentity', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'monoceros-identity-'));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('writes [user] section with name + email from host git', async () => {
    const calls: string[] = [];
    const result = await collectGitIdentity(cwd, {
      spawn: async (key) => {
        calls.push(key);
        if (key === 'user.name') {
          return { value: 'Thorsten Kamann', exitCode: 0 };
        }
        if (key === 'user.email') {
          return { value: 'thorsten@conciso.de', exitCode: 0 };
        }
        return { value: '', exitCode: 1 };
      },
    });

    expect(calls).toEqual(['user.name', 'user.email']);
    expect(result.name).toBe('Thorsten Kamann');
    expect(result.email).toBe('thorsten@conciso.de');

    const contents = await fs.readFile(
      path.join(cwd, '.monoceros', 'gitconfig'),
      'utf8',
    );
    expect(contents).toContain('[user]');
    expect(contents).toContain('name = Thorsten Kamann');
    expect(contents).toContain('email = thorsten@conciso.de');
  });

  it('writes only the keys host-git has set (missing email)', async () => {
    const warnings: string[] = [];
    const result = await collectGitIdentity(cwd, {
      spawn: async (key) => {
        if (key === 'user.name') {
          return { value: 'Thorsten', exitCode: 0 };
        }
        // user.email unset → git exits 1 with empty stdout.
        return { value: '', exitCode: 1 };
      },
      prompt: async () => undefined, // simulate non-interactive
      logger: {
        info: () => {},
        warn: (msg) => warnings.push(msg),
      },
    });

    expect(result.name).toBe('Thorsten');
    expect(result.email).toBeUndefined();
    expect(warnings.some((w) => w.includes('user.email'))).toBe(true);

    const contents = await fs.readFile(
      path.join(cwd, '.monoceros', 'gitconfig'),
      'utf8',
    );
    expect(contents).toContain('name = Thorsten');
    expect(contents).not.toContain('email = ');
  });

  it('writes an empty [user] section when host has no identity and prompt yields nothing', async () => {
    const result = await collectGitIdentity(cwd, {
      spawn: async () => ({ value: '', exitCode: 1 }),
      prompt: async () => undefined,
    });

    expect(result.name).toBeUndefined();
    expect(result.email).toBeUndefined();
    const contents = await fs.readFile(
      path.join(cwd, '.monoceros', 'gitconfig'),
      'utf8',
    );
    expect(contents).toContain('[user]');
  });

  it('gracefully handles host git not being runnable', async () => {
    const warnings: string[] = [];
    const result = await collectGitIdentity(cwd, {
      spawn: async () => {
        throw new Error('git: command not found');
      },
      prompt: async () => undefined,
      logger: {
        info: () => {},
        warn: (msg) => warnings.push(msg),
      },
    });

    expect(result.name).toBeUndefined();
    expect(result.email).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes('not runnable'))).toBe(true);
    await expect(
      fs.access(path.join(cwd, '.monoceros', 'gitconfig')),
    ).resolves.toBeUndefined();
  });

  it('uses prompt fallback when host has no value AND no persisted file', async () => {
    const promptCalls: string[] = [];
    const result = await collectGitIdentity(cwd, {
      spawn: async () => ({ value: '', exitCode: 1 }),
      prompt: async (key) => {
        promptCalls.push(key);
        if (key === 'user.name') return 'Prompted Builder';
        if (key === 'user.email') return 'prompted@example.com';
        return undefined;
      },
    });

    expect(promptCalls).toEqual(['user.name', 'user.email']);
    expect(result.name).toBe('Prompted Builder');
    expect(result.email).toBe('prompted@example.com');
  });

  it('skips prompt and reuses persisted file when host returns nothing', async () => {
    // Seed an existing gitconfig from a previous run.
    await fs.mkdir(path.join(cwd, '.monoceros'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.monoceros', 'gitconfig'),
      '[user]\n\tname = Persisted Builder\n\temail = persisted@example.com\n',
    );

    let promptCalls = 0;
    const result = await collectGitIdentity(cwd, {
      spawn: async () => ({ value: '', exitCode: 1 }),
      prompt: async () => {
        promptCalls += 1;
        return 'should-not-be-called';
      },
    });

    expect(promptCalls).toBe(0);
    expect(result.name).toBe('Persisted Builder');
    expect(result.email).toBe('persisted@example.com');
  });

  it('host value wins over persisted value', async () => {
    await fs.mkdir(path.join(cwd, '.monoceros'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.monoceros', 'gitconfig'),
      '[user]\n\tname = Old Persisted\n\temail = old@example.com\n',
    );
    const result = await collectGitIdentity(cwd, {
      spawn: async (key) => ({
        value: key === 'user.name' ? 'Fresh From Host' : 'fresh@example.com',
        exitCode: 0,
      }),
      prompt: async () => undefined,
    });
    expect(result.name).toBe('Fresh From Host');
    expect(result.email).toBe('fresh@example.com');
  });

  it('container override wins over defaults and host global', async () => {
    const result = await collectGitIdentity(cwd, {
      containerOverride: { name: 'Yml Override', email: 'yml@example.com' },
      defaults: { name: 'Default Name', email: 'default@example.com' },
      spawn: async (key) => ({
        value: key === 'user.name' ? 'Host Name' : 'host@example.com',
        exitCode: 0,
      }),
      prompt: async () => undefined,
    });
    expect(result.name).toBe('Yml Override');
    expect(result.email).toBe('yml@example.com');
  });

  it('monoceros-config defaults win over host global', async () => {
    const result = await collectGitIdentity(cwd, {
      defaults: { name: 'From Config', email: 'config@example.com' },
      spawn: async (key) => ({
        value: key === 'user.name' ? 'Host Name' : 'host@example.com',
        exitCode: 0,
      }),
      prompt: async () => undefined,
    });
    expect(result.name).toBe('From Config');
    expect(result.email).toBe('config@example.com');
  });

  it('falls through to host global when defaults only cover one key', async () => {
    const result = await collectGitIdentity(cwd, {
      defaults: { email: 'config@example.com' }, // only email
      spawn: async (key) => ({
        value: key === 'user.name' ? 'Host Name' : 'host@example.com',
        exitCode: 0,
      }),
      prompt: async () => undefined,
    });
    expect(result.name).toBe('Host Name');
    expect(result.email).toBe('config@example.com');
  });
});
