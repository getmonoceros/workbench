import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PROXY_HOST_PORT,
  proxyHostPort,
  readMonocerosConfig,
} from '../src/config/global.js';

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

  it('parses defaults as null (shipped template with everything commented)', async () => {
    // The shipped monoceros-config.yml has `defaults:` uncommented as
    // a structural anchor, with every sub-block commented out. YAML
    // parses that as { schemaVersion: 1, defaults: null }. The schema
    // accepts null via .nullish() so users don't have to uncomment
    // three spatially-separated lines to get a working config.
    await writeFile(
      path.join(home, 'monoceros-config.yml'),
      ['schemaVersion: 1', 'defaults:', '  # only comments below', ''].join(
        '\n',
      ),
    );
    const result = await readMonocerosConfig({ monocerosHome: home });
    expect(result?.schemaVersion).toBe(1);
    expect(result?.defaults).toBeNull();
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

  it('accepts and surfaces routing.hostPort', async () => {
    await writeFile(
      path.join(home, 'monoceros-config.yml'),
      ['schemaVersion: 1', 'routing:', '  hostPort: 8080', ''].join('\n'),
    );
    const result = await readMonocerosConfig({ monocerosHome: home });
    expect(result?.routing?.hostPort).toBe(8080);
    expect(proxyHostPort(result)).toBe(8080);
  });

  it('rejects out-of-range routing.hostPort values', async () => {
    await writeFile(
      path.join(home, 'monoceros-config.yml'),
      ['schemaVersion: 1', 'routing:', '  hostPort: 70000', ''].join('\n'),
    );
    await expect(readMonocerosConfig({ monocerosHome: home })).rejects.toThrow(
      /hostPort|less than or equal/i,
    );
  });
});

describe('proxyHostPort', () => {
  it('falls back to 80 when the config is undefined', () => {
    expect(proxyHostPort(undefined)).toBe(DEFAULT_PROXY_HOST_PORT);
    expect(DEFAULT_PROXY_HOST_PORT).toBe(80);
  });

  it('falls back to 80 when routing.hostPort is unset', () => {
    expect(proxyHostPort({ schemaVersion: 1 })).toBe(80);
  });
});

// Regression guard: the shipped sample yml must parse cleanly — it
// gets dropped verbatim into ~/.monoceros/ by install.sh / install.ps1
// for fresh installs. A typo in the sample would only surface when an
// actual builder tries to use it, which is too late.
describe('monoceros-config.sample.yml', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-sample-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('the shipped sample parses against the schema', async () => {
    const sample = await import('node:fs').then((m) =>
      m.promises.readFile(
        path.resolve(
          __dirname,
          '..',
          'templates',
          'monoceros-config.sample.yml',
        ),
        'utf8',
      ),
    );
    await writeFile(path.join(home, 'monoceros-config.yml'), sample);
    // With every actual setting commented out, the parsed shape is
    // schemaVersion + the bare `defaults:`/`routing:` containers
    // (which become null thanks to .nullish() on those fields). The
    // important assertion is just that readMonocerosConfig doesn't
    // throw a schema error.
    const result = await readMonocerosConfig({ monocerosHome: home });
    expect(result?.schemaVersion).toBe(1);
  });
});
