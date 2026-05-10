import { defineCommand } from 'citty';
import { notImplemented } from './_stub.js';

export const shellCommand = defineCommand({
  meta: {
    name: 'shell',
    description:
      'Open an interactive shell inside the devcontainer for the current solution (cwd-aware).',
  },
  args: {
    project: {
      type: 'string',
      description:
        'Override the auto-detected project (path or name). Defaults to walking upwards from cwd.',
    },
  },
  run() {
    notImplemented('shell');
  },
});
