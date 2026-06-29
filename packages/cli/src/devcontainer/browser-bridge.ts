import { spawn } from 'node:child_process';
import { existsSync, promises as fsp, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { DevcontainerSpawn } from './cli.js';

// Dir under the container root (bind-mounted into the workspace) holding the
// relay `xdg-open` and the captured URL. Used both by the per-session bridge
// (`monoceros run`/`shell`) and the always-on bridge daemon — both watch the
// same `url` file, which the relay `xdg-open` writes.
export const RELAY_DIRNAME = '.monoceros-bridge';

/** Host-side relay dir for a container root. */
export function relayDir(root: string): string {
  return path.join(root, RELAY_DIRNAME);
}

/** Host-side url-file the relay `xdg-open` writes to (and the watcher reads). */
export function relayUrlFile(root: string): string {
  return path.join(relayDir(root), 'url');
}

/**
 * Parse the localhost callback target out of an OAuth URL. Returns the port +
 * path of `redirect_uri` when it points at localhost (the loopback-callback
 * flow used by claude, gh, gcloud, …), or null otherwise (e.g. a remote
 * paste-code callback). Generic — not tied to any one tool.
 */
export function parseCallbackTarget(
  authUrl: string,
): { port: number; pathname: string } | null {
  try {
    const u = new URL(authUrl);
    const redirect = u.searchParams.get('redirect_uri');
    if (!redirect) return null;
    const r = new URL(redirect);
    if (r.hostname !== 'localhost' && r.hostname !== '127.0.0.1') return null;
    const port = Number(r.port);
    if (!Number.isInteger(port) || port <= 0) return null;
    return { port, pathname: r.pathname };
  } catch {
    return null;
  }
}

/**
 * Decide whether the freshly-read relay url-file content is a *new* URL to
 * open. Returns the trimmed URL when it's non-empty and different from the last
 * one opened (so repeated `xdg-open` calls each relay, but the poller doesn't
 * re-open the same URL every 250ms), else null.
 */
export function nextRelayUrl(
  content: string,
  lastOpened: string | null,
): string | null {
  const url = content.trim();
  return url && url !== lastOpened ? url : null;
}

export interface BrowserBridge {
  /** Container-side dir to prepend to PATH so the relay `xdg-open` is found. */
  relayDirInContainer: string;
  /** Stop watching, close any callback listeners, remove the relay dir. */
  dispose(): Promise<void>;
}

/**
 * Wrap the inner command in `bash -lc` only when we need to prepend PATH (the
 * browser-bridge relay dir) and/or change directory. The command stays a
 * separate argv array passed positionally, so no shell re-quoting of the inner
 * args is needed. Returns the command unchanged when neither applies. Shared by
 * `run` and `shell` so both route an inner tool's browser-opens through the
 * relay.
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

/** Open a URL in the host's default browser. Best-effort, never throws. */
function openInBrowser(url: string): void {
  const platform = process.platform;
  // Under WSL the "host" is a headless Linux distro with no xdg-open / no
  // browser (e.g. Monoceros's managed distro on Windows). Reach the Windows
  // browser via interop instead.
  const wsl =
    platform === 'linux' &&
    (!!process.env.WSL_DISTRO_NAME ||
      (() => {
        try {
          return readFileSync('/proc/sys/kernel/osrelease', 'utf8')
            .toLowerCase()
            .includes('microsoft');
        } catch {
          return false;
        }
      })());
  // Use PowerShell's Start-Process with a single-quoted URL: `cmd /c start`
  // treats `&` as a command separator and truncates OAuth URLs at the first
  // query param. Works on native Windows and via WSL interop alike.
  const psOpen = `Start-Process '${url.replace(/'/g, "''")}'`;
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32' || wsl
        ? ['powershell.exe', ['-NoProfile', '-Command', psOpen]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* ignore */
  }
}

/**
 * Give the container a way to open the HOST browser during an interactive
 * session. The container can't open a browser itself (headless), so any tool
 * inside (`claude`, `gh auth`, `glab auth`, …) falls back to "copy this URL" —
 * which then breaks on terminals without OSC 52 clipboard support (Apple
 * Terminal, GNOME Terminal, …). This sidesteps clipboards entirely.
 *
 * Mechanism: install a relay `xdg-open` that writes the URL it's handed to a
 * bind-mounted file (a clean argv, not wrap-corrupted terminal text). While
 * the session runs we watch that file; on each new URL we open it on the host
 * (so a tool can open an OAuth page AND later the running app). For a localhost
 * OAuth callback we also run a short-lived host listener on the callback port
 * and replay the callback into the container, so the sign-in completes without
 * anyone copying or pasting a code.
 *
 * The caller prepends `relayDirInContainer` to the inner command's PATH and
 * calls `dispose()` when the session ends.
 */
export async function startBrowserBridge(opts: {
  name: string;
  root: string;
  spawn: DevcontainerSpawn;
}): Promise<BrowserBridge> {
  const dir = relayDir(opts.root);
  const relayScript = path.join(dir, 'xdg-open');
  const urlFile = relayUrlFile(opts.root);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.rm(urlFile, { force: true });
  await fsp.writeFile(
    relayScript,
    '#!/bin/sh\nprintf \'%s\\n\' "$1" > "$(dirname "$0")/url"\nexit 0\n',
    { mode: 0o755 },
  );
  await fsp.chmod(relayScript, 0o755);

  const watcher = watchRelayUrl({
    urlFile,
    root: opts.root,
    spawn: opts.spawn,
  });

  return {
    relayDirInContainer: `/workspaces/${opts.name}/${RELAY_DIRNAME}`,
    async dispose(): Promise<void> {
      watcher.dispose();
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Watch the relay url-file and open each new URL on the host browser,
 * replaying a localhost OAuth callback into the container when the URL
 * carries one. This is the reusable engine shared by the per-session bridge
 * (`startBrowserBridge`, wired into `monoceros run`/`shell`) and the always-on
 * bridge daemon (which runs it for a container's whole lifetime). The disposer
 * stops the poll + closes any callback listeners but does NOT touch the relay
 * dir — the caller owns that.
 */
export function watchRelayUrl(opts: {
  urlFile: string;
  root: string;
  spawn: DevcontainerSpawn;
}): { dispose(): void } {
  const servers: http.Server[] = [];
  // Last URL we relayed, so repeated `xdg-open` calls each open (not just the
  // first OAuth one). A tool that opens the running app (`xdg-open
  // http://<name>.localhost`) should reach the host browser too.
  let lastOpened: string | null = null;

  const onUrl = (url: string): void => {
    // Open silently — never write to the terminal here; the inner tool owns
    // the TTY and a parallel write garbles its output.
    openInBrowser(url);
    const target = parseCallbackTarget(url);
    if (!target) return; // not a localhost callback — nothing to bridge
    const server = http.createServer((req, res) => {
      const reqUrl = req.url ?? target.pathname;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<html><body style="font-family:sans-serif;padding:3rem">You are signed in. You can close this tab and return to the terminal.</body></html>',
      );
      // Replay the callback INTO the container against the tool's own listener.
      void opts.spawn(
        [
          'exec',
          '--workspace-folder',
          opts.root,
          '--mount-workspace-git-root=false',
          'curl',
          '-fsS',
          `http://localhost:${target.port}${reqUrl}`,
        ],
        opts.root,
        { quiet: true },
      );
    });
    server.on('error', () => {
      /* port in use etc. — the tool's own paste-code fallback still works */
    });
    server.listen(target.port, '127.0.0.1');
    servers.push(server);
  };

  const poll = setInterval(() => {
    if (!existsSync(opts.urlFile)) return;
    let content = '';
    try {
      content = readFileSync(opts.urlFile, 'utf8');
    } catch {
      return;
    }
    const url = nextRelayUrl(content, lastOpened);
    if (!url) return;
    lastOpened = url;
    onUrl(url);
  }, 250);

  return {
    dispose(): void {
      clearInterval(poll);
      for (const s of servers) s.close();
    },
  };
}
