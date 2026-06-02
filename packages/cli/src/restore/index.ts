import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import {
  containerConfigPath,
  containerConfigsDir,
  containerDir,
  containerEnvPath,
  monocerosHome as defaultMonocerosHome,
  prettyPath,
} from '../config/paths.js';

/**
 * `monoceros restore <backup-path>` — re-instantiate the host-side
 * state of a previously-removed container from a backup written by
 * `monoceros remove`.
 *
 * Backup layout (produced by runRemove):
 *
 *   <backup>/<name>.yml          ← container-configs source
 *   <backup>/container/          ← full container scaffold
 *                                  (home/, projects/, data/, .monoceros/, …)
 *
 * Restore copies both back into `$MONOCEROS_HOME`:
 *
 *   $MONOCEROS_HOME/container-configs/<name>.yml
 *   $MONOCEROS_HOME/container/<name>/
 *
 * Refuses to clobber an existing config or container dir — the
 * builder must remove the in-place container first (or pick a
 * different target name).
 *
 * Restore does NOT recreate the docker objects: builder runs
 * `monoceros apply <name>` afterwards. That keeps restore a
 * pure filesystem operation, safe to dry-run, with no side-
 * effects on the docker daemon.
 */

export interface RunRestoreOptions {
  /** Path to a `<MONOCEROS_HOME>/container-backups/<name>-<ts>/` dir. */
  backupPath: string;
  /** Override of the user-data home. Tests inject a tmpdir. */
  monocerosHome?: string;
  logger?: {
    info: (msg: string) => void;
    success: (msg: string) => void;
  };
}

export interface RunRestoreResult {
  /** Container name detected from the backup contents. */
  name: string;
  /** Where the yml was restored to. */
  configPath: string;
  /** Where the container directory was restored to (or `null` when
   *  the backup didn't carry one — e.g. a remove that ran before any
   *  apply had materialized the container dir). */
  containerPath: string | null;
}

export async function runRestore(
  opts: RunRestoreOptions,
): Promise<RunRestoreResult> {
  const home = opts.monocerosHome ?? defaultMonocerosHome();
  const logger = opts.logger ?? {
    info: (msg) => consola.info(msg),
    success: (msg) => consola.success(msg),
  };

  const backup = path.resolve(opts.backupPath);
  if (!existsSync(backup)) {
    throw new Error(`Backup not found: ${backup}.`);
  }
  const stat = await fs.stat(backup);
  if (!stat.isDirectory()) {
    throw new Error(`Backup path is not a directory: ${backup}.`);
  }

  // Detect the container name from the single `.yml` file in the
  // backup root. runRemove writes `<name>.yml`; we don't depend on
  // the backup-directory name (`<name>-<timestamp>`) because the
  // builder might have renamed/moved the backup folder.
  const entries = await fs.readdir(backup);
  const ymlFiles = entries.filter((f) => f.endsWith('.yml'));
  if (ymlFiles.length === 0) {
    throw new Error(
      `Backup at ${backup} doesn't contain a *.yml — expected a single config file at the root.`,
    );
  }
  if (ymlFiles.length > 1) {
    throw new Error(
      `Backup at ${backup} contains multiple .yml files (${ymlFiles.join(', ')}). Expected exactly one.`,
    );
  }
  const ymlFile = ymlFiles[0]!;
  const name = ymlFile.replace(/\.yml$/, '');

  const containerInBackup = path.join(backup, 'container');
  const hasContainer = existsSync(containerInBackup);

  // The env file (values behind the yml's `${VAR}` references) is
  // restored alongside the yml when the backup carries one.
  const envInBackup = path.join(backup, `${name}.env`);
  const hasEnv = existsSync(envInBackup);

  // Refuse to overwrite live state.
  const destYml = containerConfigPath(name, home);
  const destContainer = containerDir(name, home);
  if (existsSync(destYml)) {
    throw new Error(
      `Refusing to restore: ${destYml} already exists. Remove the current container first (\`monoceros remove ${name}\`) or rename the existing config.`,
    );
  }
  if (hasContainer && existsSync(destContainer)) {
    throw new Error(
      `Refusing to restore: ${destContainer} already exists. Remove the current container first (\`monoceros remove ${name}\`).`,
    );
  }

  // Copy back into place.
  await fs.mkdir(containerConfigsDir(home), { recursive: true });
  await fs.copyFile(path.join(backup, ymlFile), destYml);
  if (hasEnv) {
    await fs.copyFile(envInBackup, containerEnvPath(name, home));
  }
  if (hasContainer) {
    await fs.cp(containerInBackup, destContainer, { recursive: true });
  }

  logger.success(`Restored '${name}' from ${prettyPath(backup)}.`);
  logger.info(
    `Run \`monoceros apply ${name}\` to bring the container back up.`,
  );

  return {
    name,
    configPath: destYml,
    containerPath: hasContainer ? destContainer : null,
  };
}
