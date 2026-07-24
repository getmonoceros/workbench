import { describe, expect, it } from 'vitest';
import {
  buildComposeYaml,
  buildDevcontainerJson,
  featureWorkspaceEnv,
} from '../src/create/scaffold.js';
import type { CreateOptions } from '../src/create/types.js';

const ATLASSIAN = 'ghcr.io/getmonoceros/monoceros-features/atlassian:1';
const GITHUB = 'ghcr.io/getmonoceros/monoceros-features/github-cli:1';
const GITLAB = 'ghcr.io/getmonoceros/monoceros-features/gitlab-cli:1';

const base: CreateOptions = {
  name: 'sandbox',
  languages: [],
  services: [],
};

// A minimal ResolvedFeature-shaped object for the pure-function tests.
// (ResolvedFeature is internal; we exercise the public renderer with the
// same structural shape it consumes.)
function feature(
  options: Record<string, unknown>,
  workspaceEnv: { whenOption?: string; vars: Record<string, string> }[],
) {
  return {
    devcontainerKey: './features/demo',
    options,
    persistentHomePaths: [],
    persistentHomeFiles: [],
    workspaceEnv,
  };
}

describe('featureWorkspaceEnv', () => {
  it('renders a gated block when its whenOption is truthy, substituting option values', () => {
    const env = featureWorkspaceEnv([
      feature({ forge: true, email: 'me@x.io', apiToken: 'sek' }, [
        {
          whenOption: 'forge',
          vars: { FORGE_EMAIL: '${email}', FORGE_API_TOKEN: '${apiToken}' },
        },
      ]),
    ]);
    expect(env).toEqual({ FORGE_EMAIL: 'me@x.io', FORGE_API_TOKEN: 'sek' });
  });

  it('emits nothing when the whenOption gate is off', () => {
    const env = featureWorkspaceEnv([
      feature({ forge: false, email: 'me@x.io', apiToken: 'sek' }, [
        { whenOption: 'forge', vars: { FORGE_EMAIL: '${email}' } },
      ]),
    ]);
    expect(env).toEqual({});
  });

  it('treats a block without whenOption as always on', () => {
    const env = featureWorkspaceEnv([
      feature({ region: 'eu' }, [{ vars: { REGION: '${region}' } }]),
    ]);
    expect(env).toEqual({ REGION: 'eu' });
  });

  it('drops a var that renders empty (secret not filled in yet)', () => {
    const env = featureWorkspaceEnv([
      feature({ forge: true, email: '', apiToken: 'sek' }, [
        {
          whenOption: 'forge',
          vars: { FORGE_EMAIL: '${email}', FORGE_API_TOKEN: '${apiToken}' },
        },
      ]),
    ]);
    // FORGE_EMAIL would be empty → skipped; FORGE_API_TOKEN survives.
    expect(env).toEqual({ FORGE_API_TOKEN: 'sek' });
  });

  it('gates "on" for a string-true value and "off" for the string "false"', () => {
    expect(
      featureWorkspaceEnv([
        feature({ forge: 'true', email: 'me@x.io' }, [
          { whenOption: 'forge', vars: { FORGE_EMAIL: '${email}' } },
        ]),
      ]),
    ).toEqual({ FORGE_EMAIL: 'me@x.io' });
    expect(
      featureWorkspaceEnv([
        feature({ forge: 'false', email: 'me@x.io' }, [
          { whenOption: 'forge', vars: { FORGE_EMAIL: '${email}' } },
        ]),
      ]),
    ).toEqual({});
  });
});

describe('atlassian forge → workspace runtime env (scaffold integration)', () => {
  it('compose mode: emits FORGE_* on the workspace service environment', () => {
    const yaml = buildComposeYaml({
      ...base,
      // a service forces compose mode
      services: [
        {
          name: 'postgres',
          image: 'postgres:16-alpine',
          port: 5432,
          env: {},
          volumes: [],
        },
      ],
      features: {
        [ATLASSIAN]: { forge: true, email: 'me@x.io', apiToken: 'sek' },
      },
    });
    expect(yaml).toContain('      FORGE_EMAIL: "me@x.io"');
    expect(yaml).toContain('      FORGE_API_TOKEN: "sek"');
  });

  it('compose mode: omits FORGE_* when forge is off', () => {
    const yaml = buildComposeYaml({
      ...base,
      services: [
        {
          name: 'postgres',
          image: 'postgres:16-alpine',
          port: 5432,
          env: {},
          volumes: [],
        },
      ],
      features: {
        [ATLASSIAN]: { forge: false, email: 'me@x.io', apiToken: 'sek' },
      },
    });
    expect(yaml).not.toContain('FORGE_EMAIL');
    expect(yaml).not.toContain('FORGE_API_TOKEN');
  });

  it('image mode: emits a containerEnv block with FORGE_*', () => {
    const dc = buildDevcontainerJson({
      ...base,
      features: {
        [ATLASSIAN]: { forge: true, email: 'me@x.io', apiToken: 'sek' },
      },
    });
    expect('containerEnv' in dc && dc.containerEnv).toEqual({
      FORGE_EMAIL: 'me@x.io',
      FORGE_API_TOKEN: 'sek',
    });
  });

  it('image mode: no containerEnv when forge is off', () => {
    const dc = buildDevcontainerJson({
      ...base,
      features: {
        [ATLASSIAN]: { forge: false, email: 'me@x.io', apiToken: 'sek' },
      },
    });
    expect('containerEnv' in dc).toBe(false);
  });
});

describe('github-cli → workspace runtime env (scaffold integration)', () => {
  it('image mode: emits GH_TOKEN on containerEnv when apiToken is set', () => {
    const dc = buildDevcontainerJson({
      ...base,
      features: { [GITHUB]: { apiToken: 'ghp_secret' } },
    });
    expect('containerEnv' in dc && dc.containerEnv).toEqual({
      GH_TOKEN: 'ghp_secret',
    });
  });

  it('image mode: no containerEnv when apiToken is empty', () => {
    const dc = buildDevcontainerJson({
      ...base,
      features: { [GITHUB]: { apiToken: '' } },
    });
    expect('containerEnv' in dc).toBe(false);
  });
});

describe('gitlab-cli → workspace runtime env (scaffold integration)', () => {
  it('image mode: emits GITLAB_TOKEN and GITLAB_HOST when both are set', () => {
    const dc = buildDevcontainerJson({
      ...base,
      features: {
        [GITLAB]: { apiToken: 'glpat-x', host: 'gitlab.example.com' },
      },
    });
    expect('containerEnv' in dc && dc.containerEnv).toEqual({
      GITLAB_TOKEN: 'glpat-x',
      GITLAB_HOST: 'gitlab.example.com',
    });
  });

  it('image mode: drops GITLAB_HOST when only a token is set (targets gitlab.com)', () => {
    const dc = buildDevcontainerJson({
      ...base,
      features: { [GITLAB]: { apiToken: 'glpat-x', host: '' } },
    });
    expect('containerEnv' in dc && dc.containerEnv).toEqual({
      GITLAB_TOKEN: 'glpat-x',
    });
  });
});
