import { startBrowserBridge } from './browser-bridge.js';
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

/**
 * Wrap the inner command in `bash -lc` only when we need to prepend PATH (the
 * browser-bridge relay dir) and/or change directory. The command stays a
 * separate argv array passed positionally, so no shell re-quoting of the inner
 * args is needed. Returns the command unchanged when neither applies.
 */
export function wrapExec(
  command: string[],
  opts: { pathPrepend?: string; cwd?: string },
): string[] {
  const leading: string[] = [];
  const stmts: string[] = [];
  if (opts.pathPrepend) {
    leading.push(opts.pathPrepend);
    const i = leading.length;
    // Put the relay's `xdg-open` first on PATH AND point `$BROWSER` at it, so
    // both conventions (xdg-open lookup, and tools that exec $BROWSER directly)
    // route through the relay.
    stmts.push(`export PATH="$${i}:$PATH"`);
    stmts.push(`export BROWSER="$${i}/xdg-open"`);
  }
  if (opts.cwd) {
    leading.push(opts.cwd);
    stmts.push(`cd -- "$${leading.length}"`);
  }
  if (leading.length === 0) return command;
  const shift = leading.length === 1 ? 'shift' : `shift ${leading.length}`;
  const script = `${stmts.join(' && ')} && ${shift} && exec "$@"`;
  return ['bash', '-lc', script, 'bash', ...leading, ...command];
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
