import { defineCommand } from 'citty';
import { notImplemented } from './_stub.js';

export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description:
      'Show whether the devcontainer and compose services are running.',
  },
  run() {
    notImplemented('status');
  },
});
