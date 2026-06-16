import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import {
  containerDir,
  monocerosHome as defaultMonocerosHome,
} from '../config/paths.js';
import {
  findRunningContainerByLocalFolder,
  type DockerLookupExec,
} from '../devcontainer/locate-running.js';
import { runShell } from '../devcontainer/shell.js';
import {
  isWsl,
  resolveWindowsProfile,
  sshConfigEntryPath,
} from '../devcontainer/ssh-attach.js';

/**
 * `monoceros open <name> <tool>` - attach an editor (or a shell) to a
 * running dev container over the ADR-0022 SSH attach point.
 *
 * The VS Code family (VS Code, VS Codium) attaches via Remote-SSH using
 * the `vscode-remote://ssh-remote+<host>` authority and opens the remote
 * `.code-workspace` directly. Both are verified. JetBrains / Zed use a
 * different launch model and are added once verified - the registry below
 * is the seam where they slot in.
 */

interface EditorTool {
  label: string;
  /** PATH command name. */
  bin: string;
  /** macOS app-bundle bin used as a fallback when the command isn't on PATH. */
  macAppBin: string;
  /**
   * Install path relative to a Windows programs dir (Program Files /
   * %LOCALAPPDATA%\Programs), used as a WSL fallback so `open` finds the
   * Windows editor without it being on the (inherited) PATH.
   */
  winInstallSubpath: string;
  /** Shown when the binary can't be found. */
  setupHint: string;
}

const EDITORS: Record<string, EditorTool> = {
  code: {
    label: 'VS Code',
    bin: 'code',
    macAppBin:
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    winInstallSubpath: 'Microsoft VS Code/bin/code',
    setupHint:
      'install the Remote-SSH extension; on macOS also run "Shell Command: Install \'code\' command in PATH"',
  },
  codium: {
    label: 'VS Codium',
    bin: 'codium',
    macAppBin: '/Applications/VSCodium.app/Contents/Resources/app/bin/codium',
    winInstallSubpath: 'VSCodium/bin/codium',
    setupHint:
      'install the "Open Remote - SSH" extension (the codium CLI ships with the app)',
  },
};

/** Every tool `open` accepts: the editors plus the `shell` passthrough. */
export const OPEN_TOOLS: readonly string[] = [...Object.keys(EDITORS), 'shell'];

function resolveOnPath(bin: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not in this dir; keep looking
    }
  }
  return null;
}

/**
 * Resolve an editor to a runnable binary: the bare command if it's on
 * PATH (let the OS resolve it), else the known macOS app-bundle bin, else
 * - under WSL - the Windows install (so `open` works even when the editor
 * isn't on the inherited PATH; the Windows `bin/<cmd>` is a shell wrapper
 * that launches the Windows app, the same mechanism that makes a
 * PATH-resolved `codium` work). Returns null when nothing is found.
 */
async function resolveEditorBinary(tool: EditorTool): Promise<string | null> {
  if (resolveOnPath(tool.bin)) return tool.bin;
  if (process.platform === 'darwin' && existsSync(tool.macAppBin)) {
    return tool.macAppBin;
  }
  if (isWsl()) {
    const candidates = [`/mnt/c/Program Files/${tool.winInstallSubpath}`];
    const profile = await resolveWindowsProfile();
    if (profile) {
      candidates.push(
        `${profile.homeWsl}/AppData/Local/Programs/${tool.winInstallSubpath}`,
      );
    }
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function realLaunch(bin: string, args: readonly string[]): void {
  // GUI editors: fire-and-forget so the terminal returns immediately.
  const child = spawn(bin, args as string[], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

export interface RunOpenOptions {
  name: string;
  tool: string;
  monocerosHome?: string;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
  // Injectables for tests:
  /** Resolve an editor tool to a runnable binary path (or null). */
  binResolver?: (tool: EditorTool) => string | null | Promise<string | null>;
  /** Launch the (GUI) editor, detached. */
  launch?: (bin: string, args: readonly string[]) => void;
  /** Lookup for the running container (gates the editor attach). */
  dockerLookup?: DockerLookupExec;
  /** Shell passthrough for the `shell` tool. */
  shellRunner?: typeof runShell;
}

export async function runOpen(opts: RunOpenOptions): Promise<number> {
  const home = opts.monocerosHome ?? defaultMonocerosHome();
  const logger = opts.logger ?? {
    info: (m) => consola.info(m),
    warn: (m) => consola.warn(m),
  };
  const root = containerDir(opts.name, home);

  // `shell` is just the existing interactive shell (it brings the
  // container up itself, so it needs no running pre-check).
  if (opts.tool === 'shell') {
    const shellRunner = opts.shellRunner ?? runShell;
    return shellRunner({ root, name: opts.name });
  }

  const editor = EDITORS[opts.tool];
  if (!editor) {
    throw new Error(
      `Unknown tool '${opts.tool}'. Supported: ${OPEN_TOOLS.join(', ')}.`,
    );
  }

  // The SSH attach config is written by `apply` for runtime >= 1.2.0. No
  // entry means either not applied or an older runtime without sshd.
  if (!existsSync(sshConfigEntryPath(home, opts.name))) {
    throw new Error(
      `SSH attach isn't set up for '${opts.name}'. Run \`monoceros apply ${opts.name}\` ` +
        `first (needs a runtime >= 1.2.0).`,
    );
  }

  // Remote-SSH attaches to a running container; it won't start one.
  const running = await findRunningContainerByLocalFolder(
    root,
    opts.dockerLookup ? { docker: opts.dockerLookup } : {},
  );
  if (!running) {
    throw new Error(
      `Container '${opts.name}' isn't running. Bring it up with ` +
        `\`monoceros apply ${opts.name}\`, then retry.`,
    );
  }

  const resolve = opts.binResolver ?? resolveEditorBinary;
  const bin = await resolve(editor);
  if (!bin) {
    const where =
      process.platform === 'darwin'
        ? ' on PATH or in /Applications'
        : ' on PATH';
    throw new Error(
      `${editor.label} ('${editor.bin}') not found${where}. In ${editor.label}, ${editor.setupHint}.`,
    );
  }

  // Open the remote multi-root workspace directly (both `--file-uri` on the
  // .code-workspace and `--remote <path>` work on the VS Code family; the
  // file-uri form opens the workspace without the "open workspace?" prompt).
  const uri =
    `vscode-remote://ssh-remote+monoceros-${opts.name}` +
    `/workspaces/${opts.name}/${opts.name}.code-workspace`;
  const launch = opts.launch ?? realLaunch;
  launch(bin, ['--file-uri', uri]);
  logger.info(`Opening '${opts.name}' in ${editor.label}...`);
  return 0;
}
