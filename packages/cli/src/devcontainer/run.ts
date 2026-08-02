import { startBrowserBridge, wrapExec } from './browser-bridge.js';
import { preApproveClaudeProject } from './claude-trust.js';
import { spawnDevcontainer, type DevcontainerSpawn } from './cli.js';
import { consola } from 'consola';
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
   * (`/workspaces/<name>`); absolute paths are used as-is. When omitted the
   * command runs in the workspace folder (devcontainer exec's default).
   *
   * A directory that does not exist yet is offered for creation rather
   * than being an error, because the first run for a new app hits exactly
   * that: the agent is supposed to create `projects/<app>`, and it has to
   * start somewhere. Starting one level up is not the same thing - the
   * language servers look for their markers (package.json, go.mod) in the
   * directory they were started in, and the session list is keyed by it
   * too.
   */
  cwd?: string;
  /**
   * Skip the create-it question and answer yes. For CI and scripts, where
   * a prompt would hang. Without it and without a TTY, a missing
   * directory is an error rather than a silent mkdir.
   */
  yes?: boolean;
  /** Test seam for the create-it question. */
  confirm?: (dir: string) => Promise<boolean>;
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

  if (opts.cwd) await ensureCwd(opts, spawnFn);

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

/**
 * Make sure the `--in` directory exists, asking first.
 *
 * It used to be a hard failure, and the message was whatever bash said:
 * `cd: projects/shop: No such file or directory`. That is the wrong
 * answer for the case it hits most often, a new app whose directory the
 * agent has not created yet, and it says nothing about what to do.
 */
async function ensureCwd(
  opts: RunInContainerOptions,
  spawnFn: DevcontainerSpawn,
): Promise<void> {
  const dir = opts.cwd!;
  const exists =
    (await spawnFn(
      [
        'exec',
        '--workspace-folder',
        opts.root,
        '--mount-workspace-git-root=false',
        'test',
        '-d',
        dir,
      ],
      opts.root,
      { quiet: true },
    )) === 0;
  if (exists) return;

  const confirmFn = opts.confirm ?? askToCreate;
  const create = opts.yes === true || (await confirmFn(dir));
  if (!create) {
    throw new Error(
      `\`${dir}\` does not exist in the container, so there is nothing to run in. Create it, pick a directory that exists, or re-run with \`--yes\` to have it created.`,
    );
  }
  const code = await spawnFn(
    [
      'exec',
      '--workspace-folder',
      opts.root,
      '--mount-workspace-git-root=false',
      'mkdir',
      '-p',
      dir,
    ],
    opts.root,
    { quiet: true },
  );
  if (code !== 0) {
    throw new Error(`Could not create \`${dir}\` in the container.`);
  }
}

/**
 * Default question. Non-interactive callers never reach a prompt: without
 * a TTY the answer is no, and the error above names `--yes`.
 */
async function askToCreate(dir: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const answer = await consola.prompt(
    `\`${dir}\` does not exist in the container. Create it?`,
    { type: 'confirm', initial: true },
  );
  return answer === true;
}
