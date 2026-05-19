import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMonocerosConfig } from '../src/config/global.js';

describe('readMonocerosConfig', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-global-config-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('returns undefined when no monoceros-config.yml exists', async () => {
    const result = await readMonocerosConfig({ monocerosHome: home });
    expect(result).toBeUndefined();
  });

  it('parses a minimal config without defaults', async () => {
    await writeFile(
      path.join(home, 'monoceros-config.yml'),
      'schemaVersion: 1\n',
    );
    const result = await readMonocerosConfig({ monocerosHome: home });
    expect(result).toEqual({ schemaVersion: 1 });
  });

  it('parses defaults.git.user', async () => {
    await writeFile(
      path.join(home, 'monoceros-config.yml'),
      [
        'schemaVersion: 1',
        'defaults:',
        '  git:',
        '    user:',
        '      name: Your Name',
        '      email: you@example.com',
        '',
      ].join('\n'),
    );
    const result = await readMonocerosConfig({ monocerosHome: home });
    expect(result?.defaults?.git?.user).toEqual({
      name: 'Your Name',
      email: 'you@example.com',
    });
  });

  it('parses defaults.features with per-feature option maps', async () => {
    await writeFile(
      path.join(home, 'monoceros-config.yml'),
      [
        'schemaVersion: 1',
        'defaults:',
        '  features:',
        '    ghcr.io/getmonoceros/monoceros-features/claude-code:1:',
        '      apiKey: sk-ant-1',
        '    ghcr.io/getmonoceros/monoceros-features/atlassian:1:',
        '      instance: yoursite.atlassian.net',
        '      email: you@example.com',
        '      apiToken: ATATT3xFf-default',
        '',
      ].join('\n'),
    );
    const result = await readMonocerosConfig({ monocerosHome: home });
    expect(result?.defaults?.features).toEqual({
      'ghcr.io/getmonoceros/monoceros-features/claude-code:1': {
        apiKey: 'sk-ant-1',
      },
      'ghcr.io/getmonoceros/monoceros-features/atlassian:1': {
        instance: 'yoursite.atlassian.net',
        email: 'you@example.com',
        apiToken: 'ATATT3xFf-default',
      },
    });
  });

  it('rejects a defaults.features key that is not a valid feature ref', async () => {
    await writeFile(
      path.join(home, 'monoceros-config.yml'),
      [
        'schemaVersion: 1',
        'defaults:',
        '  features:',
        '    not-a-ref:',
        '      foo: bar',
        '',
      ].join('\n'),
    );
    await expect(readMonocerosConfig({ monocerosHome: home })).rejects.toThrow(
      /defaults\.features\.not-a-ref/,
    );
  });

  it('throws on a wrong schemaVersion', async () => {
    await writeFile(
      path.join(home, 'monoceros-config.yml'),
      'schemaVersion: 99\n',
    );
    await expect(readMonocerosConfig({ monocerosHome: home })).rejects.toThrow(
      /schemaVersion/,
    );
  });

  it('throws on malformed email', async () => {
    await writeFile(
      path.join(home, 'monoceros-config.yml'),
      [
        'schemaVersion: 1',
        'defaults:',
        '  git:',
        '    user:',
        '      name: X',
        '      email: not-an-email',
        '',
      ].join('\n'),
    );
    await expect(readMonocerosConfig({ monocerosHome: home })).rejects.toThrow(
      /email/,
    );
  });

  it('throws on yaml parse error with the file path in the message', async () => {
    await writeFile(
      path.join(home, 'monoceros-config.yml'),
      'schemaVersion: 1\n  bad: indent\n',
    );
    await expect(readMonocerosConfig({ monocerosHome: home })).rejects.toThrow(
      /monoceros-config\.yml/,
    );
  });
});
