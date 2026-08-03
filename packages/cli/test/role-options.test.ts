import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { validateRoleOptions } from '../src/create/role-options.js';

const CC = 'ghcr.io/getmonoceros/monoceros-features/claude-code-roles:1';
const OC = 'ghcr.io/getmonoceros/monoceros-features/opencode-roles:1';

describe('validateRoleOptions', () => {
  it('accepts an empty feature set', () => {
    expect(() => validateRoleOptions(undefined)).not.toThrow();
    expect(() => validateRoleOptions({})).not.toThrow();
  });

  it('accepts unset options, which mean inherit', () => {
    expect(() => validateRoleOptions({ [CC]: {}, [OC]: {} })).not.toThrow();
  });

  describe('claude-code-roles', () => {
    it('accepts the aliases and full model ids', () => {
      expect(() =>
        validateRoleOptions({
          [CC]: {
            plannerModel: 'opus',
            implementModel: 'sonnet',
            reviewModel: 'claude-opus-5',
          },
        }),
      ).not.toThrow();
    });

    // The typo that cost a whole run: the subagent refused to start, the
    // session picked its own replacement, and the chain finished on a model
    // nobody had chosen.
    it('rejects a mistyped model and names the likely one', () => {
      expect(() =>
        validateRoleOptions({ [CC]: { implementModel: 'sonet' } }),
      ).toThrow(
        /unknown model 'sonet' for implementModel.*Did you mean 'sonnet'\?/s,
      );
    });

    it('offers no suggestion when nothing is close', () => {
      expect(() =>
        validateRoleOptions({ [CC]: { plannerModel: 'gpt-5' } }),
      ).toThrow(/unknown model 'gpt-5'/);
      expect(() =>
        validateRoleOptions({ [CC]: { plannerModel: 'gpt-5' } }),
      ).not.toThrow(/Did you mean/);
    });

    it('accepts the five effort levels', () => {
      for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
        expect(() =>
          validateRoleOptions({ [CC]: { reviewEffort: effort } }),
        ).not.toThrow();
      }
    });

    it('rejects a mistyped effort and names the likely one', () => {
      expect(() =>
        validateRoleOptions({ [CC]: { plannerEffort: 'xhig' } }),
      ).toThrow(/unknown effort 'xhig'.*Did you mean 'xhigh'\?/s);
    });
  });

  describe('opencode-roles', () => {
    it('accepts provider/model-id references, including nested ones', () => {
      expect(() =>
        validateRoleOptions({
          [OC]: {
            plannerModel: 'anthropic/claude-sonnet-5',
            implementModel: 'openrouter/moonshotai/kimi-k3',
          },
        }),
      ).not.toThrow();
    });

    // A bare model name is the mistake worth catching: OpenCode needs the
    // provider prefix, and without it the request never reaches a provider.
    it('rejects a reference without a provider', () => {
      expect(() =>
        validateRoleOptions({ [OC]: { reviewModel: 'kimi-k3' } }),
      ).toThrow(/not a 'provider\/model-id' reference/);
    });

    // Which variants a model accepts comes from the model, so there is
    // nothing here to validate against and a value must pass through.
    it('passes any effort through untouched', () => {
      expect(() =>
        validateRoleOptions({
          [OC]: {
            plannerEffort: 'high',
            reviewEffort: 'whatever-the-model-takes',
          },
        }),
      ).not.toThrow();
    });
  });
});

// The option ORDER is part of the interface: `monoceros init` writes them into
// the yml in descriptor order, and a builder fills the values in by reading
// down. Grouped by kind (three models, then three efforts) that means six
// values in two blocks, and a real yml came back with `implementModel: xhigh`
// and `implementEffort: opus` swapped into each other. Grouped by role, each
// value sits under the label it belongs to.
describe('option order in the descriptors', () => {
  const EXPECTED = [
    'plannerModel',
    'plannerEffort',
    'implementModel',
    'implementEffort',
    'reviewModel',
    'reviewEffort',
  ];

  it.each(['claude-code-roles', 'opencode-roles'])(
    'pairs each role model with its effort in %s',
    async (component) => {
      const yml = await readFile(
        new URL(
          `../../../components/features/${component}/component.yml`,
          import.meta.url,
        ),
        'utf8',
      );
      const found = [...yml.matchAll(/^ {2}(\w+):$/gm)].map((m) => m[1]!);
      expect(found.filter((n) => EXPECTED.includes(n))).toEqual(EXPECTED);
    },
  );
});
