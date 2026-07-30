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
import { spawnDocker, type DockerExec } from '../devcontainer/compose.js';

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
 * filesystem operation, safe to dry-run, with no side-effects on the
 * docker daemon - with one exception it cannot avoid: when the backup
 * carries root-owned files (SSH host keys, a postgres cluster), the
 * copy needs root, so it falls back to a throw-away alpine container
 * the same way `remove` does when it writes them.
 */

/** Same throw-away image `remove` uses for its own root-owned copies. */
const RESTORE_COPY_IMAGE = 'alpine:3.21';

export interface RunRestoreOptions {
  /** Path to a `<MONOCEROS_HOME>/container-backups/<name>-<ts>/` dir. */
  backupPath: string;
  /** Override of the user-data home. Tests inject a tmpdir. */
  monocerosHome?: string;
  /**
   * Docker invocation for the root-owned-files fallback only. Never
   * touched on the happy path, so a restore of an ordinary backup still
   * needs no daemon. Tests inject a fake.
   */
  dockerExec?: DockerExec;
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
  const dockerExec = opts.dockerExec ?? spawnDocker;

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
    try {
      await fs.cp(containerInBackup, destContainer, { recursive: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM') throw err;
      // The mirror of what `remove` does when it writes the backup: a
      // container leaves files the unprivileged monoceros process cannot
      // read - the 0600 SSH host keys, a postgres cluster at 0700 owned by
      // uid 999 - and `remove` copies them into the backup as root via a
      // throw-away container, preserving owner and mode. Without the same
      // fallback here, a backup the CLI wrote itself cannot be read back:
      // restore died on `.monoceros/ssh/host/ssh_host_ecdsa_key`. Only
      // Linux hits it; Docker Desktop's VirtioFS does not pass the
      // ownership through to the host, so on macOS the plain copy works.
      logger.info(
        `[restore] hit ${code} on root-owned files; copying via a throw-away alpine container…`,
      );
      await fs.mkdir(destContainer, { recursive: true });
      const { exitCode, stderr } = await dockerExec([
        'run',
        '--rm',
        '-v',
        `${containerInBackup}:/src:ro`,
        '-v',
        `${destContainer}:/dst`,
        RESTORE_COPY_IMAGE,
        'sh',
        '-c',
        'cp -a /src/. /dst/',
      ]);
      if (exitCode !== 0) {
        throw new Error(
          `docker-based restore of ${containerInBackup} failed (exit ${exitCode}` +
            `${stderr.trim() ? `: ${stderr.trim()}` : ''}).`,
        );
      }
    }
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
