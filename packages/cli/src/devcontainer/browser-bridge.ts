import { spawn } from 'node:child_process';
import { existsSync, promises as fsp, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { DevcontainerSpawn } from './cli.js';

// Dir under the container root (bind-mounted into the workspace) holding the
// relay `xdg-open` and the captured URL during an interactive session.
const RELAY_DIRNAME = '.monoceros-bridge';

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

export interface BrowserBridge {
  /** Container-side dir to prepend to PATH so the relay `xdg-open` is found. */
  relayDirInContainer: string;
  /** Stop watching, close any callback listeners, remove the relay dir. */
  dispose(): Promise<void>;
}

/** Open a URL in the host's default browser. Best-effort, never throws. */
function openInBrowser(url: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
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
 * the session runs we watch that file; on a URL we open it on the host. For a
 * localhost OAuth callback we also run a short-lived host listener on the
 * callback port and replay the callback into the container, so the sign-in
 * completes without anyone copying or pasting a code.
 *
 * The caller prepends `relayDirInContainer` to the inner command's PATH and
 * calls `dispose()` when the session ends.
 */
export async function startBrowserBridge(opts: {
  name: string;
  root: string;
  spawn: DevcontainerSpawn;
}): Promise<BrowserBridge> {
  const relayDir = path.join(opts.root, RELAY_DIRNAME);
  const relayScript = path.join(relayDir, 'xdg-open');
  const urlFile = path.join(relayDir, 'url');
  await fsp.mkdir(relayDir, { recursive: true });
  await fsp.rm(urlFile, { force: true });
  await fsp.writeFile(
    relayScript,
    '#!/bin/sh\nprintf \'%s\\n\' "$1" > "$(dirname "$0")/url"\nexit 0\n',
    { mode: 0o755 },
  );
  await fsp.chmod(relayScript, 0o755);

  const servers: http.Server[] = [];
  let handled = false;

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
    if (handled || !existsSync(urlFile)) return;
    let content = '';
    try {
      content = readFileSync(urlFile, 'utf8');
    } catch {
      return;
    }
    if (!content.trim()) return;
    handled = true;
    onUrl(content.trim());
  }, 250);

  return {
    relayDirInContainer: `/workspaces/${opts.name}/${RELAY_DIRNAME}`,
    async dispose(): Promise<void> {
      clearInterval(poll);
      for (const s of servers) s.close();
      await fsp.rm(relayDir, { recursive: true, force: true });
    },
  };
}
