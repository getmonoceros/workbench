import { defineCommand } from 'citty';
import { notImplemented } from './_stub.js';

export const stopCommand = defineCommand({
  meta: {
    name: 'stop',
    description: 'Stop the devcontainer and any compose services.',
  },
  run() {
    notImplemented('stop');
  },
});
