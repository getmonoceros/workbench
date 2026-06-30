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
    const result = await autoAddRepoCliFeatures(opts, {
      [gitTokenEnvVar('github.com')]: 'ghp_secret',
    });
    expect(result.added).toContain('github');
    expect(result.missingToken).toEqual([]);
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
    const result = await autoAddRepoCliFeatures(opts, {
      [gitTokenEnvVar('gitlab.acme.example.com')]: 'glpat_secret',
    });
    expect(result.added).toContain('gitlab');
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

  it('does NOT add the feature when no PAT is configured; reports missingToken', async () => {
    const opts = makeOpts([
      { url: 'https://github.com/acme/app.git', path: 'app' },
    ]);
    const result = await autoAddRepoCliFeatures(opts, {});
    // No unauthenticated CLI is added.
    expect(result.added).toEqual([]);
    expect(featureKey(opts, 'github-cli')).toBeUndefined();
    // ...but the gap is reported so apply can warn the builder.
    expect(result.missingToken).toEqual([
      {
        provider: 'github',
        host: 'github.com',
        envVar: gitTokenEnvVar('github.com'),
      },
    ]);
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
    const result = await autoAddRepoCliFeatures(opts, {
      [gitTokenEnvVar('github.com')]: 'different_token',
    });
    expect(result.added).toEqual([]);
    expect(opts.features![ref]).toMatchObject({ apiToken: 'builder_token' });
  });

  it('is a no-op with no repos', async () => {
    const opts = makeOpts(undefined);
    const result = await autoAddRepoCliFeatures(opts, {});
    expect(result.added).toEqual([]);
    expect(result.missingToken).toEqual([]);
  });
});
