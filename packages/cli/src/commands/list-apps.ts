import { defineCommand } from 'citty';
import { consola } from 'consola';
import { listApps, readLaunchConfig } from '../config/launch-config.js';
import { colorsFor } from '../util/format.js';

export const listAppsCommand = defineCommand({
  meta: {
    name: 'list-apps',
    group: 'discovery',
    description:
      'List the apps under the named container that declare a launch config (projects/<app>/.monoceros/launch.json), with their targets and which is the default. Pure host-side filesystem read — works with the container stopped. Parallels `list-components`.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
  },
  async run({ args }) {
    try {
      const apps = await listApps(args.name);
      if (apps.length === 0) {
        consola.info(
          `No apps with a launch config under "${args.name}" (projects/<app>/.monoceros/launch.json).`,
        );
        process.exit(0);
      }

      const fmt = colorsFor(process.stdout);
      const isTty = process.stdout.isTTY ?? false;

      for (const app of apps) {
        const cfg = await readLaunchConfig(args.name, app);
        if (!cfg) continue;
        if (isTty) {
          process.stdout.write(`${fmt.cyan(app)}\n`);
        } else {
          process.stdout.write(`${app}\n`);
        }
        for (const t of cfg.configurations) {
          const flags: string[] = [];
          if (t.default) flags.push('default');
          if (typeof t.port === 'number') flags.push(`port ${t.port}`);
          const suffix = flags.length > 0 ? `  (${flags.join(', ')})` : '';
          if (isTty) {
            process.stdout.write(`  ${t.name}${suffix}\n`);
          } else {
            process.stdout.write(
              `${app}\t${t.name}\t${t.default ? 'default' : ''}\t${t.port ?? ''}\n`,
            );
          }
        }
      }
      process.exit(0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
