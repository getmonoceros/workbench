import { spawnDevcontainer, type DevcontainerSpawn } from './cli.js';
import { assertContainerExists } from './shell.js';

export interface RunInContainerOptions {
  /** Container root: `<MONOCEROS_HOME>/container/<name>/`. */
  root: string;
  command: string[];
  spawn?: DevcontainerSpawn;
}

// Run a one-off command inside the named container. Brings the
// container up if needed (silently — only the inner command's stdio is
// passed through), then forwards the command verbatim to
// `devcontainer exec`. The inner command's exit code is propagated.
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

  return spawnFn(
    [
      'exec',
      '--workspace-folder',
      opts.root,
      '--mount-workspace-git-root=false',
      ...opts.command,
    ],
    opts.root,
    { interactive: true },
  );
}
