import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAddRepo } from '../src/modify/index.js';
import {
  resolveRepoTokens,
  resolveContainerRepoTokens,
  formatUnauthenticatedRepos,
  formatTokenUse,
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

describe('resolveRepoTokens (ADR 0031 token cascade)', () => {
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

  const githubCliRef = (): string =>
    catalog.get('github')!.file.contributes.features![0]!.ref;

  it('layer 1: <PROVIDER>_API_TOKEN wins and is injected into the feature', async () => {
    await seedRepo('demo', 'https://github.com/conciso/app.git');
    const config = await configOf('demo');
    const r = resolveRepoTokens(config, catalog, {
      GITHUB_API_TOKEN: 'ghp_1',
      GIT_TOKEN__GITHUB_CONCISO: 'ghp_2',
    });
    expect(r.hostTokens.get('github.com')).toBe('ghp_1');
    expect(r.used).toEqual([
      {
        host: 'github.com',
        provider: 'github',
        varName: 'GITHUB_API_TOKEN',
        source: 'repo',
      },
    ]);
    expect(formatTokenUse(r.used[0]!)).toBe(
      'Repo token: GitHub (github.com) → GITHUB_API_TOKEN',
    );
    // Injected into the CLI feature so the container gh gets GH_TOKEN.
    const feat = r.features.find((f) => f.ref === githubCliRef());
    expect(feat?.options?.apiToken).toBe('ghp_1');
    expect(r.missing).toEqual([]);
  });

  it('layer 2: GIT_TOKEN__<PROVIDER>_<SEGMENT> keyed by first path segment', async () => {
    await seedRepo('demo', 'https://github.com/conciso/app.git');
    const config = await configOf('demo');
    const r = resolveRepoTokens(config, catalog, {
      GIT_TOKEN__GITHUB_CONCISO: 'ghp_2',
    });
    expect(r.hostTokens.get('github.com')).toBe('ghp_2');
    expect(r.used[0]!.varName).toBe('GIT_TOKEN__GITHUB_CONCISO');
  });

  it('layer 3: GIT_TOKEN__<PROVIDER> provider-wide fallback', async () => {
    await seedRepo('demo', 'https://github.com/conciso/app.git');
    const config = await configOf('demo');
    const r = resolveRepoTokens(config, catalog, {
      GIT_TOKEN__GITHUB: 'ghp_3',
    });
    expect(r.used[0]!.varName).toBe('GIT_TOKEN__GITHUB');
  });

  it('reports missing with the tried vars when no token is set', async () => {
    await seedRepo('demo', 'https://github.com/conciso/app.git');
    const config = await configOf('demo');
    const r = resolveRepoTokens(config, catalog, {});
    expect(r.hostTokens.size).toBe(0);
    expect(r.missing[0]!.tried).toEqual([
      'GITHUB_API_TOKEN',
      'GIT_TOKEN__GITHUB_CONCISO',
      'GIT_TOKEN__GITHUB',
    ]);
    const msg = formatUnauthenticatedRepos(r.missing, 'demo');
    expect(msg).toContain('UNAUTHENTICATED');
    expect(msg).toContain('GITHUB_API_TOKEN');
    expect(msg).toContain('container-configs/demo.env');
    expect(msg).toContain('GIT_TOKEN__GITHUB_CONCISO');
    expect(msg).toContain('monoceros-config.env');
  });

  it('bitbucket uses the same cascade (BITBUCKET_API_TOKEN then workspace)', async () => {
    await seedRepo('demo', 'https://bitbucket.org/conciso/app.git');
    const config = await configOf('demo');

    // Layer 2: workspace-keyed.
    const byWorkspace = resolveRepoTokens(config, catalog, {
      GIT_TOKEN__BITBUCKET_CONCISO: 'atatt',
    });
    expect(byWorkspace.hostTokens.get('bitbucket.org')).toBe('atatt');
    expect(byWorkspace.used[0]!.varName).toBe('GIT_TOKEN__BITBUCKET_CONCISO');

    // Layer 1: BITBUCKET_API_TOKEN — same per-container override the other
    // providers have, so all three read the same way.
    const byApiToken = resolveRepoTokens(config, catalog, {
      BITBUCKET_API_TOKEN: 'atatt_1',
      GIT_TOKEN__BITBUCKET_CONCISO: 'atatt_2',
    });
    expect(byApiToken.used[0]!.varName).toBe('BITBUCKET_API_TOKEN');
  });

  it('is empty when there are no repos', async () => {
    await writeFile(ymlPath('demo'), 'schemaVersion: 1\nname: demo\n');
    const config = await configOf('demo');
    const r = resolveRepoTokens(config, catalog, {});
    expect(r.hostTokens.size).toBe(0);
    expect(r.missing).toEqual([]);
    expect(r.features).toEqual(config.features);
  });

  async function seedFeatureOnly(name: string, ref: string): Promise<void> {
    await writeFile(
      ymlPath(name),
      `schemaVersion: 1\nname: ${name}\nfeatures:\n  - ref: ${ref}\n`,
    );
  }

  describe('provider CLI feature without a repo (ADR 0031)', () => {
    it('auto-uses the sole GIT_TOKEN__<PROVIDER>_<ORG> token', async () => {
      await seedFeatureOnly('demo', githubCliRef());
      const config = await configOf('demo');
      const r = resolveRepoTokens(config, catalog, {
        GIT_TOKEN__GITHUB_KUNDE1: 'ghp_org',
      });
      expect(r.ambiguous).toEqual([]);
      expect(r.missing).toEqual([]);
      expect(r.hostTokens.get('github.com')).toBe('ghp_org');
      expect(r.used[0]!.varName).toBe('GIT_TOKEN__GITHUB_KUNDE1');
      // source 'feature' → logged as "CLI token", not "Repo token".
      expect(r.used[0]!.source).toBe('feature');
      expect(formatTokenUse(r.used[0]!)).toBe(
        'CLI token: GitHub (github.com) → GIT_TOKEN__GITHUB_KUNDE1',
      );
      const feat = r.features.find((f) => f.ref === githubCliRef());
      expect(feat?.options?.apiToken).toBe('ghp_org');
    });

    it('GITHUB_API_TOKEN / GIT_TOKEN__GITHUB take precedence over org tokens', async () => {
      await seedFeatureOnly('demo', githubCliRef());
      const config = await configOf('demo');
      const direct = resolveRepoTokens(config, catalog, {
        GITHUB_API_TOKEN: 'ghp_direct',
        GIT_TOKEN__GITHUB_KUNDE1: 'ghp_org',
      });
      expect(direct.ambiguous).toEqual([]);
      expect(direct.used[0]!.varName).toBe('GITHUB_API_TOKEN');
      expect(direct.hostTokens.get('github.com')).toBe('ghp_direct');

      const wide = resolveRepoTokens(config, catalog, {
        GIT_TOKEN__GITHUB: 'ghp_wide',
        GIT_TOKEN__GITHUB_KUNDE1: 'ghp_org',
      });
      expect(wide.used[0]!.varName).toBe('GIT_TOKEN__GITHUB');
    });

    it('multiple org tokens are ambiguous (builder must pick)', async () => {
      await seedFeatureOnly('demo', githubCliRef());
      const config = await configOf('demo');
      const r = resolveRepoTokens(config, catalog, {
        GIT_TOKEN__GITHUB_KUNDE1: 'ghp_1',
        GIT_TOKEN__GITHUB_KUNDE2: 'ghp_2',
      });
      expect(r.used).toEqual([]);
      expect(r.missing).toEqual([]);
      expect(r.hostTokens.size).toBe(0);
      expect(r.ambiguous).toEqual([
        {
          provider: 'github',
          featureRef: githubCliRef(),
          host: 'github.com',
          candidates: ['GIT_TOKEN__GITHUB_KUNDE1', 'GIT_TOKEN__GITHUB_KUNDE2'],
        },
      ]);
    });

    it('no token at all is reported as missing (non-fatal)', async () => {
      await seedFeatureOnly('demo', githubCliRef());
      const config = await configOf('demo');
      const r = resolveRepoTokens(config, catalog, {});
      expect(r.ambiguous).toEqual([]);
      expect(r.missing[0]!.tried).toEqual([
        'GITHUB_API_TOKEN',
        'GIT_TOKEN__GITHUB',
      ]);
    });

    it('a repo for the provider suppresses the feature-only pass', async () => {
      // github repo present → resolved by the repo cascade, so the
      // feature-only loop must not also emit ambiguous/missing for github.
      await seedRepo('demo', 'https://github.com/conciso/app.git');
      const config = await configOf('demo');
      const r = resolveRepoTokens(config, catalog, {
        GITHUB_API_TOKEN: 'ghp_repo',
        GIT_TOKEN__GITHUB_KUNDE1: 'ghp_org',
        GIT_TOKEN__GITHUB_KUNDE2: 'ghp_org2',
      });
      expect(r.ambiguous).toEqual([]);
      expect(r.used).toHaveLength(1);
      expect(r.used[0]!.varName).toBe('GITHUB_API_TOKEN');
    });
  });

  it('resolveContainerRepoTokens reads yml + env by container name', async () => {
    await seedRepo('demo', 'https://github.com/conciso/app.git');
    await writeFile(
      path.join(home, 'container-configs', 'demo.env'),
      'GITHUB_API_TOKEN=ghp_env\n',
    );
    const r = await resolveContainerRepoTokens('demo', home, catalog);
    expect(r.hostTokens.get('github.com')).toBe('ghp_env');
  });
});
