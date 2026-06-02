import { describe, expect, it } from 'vitest';
import {
  featureOptionVarName,
  featureOptionHints,
} from '../src/init/feature-doc.js';
import type { FeatureManifestSummary } from '../src/init/manifest.js';

describe('featureOptionVarName', () => {
  it('derives <FEATURE_ID>_<OPTION> uniformly', () => {
    const atl = 'ghcr.io/getmonoceros/monoceros-features/atlassian:1';
    expect(featureOptionVarName(atl, 'apiToken')).toBe('ATLASSIAN_API_TOKEN');
    expect(featureOptionVarName(atl, 'instance')).toBe('ATLASSIAN_INSTANCE');
    expect(featureOptionVarName(atl, 'bitbucketToken')).toBe(
      'ATLASSIAN_BITBUCKET_TOKEN',
    );
    expect(
      featureOptionVarName(
        'ghcr.io/getmonoceros/monoceros-features/claude-code:1',
        'apiKey',
      ),
    ).toBe('CLAUDE_CODE_API_KEY');
  });
});

describe('featureOptionHints', () => {
  const summary: FeatureManifestSummary = {
    name: 'Atlassian',
    description: 'Rovo Dev + twg',
    documentationURL: undefined,
    optionHints: ['instance', 'email', 'apiToken', 'bitbucketToken'],
    optionDescriptions: {},
    optionNames: ['instance', 'email', 'apiToken', 'bitbucketToken'],
    optionTypes: {},
    usageNotes: [],
  };
  const ref = 'ghcr.io/getmonoceros/monoceros-features/atlassian:1';

  it('maps every hint to key + envVar + ${placeholder}', () => {
    const hints = featureOptionHints(summary, ref);
    expect(hints).toEqual([
      {
        key: 'instance',
        envVar: 'ATLASSIAN_INSTANCE',
        placeholder: '${ATLASSIAN_INSTANCE}',
      },
      {
        key: 'email',
        envVar: 'ATLASSIAN_EMAIL',
        placeholder: '${ATLASSIAN_EMAIL}',
      },
      {
        key: 'apiToken',
        envVar: 'ATLASSIAN_API_TOKEN',
        placeholder: '${ATLASSIAN_API_TOKEN}',
      },
      {
        key: 'bitbucketToken',
        envVar: 'ATLASSIAN_BITBUCKET_TOKEN',
        placeholder: '${ATLASSIAN_BITBUCKET_TOKEN}',
      },
    ]);
  });

  it('excludes keys already set with an active value', () => {
    const hints = featureOptionHints(summary, ref, ['apiToken', 'email']);
    expect(hints.map((h) => h.key)).toEqual(['instance', 'bitbucketToken']);
  });

  it('returns [] for an unknown/third-party ref (no manifest)', () => {
    expect(featureOptionHints(undefined, 'ghcr.io/foo/bar:1')).toEqual([]);
  });
});
