import { defineCommand } from 'citty';
import { notImplemented } from './_stub.js';

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
  run() {
    notImplemented('create');
  },
});
