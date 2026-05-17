import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_SCHEMA_VERSION,
  createDoc,
  parseConfig,
  readConfig,
  stringifyConfig,
  validateConfig,
  writeConfig,
} from '../src/config/index.js';

const MINIMAL_YML = `schemaVersion: 1
name: demo
`;

const FULL_YML = `schemaVersion: 1
name: sandbox
languages:
  - python
  - node
aptPackages:
  - make
  - openssh-client
  - jq
features:
  - ref: ghcr.io/devcontainers/features/docker-in-docker:2
    options:
      version: latest
installUrls:
  - https://teamwork-graph.atlassian.com/cli/install
services:
  - postgres
repos:
  - url: git@github.com:foo/bar.git
  - url: https://github.com/baz/qux.git
    name: ui
    branch: develop
git:
  user:
    name: Your Name
    email: you@example.com
`;

describe('validateConfig', () => {
  it('accepts a minimal config and applies defaults', () => {
    const cfg = validateConfig({ schemaVersion: 1, name: 'demo' });
    expect(cfg.name).toBe('demo');
    expect(cfg.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
    expect(cfg.languages).toEqual([]);
    expect(cfg.aptPackages).toEqual([]);
    expect(cfg.features).toEqual([]);
    expect(cfg.installUrls).toEqual([]);
    expect(cfg.services).toEqual([]);
    expect(cfg.repos).toEqual([]);
    expect(cfg.externalServices).toEqual({});
    expect(cfg.git).toBeUndefined();
  });

  it('rejects wrong schemaVersion', () => {
    expect(() =>
      validateConfig({ schemaVersion: 2, name: 'demo' }),
    ).toThrowError(/schemaVersion/);
  });

  it('rejects invalid solution names', () => {
    expect(() =>
      validateConfig({ schemaVersion: 1, name: 'has space' }),
    ).toThrowError(/name/);
    expect(() =>
      validateConfig({ schemaVersion: 1, name: 'has/slash' }),
    ).toThrowError(/name/);
  });

  it('rejects shell-metacharacter repo URLs', () => {
    expect(() =>
      validateConfig({
        schemaVersion: 1,
        name: 'demo',
        repos: [{ url: 'https://evil.com/foo;rm -rf /' }],
      }),
    ).toThrowError(/repos\.0\.url/);
  });

  it('rejects non-https install URLs', () => {
    expect(() =>
      validateConfig({
        schemaVersion: 1,
        name: 'demo',
        installUrls: ['http://insecure.example.com/install.sh'],
      }),
    ).toThrowError(/installUrls/);
  });

  it('rejects malformed feature refs', () => {
    expect(() =>
      validateConfig({
        schemaVersion: 1,
        name: 'demo',
        features: [{ ref: 'not-a-feature' }],
      }),
    ).toThrowError(/features\.0\.ref/);
  });

  it('rejects malformed apt package names', () => {
    expect(() =>
      validateConfig({
        schemaVersion: 1,
        name: 'demo',
        aptPackages: ['rm -rf'],
      }),
    ).toThrowError(/aptPackages/);
  });

  it('reports every issue at once', () => {
    let caught: Error | undefined;
    try {
      validateConfig({
        schemaVersion: 1,
        name: 'demo',
        aptPackages: ['bad package'],
        installUrls: ['ftp://no.example.com'],
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/aptPackages\.0/);
    expect(caught!.message).toMatch(/installUrls\.0/);
  });

  it('rejects malformed git.user.email', () => {
    expect(() =>
      validateConfig({
        schemaVersion: 1,
        name: 'demo',
        git: { user: { name: 'X', email: 'not-an-email' } },
      }),
    ).toThrowError(/git\.user\.email/);
  });

  it('accepts the full backlog example', () => {
    const cfg = validateConfig({
      schemaVersion: 1,
      name: 'sandbox',
      languages: ['python', 'node'],
      aptPackages: ['make', 'openssh-client', 'jq'],
      features: [
        {
          ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
          options: { version: 'latest' },
        },
      ],
      installUrls: ['https://teamwork-graph.atlassian.com/cli/install'],
      services: ['postgres'],
      repos: [
        { url: 'git@github.com:foo/bar.git' },
        {
          url: 'https://github.com/baz/qux.git',
          name: 'ui',
          branch: 'develop',
        },
      ],
      git: {
        user: {
          name: 'Your Name',
          email: 'you@example.com',
        },
      },
    });
    expect(cfg.features).toHaveLength(1);
    expect(cfg.features[0]!.options).toEqual({ version: 'latest' });
    expect(cfg.repos).toHaveLength(2);
    expect(cfg.repos[1]!.branch).toBe('develop');
    expect(cfg.git?.user?.email).toBe('you@example.com');
  });
});

describe('parseConfig', () => {
  it('parses minimal yaml', () => {
    const parsed = parseConfig(MINIMAL_YML);
    expect(parsed.config.name).toBe('demo');
    expect(parsed.config.schemaVersion).toBe(1);
    expect(parsed.source).toBe('<inline>');
  });

  it('parses the full backlog skeleton', () => {
    const parsed = parseConfig(FULL_YML);
    expect(parsed.config.name).toBe('sandbox');
    expect(parsed.config.languages).toEqual(['python', 'node']);
    expect(parsed.config.repos).toHaveLength(2);
    expect(parsed.config.features[0]!.ref).toBe(
      'ghcr.io/devcontainers/features/docker-in-docker:2',
    );
    expect(parsed.config.git?.user?.name).toBe('Your Name');
  });

  it('surfaces yaml syntax errors with source path', () => {
    expect(() =>
      parseConfig('schemaVersion: 1\n  bad: indent\n', '/x/y.yml'),
    ).toThrowError(/\/x\/y\.yml/);
  });

  it('surfaces schema errors with field paths', () => {
    expect(() =>
      parseConfig('schemaVersion: 1\nname: bad name\n'),
    ).toThrowError(/name/);
  });
});

describe('round-trip preservation', () => {
  it('keeps top-level comments through a parse+stringify cycle', () => {
    const yml = `# top-level comment
# spanning two lines
schemaVersion: 1
name: demo
`;
    const { doc } = parseConfig(yml);
    const out = stringifyConfig(doc);
    expect(out).toContain('# top-level comment');
    expect(out).toContain('# spanning two lines');
  });

  it('keeps inline comments on individual entries', () => {
    const yml = `schemaVersion: 1
name: demo
aptPackages:
  - make # build essential
  - jq # JSON in shell
`;
    const { doc } = parseConfig(yml);
    const out = stringifyConfig(doc);
    expect(out).toContain('# build essential');
    expect(out).toContain('# JSON in shell');
  });

  it('keeps inline comments after a structural mutation', () => {
    const yml = `schemaVersion: 1
name: demo
aptPackages:
  - make # build essential
  - jq # JSON in shell
`;
    const { doc } = parseConfig(yml);
    // Append a new entry via the AST (this is what add-apt-packages will
    // do in Task 5 — Task 1 just proves it survives).
    const apt = doc.get('aptPackages') as {
      add: (value: string) => void;
    };
    apt.add('curl');
    const out = stringifyConfig(doc);
    expect(out).toContain('# build essential');
    expect(out).toContain('# JSON in shell');
    expect(out).toContain('curl');
  });
});

describe('createDoc', () => {
  it('emits a stable, canonical yaml from a plain config', () => {
    const doc = createDoc({
      schemaVersion: 1,
      name: 'demo',
      languages: ['node'],
      aptPackages: [],
      features: [],
      installUrls: [],
      services: [],
      repos: [],
      externalServices: {},
    });
    const out = stringifyConfig(doc);
    // schemaVersion + name first, then languages; empty arrays/objects
    // are omitted.
    expect(out.split('\n').slice(0, 4)).toEqual([
      'schemaVersion: 1',
      'name: demo',
      'languages:',
      '  - node',
    ]);
    expect(out).not.toContain('aptPackages');
    expect(out).not.toContain('externalServices');
  });

  it('round-trips through parse+stringify without changes', () => {
    const config = {
      schemaVersion: 1 as const,
      name: 'sandbox',
      languages: ['node'],
      aptPackages: ['jq'],
      features: [
        {
          ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
          options: { version: 'latest' },
        },
      ],
      installUrls: [],
      services: ['postgres'],
      repos: [],
      externalServices: {},
    };
    const doc = createDoc(config);
    const yaml = stringifyConfig(doc);
    const { config: round } = parseConfig(yaml);
    expect(round).toEqual(config);
  });
});

describe('readConfig / writeConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'monoceros-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes and reads a config file', async () => {
    const file = path.join(dir, 'demo.yml');
    const doc = createDoc({
      schemaVersion: 1,
      name: 'demo',
      languages: ['node'],
      aptPackages: [],
      features: [],
      installUrls: [],
      services: [],
      repos: [],
      externalServices: {},
    });
    await writeConfig(file, doc);
    const text = await readFile(file, 'utf8');
    expect(text).toContain('name: demo');

    const parsed = await readConfig(file);
    expect(parsed.config.name).toBe('demo');
    expect(parsed.source).toBe(file);
  });

  it('readConfig surfaces source path in schema errors', async () => {
    const file = path.join(dir, 'broken.yml');
    await writeConfig(
      file,
      // ts-friendly bypass: cast through unknown so we can write an
      // intentionally invalid name without satisfying the schema.
      createDoc({
        schemaVersion: 1,
        name: 'looks-ok',
        languages: [],
        aptPackages: [],
        features: [],
        installUrls: [],
        services: [],
        repos: [],
        externalServices: {},
      }),
    );
    // Now overwrite with broken content.
    await import('node:fs').then((m) =>
      m.promises.writeFile(file, 'schemaVersion: 1\nname: has space\n'),
    );
    await expect(readConfig(file)).rejects.toThrow(/name/);
  });
});
