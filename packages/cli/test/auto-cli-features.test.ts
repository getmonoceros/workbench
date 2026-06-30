import { describe, expect, it } from 'vitest';
import { autoAddRepoCliFeatures } from '../src/apply/auto-cli-features.js';
import { gitTokenEnvVar } from '../src/devcontainer/credentials.js';
import type { CreateOptions } from '../src/create/types.js';

function makeOpts(
  repos: CreateOptions['repos'],
  features: CreateOptions['features'] = undefined,
): CreateOptions {
  return {
    name: 'demo',
    languages: [],
    services: [],
    ...(repos ? { repos } : {}),
    ...(features ? { features } : {}),
  } as CreateOptions;
}

function featureKey(
  opts: CreateOptions,
  idFragment: string,
): string | undefined {
  return Object.keys(opts.features ?? {}).find((k) => k.includes(idFragment));
}

describe('autoAddRepoCliFeatures', () => {
  it('adds the github-cli feature with apiToken for a github.com repo', async () => {
    const opts = makeOpts([
      { url: 'https://github.com/acme/app.git', path: 'app' },
    ]);
    const added = await autoAddRepoCliFeatures(opts, {
      [gitTokenEnvVar('github.com')]: 'ghp_secret',
    });
    expect(added).toMatchObject([
      { name: 'github', provider: 'github', authenticated: true },
    ]);
    const key = featureKey(opts, 'github-cli');
    expect(key).toBeDefined();
    expect(opts.features![key!]).toMatchObject({ apiToken: 'ghp_secret' });
    expect(opts.features![key!]).not.toHaveProperty('host');
  });

  it('adds gitlab-cli with apiToken + host for a self-hosted GitLab repo', async () => {
    const opts = makeOpts([
      {
        url: 'https://gitlab.acme.example.com/team/app.git',
        path: 'app',
        provider: 'gitlab',
      },
    ]);
    const added = await autoAddRepoCliFeatures(opts, {
      [gitTokenEnvVar('gitlab.acme.example.com')]: 'glpat_secret',
    });
    expect(added).toMatchObject([{ name: 'gitlab', authenticated: true }]);
    const key = featureKey(opts, 'gitlab-cli');
    expect(key).toBeDefined();
    expect(opts.features![key!]).toMatchObject({
      apiToken: 'glpat_secret',
      host: 'gitlab.acme.example.com',
    });
  });

  it('omits host for gitlab.com (SaaS default)', async () => {
    const opts = makeOpts([
      { url: 'https://gitlab.com/acme/app.git', path: 'app' },
    ]);
    await autoAddRepoCliFeatures(opts, {
      [gitTokenEnvVar('gitlab.com')]: 'glpat_secret',
    });
    const key = featureKey(opts, 'gitlab-cli');
    expect(opts.features![key!]).not.toHaveProperty('host');
  });

  it('still adds the feature without a PAT, but flags it unauthenticated', async () => {
    const opts = makeOpts([
      { url: 'https://github.com/acme/app.git', path: 'app' },
    ]);
    const added = await autoAddRepoCliFeatures(opts, {});
    // Feature is added (always), but reported as not authenticated so the
    // caller can tell the builder to run `gh auth login`.
    expect(added).toMatchObject([
      {
        name: 'github',
        authenticated: false,
        envVar: gitTokenEnvVar('github.com'),
      },
    ]);
    const key = featureKey(opts, 'github-cli');
    expect(key).toBeDefined();
    expect(opts.features![key!]).not.toHaveProperty('apiToken');
  });

  it('leaves a builder-declared feature untouched (explicit config wins)', async () => {
    // First call learns the canonical ref and seeds it as if the
    // builder had declared it with their own token.
    const seed = makeOpts([
      { url: 'https://github.com/acme/app.git', path: 'app' },
    ]);
    await autoAddRepoCliFeatures(seed, {
      [gitTokenEnvVar('github.com')]: 'builder_token',
    });
    const ref = featureKey(seed, 'github-cli')!;

    const opts = makeOpts(
      [{ url: 'https://github.com/acme/app.git', path: 'app' }],
      { [ref]: { apiToken: 'builder_token' } },
    );
    const added = await autoAddRepoCliFeatures(opts, {
      [gitTokenEnvVar('github.com')]: 'different_token',
    });
    expect(added).toEqual([]);
    expect(opts.features![ref]).toMatchObject({ apiToken: 'builder_token' });
  });

  it('is a no-op with no repos', async () => {
    const opts = makeOpts(undefined);
    const added = await autoAddRepoCliFeatures(opts, {});
    expect(added).toEqual([]);
  });
});
