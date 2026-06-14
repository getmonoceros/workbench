import { existsSync } from 'node:fs';
import path from 'node:path';
import { startBrowserBridge, wrapExec } from './browser-bridge.js';
import { spawnDevcontainer, type DevcontainerSpawn } from './cli.js';

export interface ShellLogger {
  info: (message: string) => void;
}

export interface RunShellOptions {
  /** Container root: `<MONOCEROS_HOME>/container/<name>/`. */
  root: string;
  /**
   * Container name, used for the browser bridge's relay dir
   * (`/workspaces/<name>/.monoceros-bridge`). Defaults to the basename of
   * `root`, which by Monoceros convention is the container name.
   */
  name?: string;
  spawn?: DevcontainerSpawn;
  /**
   * Whether this is an interactive (TTY) session; gates the browser bridge.
   * Defaults to `process.stdout.isTTY`. Tests pass it explicitly.
   */
  isTty?: boolean;
}

export async function runShell(opts: RunShellOptions): Promise<number> {
  assertContainerExists(opts.root);
  const spawnFn = opts.spawn ?? spawnDevcontainer;

  const upCode = await spawnFn(
    ['up', '--workspace-folder', opts.root, '--mount-workspace-git-root=false'],
    opts.root,
    { quiet: true },
  );
  if (upCode !== 0) return upCode;

  // Interactive shells get the same browser bridge as `monoceros run`: a tool
  // inside (`glab auth login`, `gh auth`, `claude`, …) that opens a browser is
  // relayed to the host, and a localhost OAuth callback is replayed back into
  // the container — so web sign-in works from a plain shell, not just `run`.
  const name = opts.name ?? path.basename(opts.root);
  const isTty = opts.isTty ?? process.stdout.isTTY;
  const bridge = isTty
    ? await startBrowserBridge({ name, root: opts.root, spawn: spawnFn })
    : null;

  try {
    const innerExec = wrapExec(
      ['bash'],
      bridge ? { pathPrepend: bridge.relayDirInContainer } : {},
    );
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

export function assertContainerExists(root: string): void {
  if (!existsSync(path.join(root, '.devcontainer'))) {
    throw new Error(
      `No .devcontainer/ at ${root}. Run \`monoceros apply <name>\` first.`,
    );
  }
}
