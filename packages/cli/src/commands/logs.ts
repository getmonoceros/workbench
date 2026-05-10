import { defineCommand } from 'citty';
import { notImplemented } from './_stub.js';

export const logsCommand = defineCommand({
  meta: {
    name: 'logs',
    description: 'Tail logs from the devcontainer or a compose service.',
  },
  args: {
    service: {
      type: 'string',
      description:
        'Restrict to a single compose service (e.g. postgres). Defaults to all.',
    },
    follow: {
      type: 'boolean',
      description: 'Follow log output.',
      alias: ['f'],
      default: false,
    },
  },
  run() {
    notImplemented('logs');
  },
});
