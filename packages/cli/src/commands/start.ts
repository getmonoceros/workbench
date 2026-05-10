import { defineCommand } from 'citty';
import { notImplemented } from './_stub.js';

export const startCommand = defineCommand({
  meta: {
    name: 'start',
    description: 'Start the devcontainer and any compose services.',
  },
  run() {
    notImplemented('start');
  },
});
