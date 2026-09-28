import { defineCommand } from 'citty';
import { migrateGlobalYml } from '../config/global-yml-migration.js';
import { monocerosHome } from '../config/paths.js';

/**
 * Internal, hidden command the install script runs after installing the CLI:
 * it moves a legacy `monoceros-config.yml` into `monoceros-config.env`
 * (ADR 0061) so a builder who updates sees what moved in the installer's
 * output, not in the middle of their next command. Prints nothing when there
 * is nothing to migrate; exits 1 with the reason when the yml cannot be read.
 */
export const __migrateConfigCommand = defineCommand({
  meta: {
    name: '__migrate-config',
    group: 'internal',
    hidden: true,
    description: 'Internal: move a legacy monoceros-config.yml into the env.',
  },
  async run() {
    try {
      const notice = await migrateGlobalYml(monocerosHome());
      if (notice) process.stdout.write(`${notice}\n`);
    } catch (err) {
      process.stderr.write(
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    }
  },
});
