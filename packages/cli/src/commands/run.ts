import { defineCommand } from 'citty';
import { notImplemented } from './_stub.js';

export const runCommand = defineCommand({
  meta: {
    name: 'run',
    description:
      'Run a one-off command inside the devcontainer. Use `--` to separate monoceros flags from the inner command.',
  },
  args: {
    project: {
      type: 'string',
      description:
        'Override the auto-detected project (path or name). Defaults to walking upwards from cwd.',
    },
  },
  run() {
    notImplemented('run');
  },
});
