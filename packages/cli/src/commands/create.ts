import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runCreate } from '../create/index.js';
import { CLI_VERSION } from '../version.js';

export const createCommand = defineCommand({
  meta: {
    name: 'create',
    description:
      'Scaffold a new solution directory with .devcontainer/, .monoceros/stack.json and a README stub.',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Directory name to create (relative to cwd).',
      required: true,
    },
    languages: {
      type: 'string',
      description:
        'Comma-separated list of language toolchains to add via devcontainer features (e.g. node,python).',
    },
    services: {
      type: 'string',
      description:
        'Comma-separated list of compose services to add (e.g. postgres,redis).',
    },
    'postgres-url': {
      type: 'string',
      description:
        'External Postgres URL escape-hatch — skips the compose service and uses the provided URL instead.',
    },
  },
  async run({ args }) {
    try {
      await runCreate(
        {
          name: args.name,
          languages: parseList(args.languages),
          services: parseList(args.services),
          postgresUrl:
            typeof args['postgres-url'] === 'string'
              ? args['postgres-url']
              : undefined,
        },
        { cliVersion: CLI_VERSION },
      );
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

function parseList(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
