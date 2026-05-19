import { defineCommand } from 'citty';
import { consola } from 'consola';
import { createInterface } from 'node:readline/promises';
import { runRemove } from '../remove/index.js';

export const removeCommand = defineCommand({
  meta: {
    name: 'remove',
    description:
      'Wipe everything belonging to a container: stop and remove the docker objects, back up the container-configs yml + container directory (incl. home/, projects/, data/), then delete them from disk. Shared docker images stay. By default the destructive step is confirmed interactively; pass -y to skip.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    backup: {
      type: 'boolean',
      // citty turns a default-true boolean automatically into a
      // `--no-X` flag for negation, so the builder gets the natural
      // `monoceros remove <name> --no-backup` form without us
      // needing to special-case the parsing. Defining the arg as
      // `no-backup` directly conflicts with citty's prefix logic
      // and silently fails to bind, so we always go through the
      // positive form.
      description:
        'Write a backup of <container-dir> and the yml under container-backups/ before deleting. Default on; use `--no-backup` to skip.',
      default: true,
    },
    yes: {
      type: 'boolean',
      alias: 'y',
      description:
        'Skip the interactive confirmation prompt. Useful in scripts.',
      default: false,
    },
  },
  async run({ args }) {
    try {
      const noBackup = args.backup === false;
      const skipPrompt = args.yes === true;

      if (!skipPrompt) {
        const warning = noBackup
          ? `About to remove '${args.name}' WITHOUT a backup. Docker objects, container-configs entry, and container directory will all be deleted.`
          : `About to remove '${args.name}'. A backup will be written to container-backups/ first, then docker objects, container-configs entry, and container directory will all be deleted.`;
        consola.warn(warning);
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await rl.question('Continue? [y/N] ');
        rl.close();
        if (!/^y(es)?$/i.test(answer.trim())) {
          consola.info('Aborted. Nothing changed.');
          process.exit(0);
        }
      }

      await runRemove({
        name: args.name,
        ...(noBackup ? { noBackup: true } : {}),
      });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
