import { spawn } from 'node:child_process';
import { existsSync, promises as fsp, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { consola } from 'consola';
import { readConfig } from '../config/io.js';
import { containerConfigPath, containerDir } from '../config/paths.js';
import {
  devcontainerCliPath,
  spawnDevcontainer,
  type DevcontainerSpawn,
} from '../devcontainer/cli.js';
import { assertContainerExists } from '../devcontainer/shell.js';
import { loginCapableServices, parseCallbackTarget } from './services.js';

// Directory (under the container dir, bind-mounted into the workspace)
// that holds the relay `xdg-open` and the captured auth URL during a login.
const RELAY_DIRNAME = '.monoceros-login';

export interface LoginOptions {
  name: string;
  /** Which curated tool to log in (e.g. `claude`). */
  feature?: string;
  spawn?: DevcontainerSpawn;
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
    /* ignore — we still printed the URL as a fallback */
  }
}

export async function runLogin(opts: LoginOptions): Promise<number> {
  const root = containerDir(opts.name);
  assertContainerExists(root);

  const { config } = await readConfig(containerConfigPath(opts.name));
  const capable = loginCapableServices(config.features.map((f) => f.ref));

  if (capable.length === 0) {
    consola.error(
      `Container "${opts.name}" has no tool with a Monoceros login. (Supported today: claude.)`,
    );
    return 1;
  }

  // No tool named → list what's available and how to log in. Explicit by
  // design: `login <name>` shows the options (even when there's only one),
  // `login <name> <tool>` performs the login.
  if (!opts.feature) {
    consola.info(
      `Login-capable tools in "${opts.name}": ${capable.join(', ')}.`,
    );
    consola.info(`Log one in with: monoceros login ${opts.name} <tool>`);
    return 0;
  }

  const service = opts.feature;
  if (!capable.includes(service)) {
    consola.error(
      `"${service}" is not a login-capable tool in "${opts.name}". Available: ${capable.join(', ')}.`,
    );
    return 1;
  }
  if (service !== 'claude') {
    consola.error(
      `Login for "${service}" is not implemented yet (only claude).`,
    );
    return 1;
  }

  return runClaudeLogin(opts.name, root, opts.spawn ?? spawnDevcontainer);
}

/**
 * Drive Claude's interactive login inside the container, opening the OAuth URL
 * in the host browser automatically and completing the localhost callback so
 * the user never has to copy anything out of the terminal.
 */
async function runClaudeLogin(
  name: string,
  root: string,
  spawnFn: DevcontainerSpawn,
): Promise<number> {
  const credFile = path.join(root, 'home', '.claude', '.credentials.json');
  if (existsSync(credFile)) {
    consola.success(
      `Claude is already logged in for "${name}". Re-apply or remove the credential to log in again.`,
    );
    return 0;
  }

  // 1. Bring the container up (quiet — only the inner login's output matters).
  const upCode = await spawnFn(
    ['up', '--workspace-folder', root, '--mount-workspace-git-root=false'],
    root,
    { quiet: true },
  );
  if (upCode !== 0) return upCode;

  // 2. Install the relay `xdg-open` (host-side write into the bind-mounted dir).
  //    Claude calls `xdg-open <url>` to open a browser; our relay captures the
  //    intact URL (a clean argv, not wrap-corrupted terminal text) and writes
  //    it next to itself, where the host can read it.
  const relayDir = path.join(root, RELAY_DIRNAME);
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
  let handledUrl = false;

  const onAuthUrl = (authUrl: string): void => {
    // Open the browser silently — do NOT write to the terminal here. Claude
    // owns the TTY during the interactive login; a parallel write garbles its
    // output. (Claude already prints its own "opening browser" line.)
    openInBrowser(authUrl);
    const target = parseCallbackTarget(authUrl);
    if (!target) {
      // Not the localhost flow — nothing for us to bridge. Claude will guide
      // the rest (e.g. paste a code); the URL is already open in the browser.
      return;
    }
    // Run a host listener on the callback port; when the browser redirects
    // here after authorization, replay the exact callback INTO the container
    // against Claude's own listener so the login completes automatically.
    const server = http.createServer((req, res) => {
      const reqUrl = req.url ?? target.pathname;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<html><body style="font-family:sans-serif;padding:3rem">You are signed in. You can close this tab and return to the terminal.</body></html>',
      );
      void spawnFn(
        [
          'exec',
          '--workspace-folder',
          root,
          '--mount-workspace-git-root=false',
          'curl',
          '-fsS',
          `http://localhost:${target.port}${reqUrl}`,
        ],
        root,
        { quiet: true },
      );
    });
    server.on('error', (err) => {
      consola.warn(
        `Could not start the local callback helper on port ${target.port} (${err.message}). If the browser shows a code, paste it into the terminal instead.`,
      );
    });
    server.listen(target.port, '127.0.0.1');
    servers.push(server);
  };

  const poll = setInterval(() => {
    if (handledUrl || !existsSync(urlFile)) return;
    let content = '';
    try {
      content = readFileSync(urlFile, 'utf8');
    } catch {
      return;
    }
    if (!content.trim()) return;
    handledUrl = true;
    onAuthUrl(content.trim());
  }, 250);

  // 3. Run Claude's dedicated `auth login` (relay first on PATH). Unlike bare
  //    `claude`, it signs in and EXITS instead of dropping into the REPL — so
  //    the user lands back at their shell, ready to `monoceros run`. It's also
  //    a focused flow (no theme picker / full TUI), which keeps the output
  //    clean. The browser opens via our relay; we add nothing to the terminal.
  consola.info('Logging in to Claude — a browser window will open for you.');
  const child = spawn(
    process.execPath,
    [
      devcontainerCliPath(),
      'exec',
      '--workspace-folder',
      root,
      '--mount-workspace-git-root=false',
      'bash',
      '-lc',
      `export PATH="/workspaces/${name}/${RELAY_DIRNAME}:$PATH"; exec claude auth login`,
    ],
    {
      cwd: root,
      env: { ...process.env, DOCKER_CLI_HINTS: 'false' },
      stdio: 'inherit',
    },
  );

  const code = await new Promise<number>((resolve) => {
    child.on('error', () => resolve(1));
    child.on('exit', (c) => resolve(c ?? 0));
  });

  clearInterval(poll);
  for (const s of servers) s.close();
  await fsp.rm(relayDir, { recursive: true, force: true });

  if (existsSync(credFile)) {
    consola.success(
      `Claude is logged in for "${name}". The credential persists across rebuilds.`,
    );
  }
  return code;
}
