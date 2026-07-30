import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { isWslHost } from '../util/wsl.js';

/**
 * Host-side clipboard bridge (ADR 0041).
 *
 * A container has no clipboard: no X server, no Wayland, and the OSC 52
 * escape a TUI writes instead is dropped by terminals that do not implement it
 * (Apple Terminal, GNOME Terminal). So copying inside the container is a
 * silent no-op — the same class of gap the browser bridge closes for
 * `xdg-open`, and it rides the same rails: the runtime image ships relay shims
 * named `xclip` / `xsel` / `wl-copy` / `pbcopy` that write the payload to a
 * file under the bind-mounted `.monoceros-bridge` dir, and this side takes the
 * payload and pipes it into the host's own clipboard.
 *
 * The relay-dir layout (including where that file lives) belongs to
 * `browser-bridge.ts` — see `relayClipboardFile`.
 */

/** A host clipboard writer: the command plus the argv to hand it. */
export type ClipboardCommand = readonly [cmd: string, args: string[]];

/**
 * Host commands that write stdin to the clipboard, best first. A list rather
 * than a single answer because Linux has no one right tool — we try each until
 * one is actually installed. Exported for the tests; `writeHostClipboard`
 * is what callers want.
 */
export function hostClipboardCommands(
  platform: string,
  env: NodeJS.ProcessEnv = process.env,
): ClipboardCommand[] {
  if (platform === 'darwin') return [['pbcopy', []]];
  // Under WSL the "host" is a headless Linux distro (Monoceros's managed
  // distro on Windows); the clipboard that matters is Windows'. Set-Clipboard
  // over stdin rather than `clip.exe`, which mangles non-ASCII: it reads the
  // console codepage, not UTF-8.
  if (platform === 'win32' || isWslHost(platform, env)) {
    return [
      [
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())',
        ],
      ],
    ];
  }
  const wayland: ClipboardCommand = ['wl-copy', []];
  const x11: ClipboardCommand[] = [
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ];
  return env['WAYLAND_DISPLAY'] ? [wayland, ...x11] : [...x11, wayland];
}

/**
 * Take the payload the container left for us: rename it away first, then read
 * it. The rename is the handover — it is atomic, so a copy landing while we
 * read cannot be swallowed, and two watchers (the per-session bridge and the
 * always-on daemon) cannot relay the same payload twice. Returns null when
 * there is nothing to take, or the payload is empty.
 */
export function takeClipboardPayload(file: string): string | null {
  if (!existsSync(file)) return null;
  const taking = `${file}.taking`;
  try {
    renameSync(file, taking);
  } catch {
    return null; // someone else took it, or it vanished
  }
  try {
    const text = readFileSync(taking, 'utf8');
    return text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    try {
      rmSync(taking, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Put text on the host clipboard. Best-effort and silent: an absent clipboard
 * tool must never surface as an error in the middle of someone's session — the
 * copy simply does not arrive, exactly as it did before this bridge existed.
 */
export function writeHostClipboard(
  text: string,
  commands: ClipboardCommand[] = hostClipboardCommands(process.platform),
): void {
  const [next, ...rest] = commands;
  if (!next) return;
  const [cmd, args] = next;
  try {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    // Not installed (ENOENT) or refused to start — fall through to the next
    // candidate rather than losing the copy.
    child.on('error', () => writeHostClipboard(text, rest));
    child.stdin.on('error', () => {
      /* the spawn error handler owns the fallback */
    });
    child.stdin.end(text);
  } catch {
    writeHostClipboard(text, rest);
  }
}

/**
 * Watch the relay clipboard-file and put each payload on the host clipboard.
 * Shared by the per-session bridge (`monoceros run`/`shell`) and the always-on
 * bridge daemon, the same way `watchRelayUrl` is. Polls rather than watches:
 * the file lives on a bind mount, where fs events are unreliable across
 * platforms.
 */
export function watchClipboard(opts: {
  clipboardFile: string;
  /** Injected by the tests; defaults to the real host clipboard. */
  write?: (text: string) => void;
  /** Poll interval in ms. Default 250; tests shorten it. */
  intervalMs?: number;
}): { dispose(): void } {
  const write = opts.write ?? ((text: string) => writeHostClipboard(text));
  const poll = setInterval(() => {
    const payload = takeClipboardPayload(opts.clipboardFile);
    if (payload !== null) write(payload);
  }, opts.intervalMs ?? 250);
  return {
    dispose(): void {
      clearInterval(poll);
    },
  };
}
