import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runRestore } from '../restore/index.js';

export const restoreCommand = defineCommand({
  meta: {
    name: 'restore',
    description:
      "Restore a container's host-side state from a backup written by `monoceros remove`. Copies the yml and the container directory back into $MONOCEROS_HOME. Refuses to overwrite an existing config or container — remove the in-place container first if you need to clobber. Run `monoceros apply <name>` afterwards to bring it back up.",
  },
  args: {
    'backup-path': {
      type: 'positional',
      description:
        'Path to a backup directory (typically `<MONOCEROS_HOME>/container-backups/<name>-<timestamp>/`).',
      required: true,
    },
  },
  async run({ args }) {
    try {
      await runRestore({ backupPath: args['backup-path'] });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
