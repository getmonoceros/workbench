import { defineCommand } from 'citty';
import { consola } from 'consola';
import type { FeatureOptions } from '../create/types.js';
import { getInnerArgs } from '../inner-args.js';
import { runAddFeature } from '../modify/index.js';
import { CLI_VERSION } from '../version.js';

export const addFeatureCommand = defineCommand({
  meta: {
    name: 'add-feature',
    description:
      'Add a devcontainer feature by ref (e.g. `ghcr.io/devcontainers/features/docker-in-docker:2`). Options follow `--` as `key=value` pairs. Idempotent (same ref + same options is a no-op). Adding the same ref with different options is an error.',
  },
  args: {
    ref: {
      type: 'positional',
      description:
        'Devcontainer feature ref (OCI image style, e.g. `ghcr.io/devcontainers/features/docker-in-docker:2`).',
      required: true,
    },
    project: {
      type: 'string',
      description:
        'Override the auto-detected project (path, absolute or relative to cwd).',
    },
    yes: {
      type: 'boolean',
      description: 'Skip the interactive confirmation and apply the diff.',
      alias: ['y'],
      default: false,
    },
  },
  async run({ args }) {
    const ref = String(args.ref);
    let options: FeatureOptions;
    try {
      options = parseOptionsAfterDashes(getInnerArgs());
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    try {
      const result = await runAddFeature({
        ref,
        options,
        project: typeof args.project === 'string' ? args.project : undefined,
        yes: args.yes,
        cliVersion: CLI_VERSION,
      });
      process.exit(result.status === 'aborted' ? 1 : 0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

/**
 * Parse `key=value` tokens (one per arg) into a feature options hash.
 * Coerces `true`/`false` to booleans and pure-integer strings to
 * numbers; everything else stays a string. Devcontainer features
 * typically accept strings, but a few require booleans (e.g. the
 * docker-in-docker feature's `installDockerBuildx`) and the JSON value
 * must be the right type.
 */
function parseOptionsAfterDashes(tokens: readonly string[]): FeatureOptions {
  const result: FeatureOptions = {};
  for (const token of tokens) {
    const eqIdx = token.indexOf('=');
    if (eqIdx <= 0) {
      throw new Error(
        `Invalid option: ${JSON.stringify(token)}. Expected key=value (e.g. version=latest).`,
      );
    }
    const key = token.slice(0, eqIdx);
    const raw = token.slice(eqIdx + 1);
    result[key] = coerce(raw);
  }
  return result;
}

function coerce(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  return value;
}
