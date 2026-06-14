import { startBrowserBridge, wrapExec } from './browser-bridge.js';
import { preApproveClaudeProject } from './claude-trust.js';
import { spawnDevcontainer, type DevcontainerSpawn } from './cli.js';
import { assertContainerExists } from './shell.js';

export interface RunInContainerOptions {
  /** Container root: `<MONOCEROS_HOME>/container/<name>/`. */
  root: string;
  /**
   * Container name. When set and the session is interactive (a TTY), Monoceros
   * starts a browser bridge so a tool inside that opens a browser (`claude`,
   * `gh auth`, …) opens it on the host. Omit to skip the bridge.
   */
  name?: string;
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

// Run a one-off command inside the named container. Brings the container up if
// needed (silently — only the inner command's stdio is passed through), then
// `devcontainer exec`s the command and propagates its exit code. In an
// interactive (TTY) session a browser bridge is active so an inner tool can
// open the host browser (see startBrowserBridge); a missing `cwd` directory
// fails before exec, surfacing it instead of running in the wrong place.
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

  // Pre-approve Claude Code's first-run trust + external-import prompts for the
  // exact directory we're about to launch in, so the user never faces them and
  // can't silently disable the briefing by declining the import prompt. No-op
  // unless the claude-code feature seeded `.claude.json`.
  if (opts.name) {
    await preApproveClaudeProject({
      root: opts.root,
      name: opts.name,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
  }

  const bridge =
    opts.name && process.stdout.isTTY
      ? await startBrowserBridge({
          name: opts.name,
          root: opts.root,
          spawn: spawnFn,
        })
      : null;

  try {
    const innerExec = wrapExec(opts.command, {
      ...(bridge ? { pathPrepend: bridge.relayDirInContainer } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    return await spawnFn(
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
  } finally {
    if (bridge) await bridge.dispose();
  }
}
