import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAddRepo } from '../src/modify/index.js';
import {
  resolveRepoTokens,
  type ResolveRepoTokensDeps,
  type TokenPrompt,
} from '../src/apply/repo-token.js';
import { loadComponentCatalog } from '../src/init/components.js';
import { parseConfig } from '../src/config/index.js';
import type { SolutionConfig } from '../src/config/schema.js';

const silentLogger = { info: () => {}, success: () => {}, warn: () => {} };

const baseOpts = {
  yes: true,
  logger: silentLogger,
  confirm: async () => true,
  output: () => {},
  containerLookupDocker: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
};

describe('resolveRepoTokens (apply-time repo token binding, ADR 0031)', () => {
  let home: string;
  let catalog: Awaited<ReturnType<typeof loadComponentCatalog>>;

  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'monoceros-token-'));
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
    catalog = await loadComponentCatalog();
  });

  afterEach(() => {
    if (home && existsSync(home))
      rmSync(home, { recursive: true, force: true });
  });

  const ymlPath = (name: string) =>
    path.join(home, 'container-configs', `${name}.yml`);

  async function seedRepo(name: string, url: string): Promise<void> {
    await writeFile(ymlPath(name), `schemaVersion: 1\nname: ${name}\n`);
    await runAddRepo({ ...baseOpts, name, url, monocerosHome: home });
  }

  async function configOf(name: string): Promise<SolutionConfig> {
    return parseConfig(await readFile(ymlPath(name), 'utf8')).config;
  }

  function deps(
    extra: Partial<ResolveRepoTokensDeps> & {
      envVars: Record<string, string>;
    },
    name = 'demo',
  ): ResolveRepoTokensDeps {
    return {
      ymlPath: ymlPath(name),
      home,
      catalog,
      logger: silentLogger,
      ...extra,
    };
  }

  it('binds the chosen GIT_TOKEN__ var when the feature token is empty', async () => {
    await seedRepo('demo', 'https://github.com/foo/bar.git');
    const config = await configOf('demo');
    const prompt = vi.fn<TokenPrompt>(async () => 'GIT_TOKEN__GITHUB_CONCISO');

    const features = await resolveRepoTokens(
      config,
      deps({
        envVars: {
          GIT_TOKEN__GITHUB_CONCISO: 'ghp_x',
          GIT_TOKEN__GITHUB_PICTOR: 'ghp_y',
        },
        prompt,
      }),
    );

    // Both matching vars offered, sorted.
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt.mock.calls[0]![0].candidates).toEqual([
      'GIT_TOKEN__GITHUB_CONCISO',
      'GIT_TOKEN__GITHUB_PICTOR',
    ]);
    // yml rewritten in place with the concrete var.
    const yml = await readFile(ymlPath('demo'), 'utf8');
    expect(yml).toContain('apiToken: ${GIT_TOKEN__GITHUB_CONCISO}');
    // Returned features reflect the binding for the apply pass.
    const feature = features.find((f) => f.ref.includes('github-cli'));
    expect(feature?.options?.apiToken).toBe('${GIT_TOKEN__GITHUB_CONCISO}');
  });

  it('skips (no prompt) when the feature token already resolves non-empty', async () => {
    await seedRepo('demo', 'https://github.com/foo/bar.git');
    const config = await configOf('demo');
    const prompt = vi.fn<TokenPrompt>();

    await resolveRepoTokens(
      config,
      deps({ envVars: { GITHUB_CLI_API_TOKEN: 'ghp_filled' }, prompt }),
    );

    expect(prompt).not.toHaveBeenCalled();
    const yml = await readFile(ymlPath('demo'), 'utf8');
    expect(yml).toContain('apiToken: ${GITHUB_CLI_API_TOKEN}');
  });

  it('aborts when the builder cancels the pick', async () => {
    await seedRepo('demo', 'https://github.com/foo/bar.git');
    const config = await configOf('demo');

    await expect(
      resolveRepoTokens(
        config,
        deps({
          envVars: { GIT_TOKEN__GITHUB_CONCISO: 'ghp_x' },
          prompt: async () => null,
        }),
      ),
    ).rejects.toThrow(/aborted/i);
    // yml untouched on abort.
    const yml = await readFile(ymlPath('demo'), 'utf8');
    expect(yml).toContain('apiToken: ${GITHUB_CLI_API_TOKEN}');
  });

  it('aborts with an actionable hint when no GIT_TOKEN__ candidate exists', async () => {
    await seedRepo('demo', 'https://github.com/foo/bar.git');
    const config = await configOf('demo');
    const prompt = vi.fn<TokenPrompt>();

    await expect(
      resolveRepoTokens(config, deps({ envVars: {}, prompt })),
    ).rejects.toThrow(/GIT_TOKEN__GITHUB_/);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('binds gitlab tokens for a gitlab repo', async () => {
    await seedRepo('gl', 'https://gitlab.com/foo/bar.git');
    const config = await configOf('gl');
    const prompt = vi.fn<TokenPrompt>(async () => 'GIT_TOKEN__GITLAB_WORK');

    await resolveRepoTokens(
      config,
      deps({ envVars: { GIT_TOKEN__GITLAB_WORK: 'glpat_x' }, prompt }, 'gl'),
    );

    expect(prompt).toHaveBeenCalledOnce();
    const yml = await readFile(ymlPath('gl'), 'utf8');
    expect(yml).toContain('apiToken: ${GIT_TOKEN__GITLAB_WORK}');
  });

  it('is a no-op when there are no repos', async () => {
    await writeFile(ymlPath('demo'), 'schemaVersion: 1\nname: demo\n');
    const config = await configOf('demo');
    const prompt = vi.fn<TokenPrompt>();

    const features = await resolveRepoTokens(
      config,
      deps({ envVars: {}, prompt }),
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(features).toEqual(config.features);
  });
});
