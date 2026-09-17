import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/init/index.js';
import { parseConfig } from '../src/config/index.js';
import {
  listWorkbenchTemplates,
  renderWorkbenchTemplate,
} from '../src/init/templates.js';
import { loadFeatureManifestSummary } from '../src/init/manifest.js';

const silentLogger = { success: () => {}, info: () => {} };

/**
 * A stand-in template dir. The tests drive the mechanism, not the shipped
 * `discovery-atlassian` content — a fixture keeps them from breaking every time
 * that file gains a component.
 */
async function writeTemplate(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${name}.yml`),
    [
      '# The workbench `__MONOCEROS_NAME__`, from a template.',
      'schemaVersion: 1',
      'name: __MONOCEROS_NAME__',
      'runtimeVersion: __MONOCEROS_RUNTIME_VERSION__',
      'features:',
      '  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
      '    options:',
      '      permissionMode: auto',
      '      apiKey: ${CLAUDE_CODE_API_KEY}',
      '    plugins:',
      '      - url: https://github.com/getmonoceros/monoceros-discovery.git',
      '        enable:',
      '          - discovery-atlassian',
      '',
    ].join('\n'),
    'utf8',
  );
}

describe('init --template', () => {
  let root: string;
  let monocerosHome: string;
  let templatesDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'monoceros-tpl-'));
    monocerosHome = path.join(root, '.local');
    templatesDir = path.join(root, 'templates', 'workbenches');
    await writeTemplate(templatesDir, 'demo');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes the template with the name substituted, keeping the plugin block flags cannot express', async () => {
    await runInit({
      name: 'acme',
      template: 'demo',
      monocerosHome,
      templatesDir,
      yes: true,
      logger: silentLogger,
    });

    const text = await readFile(
      path.join(monocerosHome, 'container-configs', 'acme.yml'),
      'utf8',
    );
    expect(text).toContain('name: acme');
    expect(text).toContain('The workbench `acme`');
    expect(text).not.toContain('__MONOCEROS_NAME__');
    expect(text).not.toContain('__MONOCEROS_RUNTIME_VERSION__');

    const { config } = parseConfig(text);
    const claude = config.features?.[0];
    expect(claude?.ref).toBe(
      'ghcr.io/getmonoceros/monoceros-features/claude-code:1',
    );
    // The reason templates exist: neither the nested plugins block nor a
    // yml-surfaced option can be said on the command line.
    expect(text).toContain('discovery-atlassian');
    expect(claude?.options?.permissionMode).toBe('auto');
  });

  it('seeds the template feature credentials into the env file', async () => {
    await runInit({
      name: 'acme',
      template: 'demo',
      monocerosHome,
      templatesDir,
      yes: true,
      logger: silentLogger,
    });
    const env = await readFile(
      path.join(monocerosHome, 'container-configs', 'acme.env'),
      'utf8',
    );
    expect(env).toContain('CLAUDE_CODE_API_KEY=');
  });

  it('applies --with-* on top of the template', async () => {
    await runInit({
      name: 'acme',
      template: 'demo',
      languages: ['node'],
      monocerosHome,
      templatesDir,
      yes: true,
      logger: silentLogger,
    });
    const text = await readFile(
      path.join(monocerosHome, 'container-configs', 'acme.yml'),
      'utf8',
    );
    const { config } = parseConfig(text);
    expect(config.languages?.some((l) => String(l).startsWith('node'))).toBe(
      true,
    );
    // The template's own content survives the add.
    expect(text).toContain('discovery-atlassian');
  });

  it('seeds a service the template carries, with its dev defaults', async () => {
    const userDir = path.join(monocerosHome, 'templates', 'workbenches');
    await mkdir(userDir, { recursive: true });
    await writeFile(
      path.join(userDir, 'withdb.yml'),
      [
        'schemaVersion: 1',
        'name: __MONOCEROS_NAME__',
        'runtimeVersion: __MONOCEROS_RUNTIME_VERSION__',
        'services:',
        '  - name: postgres',
        '    image: postgres:18',
        '    port: 5432',
        '    env:',
        '      POSTGRES_USER: ${POSTGRES_USER}',
        '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}',
        '      POSTGRES_DB: ${POSTGRES_DB}',
        '',
      ].join('\n'),
      'utf8',
    );
    await runInit({
      name: 'acme',
      template: 'withdb',
      monocerosHome,
      templatesDir,
      yes: true,
      logger: silentLogger,
    });
    const env = await readFile(
      path.join(monocerosHome, 'container-configs', 'acme.env'),
      'utf8',
    );
    // Working dev credentials, not blank keys: a postgres out of a template
    // has to come up the same way one added with `--with-services` does.
    expect(env).toContain('POSTGRES_USER=monoceros');
    expect(env).toContain('POSTGRES_PASSWORD=monoceros');
    expect(env).toContain('POSTGRES_DB=monoceros');
  });

  it('never asks about a service credential, only about feature ones', async () => {
    const userDir = path.join(monocerosHome, 'templates', 'workbenches');
    await mkdir(userDir, { recursive: true });
    await writeFile(
      path.join(userDir, 'both.yml'),
      [
        'schemaVersion: 1',
        'name: __MONOCEROS_NAME__',
        'runtimeVersion: __MONOCEROS_RUNTIME_VERSION__',
        'services:',
        '  - name: postgres',
        '    image: postgres:18',
        '    port: 5432',
        '    env:',
        '      POSTGRES_USER: ${POSTGRES_USER}',
        'features:',
        '  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
        '    options:',
        '      apiKey: ${CLAUDE_CODE_API_KEY}',
        '',
      ].join('\n'),
      'utf8',
    );
    const asked: string[] = [];
    await runInit({
      name: 'acme',
      template: 'both',
      monocerosHome,
      templatesDir,
      promptEnv: true,
      askEnvValue: async (c) => {
        asked.push(c.envVar);
        return '';
      },
      logger: silentLogger,
    });
    expect(asked).toEqual(['CLAUDE_CODE_API_KEY']);
  });

  it('rejects an unknown template and names the ones that exist', async () => {
    await expect(
      runInit({
        name: 'acme',
        template: 'nope',
        monocerosHome,
        templatesDir,
        yes: true,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Unknown template: "nope"\. Available: demo\./);
  });

  it('rejects a template name that would escape the templates dir', async () => {
    await expect(
      runInit({
        name: 'acme',
        template: '../../etc/passwd',
        monocerosHome,
        templatesDir,
        yes: true,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Unknown template/);
  });

  it('leaves no config behind when a --with-* entry is rejected', async () => {
    await expect(
      runInit({
        name: 'acme',
        template: 'demo',
        features: ['definitely-not-a-feature'],
        monocerosHome,
        templatesDir,
        yes: true,
        logger: silentLogger,
      }),
    ).rejects.toThrow();
    expect(
      existsSync(path.join(monocerosHome, 'container-configs', 'acme.yml')),
    ).toBe(false);
  });

  it('still refuses to overwrite an existing config', async () => {
    const opts = {
      name: 'acme',
      template: 'demo',
      monocerosHome,
      templatesDir,
      yes: true,
      logger: silentLogger,
    };
    await runInit(opts);
    await expect(runInit(opts)).rejects.toThrow(/Config already exists/);
  });

  it('finds a template the builder put in MONOCEROS_HOME', async () => {
    await writeTemplate(
      path.join(monocerosHome, 'templates', 'workbenches'),
      'mine',
    );
    await runInit({
      name: 'acme',
      template: 'mine',
      monocerosHome,
      templatesDir,
      yes: true,
      logger: silentLogger,
    });
    const text = await readFile(
      path.join(monocerosHome, 'container-configs', 'acme.yml'),
      'utf8',
    );
    expect(text).toContain('name: acme');
  });

  it("prefers the builder's template over a shipped one of the same name", async () => {
    const userDir = path.join(monocerosHome, 'templates', 'workbenches');
    await mkdir(userDir, { recursive: true });
    await writeFile(
      path.join(userDir, 'demo.yml'),
      [
        'schemaVersion: 1',
        'name: __MONOCEROS_NAME__',
        'runtimeVersion: __MONOCEROS_RUNTIME_VERSION__',
        '# mine, not the shipped one',
        '',
      ].join('\n'),
      'utf8',
    );
    await runInit({
      name: 'acme',
      template: 'demo',
      monocerosHome,
      templatesDir,
      yes: true,
      logger: silentLogger,
    });
    const text = await readFile(
      path.join(monocerosHome, 'container-configs', 'acme.yml'),
      'utf8',
    );
    expect(text).toContain('# mine, not the shipped one');
    expect(text).not.toContain('discovery-atlassian');
  });

  it('lists both directories, each name once', async () => {
    const userDir = path.join(monocerosHome, 'templates', 'workbenches');
    await writeTemplate(userDir, 'mine');
    await writeTemplate(userDir, 'demo');
    expect(
      listWorkbenchTemplates({ userDir, bundledDir: templatesDir }),
    ).toEqual(['demo', 'mine']);
  });

  it('refuses a template name that climbs out with ..', async () => {
    await expect(
      runInit({
        name: 'acme',
        template: '..%2Fdemo'.replace('%2F', '/'),
        monocerosHome,
        templatesDir,
        yes: true,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Unknown template/);
  });

  it('lists the shipped templates', () => {
    expect(listWorkbenchTemplates()).toContain('discovery-atlassian');
  });

  it('sets every option the shipped template names, and no option the catalog dropped', async () => {
    const text = await renderWorkbenchTemplate('discovery-atlassian', 'acme');
    const { config } = parseConfig(text);
    // A template is a frozen copy of a yml, so a renamed or retired option
    // would sit in it unnoticed until an apply rejected it. Check the names
    // against the live descriptors instead of against a second copy.
    for (const feature of config.features ?? []) {
      const summary = loadFeatureManifestSummary(feature.ref);
      expect(summary, `no descriptor for ${feature.ref}`).toBeDefined();
      for (const key of Object.keys(feature.options ?? {})) {
        expect(
          summary!.optionNames,
          `${feature.ref} has no option '${key}'`,
        ).toContain(key);
      }
    }
  });

  it('gives the roles the models the template recommends', async () => {
    const text = await renderWorkbenchTemplate('discovery-atlassian', 'acme');
    const { config } = parseConfig(text);
    const roles = (config.features ?? []).find((f) =>
      f.ref.includes('claude-code-roles'),
    );
    // Planning and reviewing carry the thinking, implementing follows a plan.
    expect(roles?.options).toMatchObject({
      plannerModel: 'opus',
      implementModel: 'sonnet',
      reviewModel: 'opus',
    });
  });

  it('renders the shipped discovery-atlassian template into a valid config', async () => {
    const text = await renderWorkbenchTemplate('discovery-atlassian', 'acme');
    const { config } = parseConfig(text);
    expect(config.name).toBe('acme');
    const refs = (config.features ?? []).map((f) => f.ref);
    expect(refs).toEqual([
      'ghcr.io/getmonoceros/monoceros-features/claude-code:1',
      'ghcr.io/getmonoceros/monoceros-features/claude-code-roles:1',
      'ghcr.io/getmonoceros/monoceros-features/atlassian:1',
    ]);
    // twg on its own: the lean shape the discovery chain expects.
    const atlassian = config.features?.[2];
    expect(atlassian?.options?.twg).toBe(true);
    expect(atlassian?.options?.rovodev).toBe(false);
    expect(atlassian?.options?.forge).toBe(false);
  });
});

describe('init env prompt', () => {
  let root: string;
  let monocerosHome: string;
  let templatesDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'monoceros-tpl-env-'));
    monocerosHome = path.join(root, '.local');
    templatesDir = path.join(root, 'templates', 'workbenches');
    await writeTemplate(templatesDir, 'demo');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('asks for the ${VAR} values the yml references and writes the answers', async () => {
    const asked: string[] = [];
    await runInit({
      name: 'acme',
      template: 'demo',
      monocerosHome,
      templatesDir,
      promptEnv: true,
      askEnvValue: async (c) => {
        asked.push(c.envVar);
        return 'sk-test';
      },
      logger: silentLogger,
    });
    expect(asked).toEqual(['CLAUDE_CODE_API_KEY']);
    const env = await readFile(
      path.join(monocerosHome, 'container-configs', 'acme.env'),
      'utf8',
    );
    expect(env).toContain('CLAUDE_CODE_API_KEY=sk-test');
  });

  it('leaves the key blank when the answer is empty', async () => {
    await runInit({
      name: 'acme',
      template: 'demo',
      monocerosHome,
      templatesDir,
      promptEnv: true,
      askEnvValue: async () => '',
      logger: silentLogger,
    });
    const env = await readFile(
      path.join(monocerosHome, 'container-configs', 'acme.env'),
      'utf8',
    );
    expect(env).toContain('CLAUDE_CODE_API_KEY=');
    expect(env).not.toMatch(/CLAUDE_CODE_API_KEY=\S/);
  });

  it('asks for a plain init too, with no template in sight', async () => {
    const asked: string[] = [];
    await runInit({
      name: 'plain',
      features: ['claude'],
      monocerosHome,
      promptEnv: true,
      askEnvValue: async (c) => {
        asked.push(c.envVar);
        return '';
      },
      logger: silentLogger,
    });
    expect(asked).toContain('CLAUDE_CODE_API_KEY');
  });

  it('asks for a credential an added component brought in, in the same block', async () => {
    const asked: string[] = [];
    await runInit({
      name: 'acme',
      template: 'demo',
      // A repo pulls in the provider's CLI feature, which has a token of its
      // own. That `add-*` seeds the key but must not ask for it itself: its
      // question would land before init has said what it is asking for, with
      // the rest arriving afterwards. One block, one order.
      withRepo: ['https://github.com/acme/app.git'],
      monocerosHome,
      templatesDir,
      promptEnv: true,
      askEnvValue: async (c) => {
        asked.push(c.envVar);
        return c.envVar === 'GITHUB_API_TOKEN' ? 'ghp_test' : '';
      },
      logger: silentLogger,
    });
    expect(asked).toContain('CLAUDE_CODE_API_KEY');
    expect(asked).toContain('GITHUB_API_TOKEN');
    const env = await readFile(
      path.join(monocerosHome, 'container-configs', 'acme.env'),
      'utf8',
    );
    expect(env).toContain('GITHUB_API_TOKEN=ghp_test');
  });

  it('asks nothing under --yes', async () => {
    let asked = 0;
    await runInit({
      name: 'acme',
      template: 'demo',
      monocerosHome,
      templatesDir,
      yes: true,
      askEnvValue: async () => {
        asked += 1;
        return 'x';
      },
      logger: silentLogger,
    });
    expect(asked).toBe(0);
  });
});
