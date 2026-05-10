import { defineCommand } from 'citty';
import { notImplemented } from './_stub.js';

export const addServiceCommand = defineCommand({
  meta: {
    name: 'add-service',
    description:
      'Add a compose service (e.g. postgres, redis) to an existing solution. Idempotent, prints a diff before writing.',
  },
  args: {
    service: {
      type: 'positional',
      description: 'Service identifier from the snippet whitelist.',
      required: true,
    },
  },
  run() {
    notImplemented('add-service');
  },
});
