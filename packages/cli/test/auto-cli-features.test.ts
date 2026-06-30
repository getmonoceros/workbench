import { describe, expect, it } from 'vitest';
import {
  autoAddRepoCliFeatures,
  type TokenPrompt,
} from '../src/apply/auto-cli-features.js';
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

// Prompts: one that never picks (cancel / non-interactive), one that picks
// a specific var.
const noPick: TokenPrompt = async () => undefined;
const pick =
  (varName: string): TokenPrompt =>
  async () =>
    varName;

describe('autoAddRepoCliFeatures', () => {
  it('uses the single GIT_TOKEN__GITHUB_* candidate for a github.com repo', async () => {
    const opts = makeOpts([
      { url: 'https://github.com/acme/app.git', path: 'app' },
    ]);
    const res = await autoAddRepoCliFeatures(
      opts,
      { GIT_TOKEN__GITHUB_CONCISO: 'ghp_secret' },
      noPick,
    );
    expect(res.added).toMatchObject([
      { name: 'github', provider: 'github', authenticated: true },
    ]);
    expect(res.hostTokens).toEqual({ 'github.com': 'ghp_secret' });
    const key = featureKey(opts, 'github-cli')!;
    expect(opts.features![key]).toMatchObject({ apiToken: 'ghp_secret' });
    // Persisted as the ${VAR} reference, not the value.
    expect(res.persist).toEqual([
      { ref: key, options: { apiToken: '${GIT_TOKEN__GITHUB_CONCISO}' } },
    ]);
  });

  it('prompts when several candidates match, and uses the pick', async () => {
    const opts = makeOpts([
      { url: 'https://github.com/acme/app.git', path: 'app' },
    ]);
    const res = await autoAddRepoCliFeatures(
      opts,
      {
        GIT_TOKEN__GITHUB_CONCISO: 'ghp_work',
        GIT_TOKEN__GITHUB_PICTOR: 'ghp_private',
      },
      pick('GIT_TOKEN__GITHUB_PICTOR'),
    );
    expect(res.added[0]!.authenticated).toBe(true);
    expect(res.hostTokens).toEqual({ 'github.com': 'ghp_private' });
    expect(res.persist[0]!.options).toEqual({
      apiToken: '${GIT_TOKEN__GITHUB_PICTOR}',
    });
  });

  it('reports needs-pick when several candidates and none chosen', async () => {
    const opts = makeOpts([
      { url: 'https://github.com/acme/app.git', path: 'app' },
    ]);
    const res = await autoAddRepoCliFeatures(
      opts,
      {
        GIT_TOKEN__GITHUB_CONCISO: 'ghp_work',
        GIT_TOKEN__GITHUB_PICTOR: 'ghp_private',
      },
      noPick,
    );
    expect(res.added).toMatchObject([
      { name: 'github', authenticated: false, reason: 'needs-pick' },
    ]);
    expect(res.hostTokens).toEqual({});
    expect(res.persist).toEqual([]);
  });

  it('reports no-token when there is no candidate', async () => {
    const opts = makeOpts([
      { url: 'https://github.com/acme/app.git', path: 'app' },
    ]);
    const res = await autoAddRepoCliFeatures(opts, {}, noPick);
    expect(res.added).toMatchObject([
      { name: 'github', authenticated: false, reason: 'no-token' },
    ]);
    expect(res.hostTokens).toEqual({});
    const key = featureKey(opts, 'github-cli')!;
    expect(opts.features![key]).not.toHaveProperty('apiToken');
  });

  it('sets host + apiToken for a self-hosted GitLab repo', async () => {
    const opts = makeOpts([
      {
        url: 'https://gitlab.acme.example.com/team/app.git',
        path: 'app',
        provider: 'gitlab',
      },
    ]);
    const res = await autoAddRepoCliFeatures(
      opts,
      { GIT_TOKEN__GITLAB_CONCISO: 'glpat_secret' },
      noPick,
    );
    expect(res.added[0]!.authenticated).toBe(true);
    const key = featureKey(opts, 'gitlab-cli')!;
    expect(opts.features![key]).toMatchObject({
      apiToken: 'glpat_secret',
      host: 'gitlab.acme.example.com',
    });
    expect(res.persist[0]!.options).toEqual({
      apiToken: '${GIT_TOKEN__GITLAB_CONCISO}',
      host: 'gitlab.acme.example.com',
    });
  });

  it('omits host for gitlab.com', async () => {
    const opts = makeOpts([
      { url: 'https://gitlab.com/acme/app.git', path: 'app' },
    ]);
    await autoAddRepoCliFeatures(
      opts,
      { GIT_TOKEN__GITLAB_CONCISO: 'glpat_secret' },
      noPick,
    );
    const key = featureKey(opts, 'gitlab-cli')!;
    expect(opts.features![key]).not.toHaveProperty('host');
  });

  it('authenticates GitHub Enterprise Cloud (*.ghe.com)', async () => {
    const opts = makeOpts([
      {
        url: 'https://acme.ghe.com/team/app.git',
        path: 'app',
        provider: 'github',
      },
    ]);
    const res = await autoAddRepoCliFeatures(
      opts,
      { GIT_TOKEN__GITHUB_CONCISO: 'ghp_secret' },
      noPick,
    );
    expect(res.added[0]!.authenticated).toBe(true);
    expect(res.hostTokens).toEqual({ 'acme.ghe.com': 'ghp_secret' });
  });

  it('reports enterprise-unsupported for self-hosted GitHub Enterprise Server', async () => {
    const opts = makeOpts([
      {
        url: 'https://github.acme-corp.io/team/app.git',
        path: 'app',
        provider: 'github',
      },
    ]);
    const res = await autoAddRepoCliFeatures(
      opts,
      { GIT_TOKEN__GITHUB_CONCISO: 'ghp_secret' },
      noPick,
    );
    expect(res.added).toMatchObject([
      {
        name: 'github',
        authenticated: false,
        reason: 'enterprise-unsupported',
      },
    ]);
    // No auto-token for GHES: neither feature apiToken nor clone token.
    expect(res.hostTokens).toEqual({});
    const key = featureKey(opts, 'github-cli')!;
    expect(opts.features![key]).not.toHaveProperty('apiToken');
  });

  it('leaves an already-declared feature untouched but feeds its token to the clone', async () => {
    // Seed the canonical ref by resolving once.
    const seed = makeOpts([
      { url: 'https://github.com/acme/app.git', path: 'app' },
    ]);
    await autoAddRepoCliFeatures(
      seed,
      { GIT_TOKEN__GITHUB_CONCISO: 'ghp_seed' },
      noPick,
    );
    const ref = featureKey(seed, 'github-cli')!;

    // The builder already declared it (apiToken already resolved).
    const opts = makeOpts(
      [{ url: 'https://github.com/acme/app.git', path: 'app' }],
      { [ref]: { apiToken: 'ghp_existing' } },
    );
    const res = await autoAddRepoCliFeatures(
      opts,
      { GIT_TOKEN__GITHUB_CONCISO: 'ghp_different' },
      noPick,
    );
    expect(res.added).toEqual([]);
    expect(res.persist).toEqual([]);
    // ...but the clone still uses the declared token.
    expect(res.hostTokens).toEqual({ 'github.com': 'ghp_existing' });
  });

  it('is a no-op with no repos', async () => {
    const res = await autoAddRepoCliFeatures(makeOpts(undefined), {}, noPick);
    expect(res).toEqual({ added: [], hostTokens: {}, persist: [] });
  });
});
