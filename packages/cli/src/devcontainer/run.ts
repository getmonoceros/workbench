import { spawnDevcontainer, type DevcontainerSpawn } from './cli.js';
import { assertContainerExists } from './shell.js';

export interface RunInContainerOptions {
  /** Container root: `<MONOCEROS_HOME>/container/<name>/`. */
  root: string;
  command: string[];
  /**
   * Working directory inside the container for the inner command.
   * Relative paths resolve against the workspace folder
   * (`/workspaces/<name>`); absolute paths are used as-is. The directory
   * must already exist — `run` does not create it. When omitted the
   * command runs in the workspace folder (devcontainer exec's default).
   */
  cwd?: string;
  spawn?: DevcontainerSpawn;
}

// Run a one-off command inside the named container. Brings the
// container up if needed (silently — only the inner command's stdio is
// passed through), then forwards the command verbatim to
// `devcontainer exec`. The inner command's exit code is propagated.
//
// With `cwd`, the command is wrapped in `bash -lc 'cd -- "$1" && shift
// && exec "$@"'` so it runs in that directory. The command stays a
// separate argv array through the wrapper, so no shell re-quoting of
// the inner args is needed (and a failing `cd` aborts before exec,
// surfacing the missing directory).
export async function runInContainer(
  opts: RunInContainerOptions,
): Promise<number> {
  if (opts.command.length === 0) {
    throw new Error(
      'No command provided. Usage: `monoceros run <containername> -- <cmd> [args…]`.',
    );
  }
  assertContainerExists(opts.root);
  const spawnFn = opts.spawn ?? spawnDevcontainer;

  const upCode = await spawnFn(
    ['up', '--workspace-folder', opts.root, '--mount-workspace-git-root=false'],
    opts.root,
    { quiet: true },
  );
  if (upCode !== 0) return upCode;

  const innerExec = opts.cwd
    ? [
        'bash',
        '-lc',
        'cd -- "$1" && shift && exec "$@"',
        'bash',
        opts.cwd,
        ...opts.command,
      ]
    : opts.command;

  return spawnFn(
    [
      'exec',
      '--workspace-folder',
      opts.root,
      '--mount-workspace-git-root=false',
      ...innerExec,
    ],
    opts.root,
    { interactive: true },
  );
}
