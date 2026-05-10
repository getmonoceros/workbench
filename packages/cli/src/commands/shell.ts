import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runShell } from '../devcontainer/shell.js';

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
        'Override the auto-detected project (path, absolute or relative to cwd). Defaults to walking upwards from cwd.',
    },
  },
  async run({ args }) {
    try {
      const exitCode = await runShell({
        project: typeof args.project === 'string' ? args.project : undefined,
      });
      process.exit(exitCode);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
