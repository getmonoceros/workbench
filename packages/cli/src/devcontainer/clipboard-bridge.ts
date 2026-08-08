import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isWslHost } from '../util/wsl.js';

/**
 * Host-side clipboard bridge (ADR 0041, paste direction ADR 0048).
 *
 * A container has no clipboard: no X server, no Wayland, and the OSC 52
 * escape a TUI writes instead is dropped by terminals that do not implement it
 * (Apple Terminal, GNOME Terminal). So copying inside the container is a
 * silent no-op — the same class of gap the browser bridge closes for
 * `xdg-open`, and it rides the same rails: the runtime image ships relay shims
 * named `xclip` / `xsel` / `wl-copy` / `wl-paste` / `pbcopy` / `pbpaste` under
 * the bind-mounted `.monoceros-bridge` dir, and this side sits at the other end.
 *
 * Both directions travel it. COPY: the shim writes the payload to a file, we
 * take it and pipe it into the host's own clipboard. PASTE: the shim writes a
 * request naming a MIME target, we read that flavour off the host clipboard and
 * answer with the bytes. Paste is what carries a screenshot from the host into
 * a tool in the container — a terminal can paste characters, and an image has
 * none.
 *
 * The relay-dir layout (including where those files live) belongs to
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
 * The MIME target a bare paste means, the way `xclip -o` and `pbpaste` do.
 */
export const DEFAULT_PASTE_TARGET = 'text/plain';

/**
 * AppleScript clipboard classes, in the order `clipboard info` lists nothing in
 * particular, mapped to the MIME targets X11 tools speak. Only what a paste can
 * actually ask for: the long tail (`class 8BPS`, `class jp2 `, …) has no MIME
 * name a caller would probe for.
 */
const DARWIN_CLASS_TO_MIME: ReadonlyArray<readonly [string, string]> = [
  ['«class PNGf»', 'image/png'],
  ['JPEG picture', 'image/jpeg'],
  ['GIF picture', 'image/gif'],
  ['TIFF picture', 'image/tiff'],
  ['«class BMP »', 'image/bmp'],
  ['«class utf8»', 'text/plain'],
  ['«class ut16»', 'text/plain'],
  ['string', 'text/plain'],
];

/**
 * Turn the output of `osascript -e 'clipboard info'` into the MIME target list
 * a `TARGETS` probe expects. macOS answers in AppleScript class names, callers
 * ask in MIME types, so this is the translation between the two vocabularies.
 * Deduplicated and order-preserving: two text flavours are one `text/plain`.
 */
export function clipboardInfoToTargets(info: string): string[] {
  const targets: string[] = [];
  for (const [klass, mime] of DARWIN_CLASS_TO_MIME) {
    if (!info.includes(klass)) continue;
    if (!targets.includes(mime)) targets.push(mime);
  }
  return targets;
}

/**
 * The AppleScript class that holds a given MIME target, or null when macOS has
 * no such flavour. Text does not go through here — `pbpaste` reads it directly.
 */
export function darwinClassForTarget(target: string): string | null {
  for (const [klass, mime] of DARWIN_CLASS_TO_MIME) {
    if (mime === target && klass.startsWith('«')) return klass;
  }
  if (target === 'image/jpeg') return '«class JPEG»';
  if (target === 'image/gif') return '«class GIFf»';
  if (target === 'image/tiff') return '«class TIFF»';
  return null;
}

/**
 * Host commands that write the clipboard's `target` flavour into `outFile`,
 * best first — the same shape as `hostClipboardCommands`, for the other
 * direction. A file rather than stdout because the payload is binary and
 * PowerShell cannot be trusted to pass bytes through a pipe unmangled.
 *
 * `TARGETS` is not here: answering it means reading the clipboard's type list,
 * which is a query rather than a copy, and each platform words it differently.
 * `readHostClipboard` handles it.
 */
export function hostPasteCommands(
  target: string,
  outFile: string,
  platform: string,
  env: NodeJS.ProcessEnv = process.env,
): ClipboardCommand[] {
  if (platform === 'darwin') {
    if (target === 'text/plain') {
      return [['sh', ['-c', `pbpaste > ${JSON.stringify(outFile)}`]]];
    }
    const klass = darwinClassForTarget(target);
    if (!klass) return [];
    return [
      [
        'osascript',
        [
          '-e',
          `set data_ to (the clipboard as ${klass})`,
          '-e',
          `set fp to open for access POSIX file ${JSON.stringify(outFile)} with write permission`,
          '-e',
          'set eof fp to 0',
          '-e',
          'write data_ to fp',
          '-e',
          'close access fp',
        ],
      ],
    ];
  }
  if (platform === 'win32' || isWslHost(platform, env)) {
    const psFile = JSON.stringify(outFile);
    if (target === 'text/plain') {
      return [
        [
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Sta',
            '-Command',
            `Get-Clipboard -Raw | Set-Content -NoNewline -Encoding utf8 -LiteralPath ${psFile}`,
          ],
        ],
      ];
    }
    const format = target === 'image/bmp' ? 'Bmp' : 'Png';
    return [
      [
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Sta',
          '-Command',
          `Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($null -eq $img) { exit 1 }; $img.Save(${psFile}, [System.Drawing.Imaging.ImageFormat]::${format})`,
        ],
      ],
    ];
  }
  // A Linux host has the real tools; ask them exactly what the container asked
  // us, so the target vocabulary passes through untranslated.
  const quoted = JSON.stringify(outFile);
  const x11: ClipboardCommand = [
    'sh',
    ['-c', `xclip -selection clipboard -t ${target} -o > ${quoted}`],
  ];
  const wayland: ClipboardCommand = [
    'sh',
    ['-c', `wl-paste --type ${target} > ${quoted}`],
  ];
  return env['WAYLAND_DISPLAY'] ? [wayland, x11] : [x11, wayland];
}

/**
 * The type list a `TARGETS` probe gets, as newline-separated MIME types —
 * the format `xclip -t TARGETS -o` prints and every caller greps.
 */
function readHostTargets(platform: string, env: NodeJS.ProcessEnv): string {
  if (platform === 'darwin') {
    const info = execFileSync('osascript', ['-e', 'clipboard info'], {
      encoding: 'utf8',
    });
    return clipboardInfoToTargets(info).join('\n');
  }
  if (platform === 'win32' || isWslHost(platform, env)) {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Sta',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsImage()) { "image/png"; "image/bmp" }; if ([System.Windows.Forms.Clipboard]::ContainsText()) { "text/plain" }',
      ],
      { encoding: 'utf8' },
    );
    return out.trim();
  }
  return execFileSync(
    'sh',
    ['-c', 'xclip -selection clipboard -t TARGETS -o || wl-paste -l'],
    { encoding: 'utf8' },
  ).trim();
}

/**
 * Read the host clipboard in the flavour the container asked for. Returns null
 * when the clipboard holds nothing of that target, or no tool could answer —
 * the caller turns that into the empty response that makes the container-side
 * shim fail the way a real `xclip` fails on a missing target.
 */
export function readHostClipboard(
  target: string,
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Buffer | null {
  try {
    if (target === 'TARGETS') {
      const targets = readHostTargets(platform, env);
      return targets.length > 0 ? Buffer.from(`${targets}\n`, 'utf8') : null;
    }
  } catch {
    return null;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'monoceros-paste-'));
  const outFile = path.join(dir, 'payload');
  try {
    for (const [cmd, args] of hostPasteCommands(
      target,
      outFile,
      platform,
      env,
    )) {
      try {
        writeFileSync(outFile, '');
        execFileSync(cmd, args, { stdio: 'ignore' });
        if (statSync(outFile).size > 0) return readFileSync(outFile);
      } catch {
        /* not installed, or the clipboard has no such flavour — try the next */
      }
    }
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A pending paste request the container left in the relay dir. */
export interface PasteRequest {
  /** The request id, taken from the file name — the shim's pid. */
  id: string;
  /** The MIME target asked for, or `TARGETS` for the type list. */
  target: string;
}

const PASTE_REQUEST_PREFIX = 'paste-req.';
const PASTE_RESPONSE_PREFIX = 'paste-res.';

/**
 * Take every paste request waiting in the relay dir. Renaming the request away
 * before reading it is the same handover the copy direction uses: it is atomic,
 * so two watchers cannot answer the same request twice.
 */
export function takePasteRequests(dir: string): PasteRequest[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const requests: PasteRequest[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(PASTE_REQUEST_PREFIX)) continue;
    const id = entry.slice(PASTE_REQUEST_PREFIX.length);
    if (id.length === 0 || id.includes('.')) continue; // `.tmp` staging file
    const taking = path.join(dir, `${entry}.taking`);
    try {
      renameSync(path.join(dir, entry), taking);
    } catch {
      continue; // someone else took it
    }
    try {
      const target = readFileSync(taking, 'utf8').trim();
      requests.push({
        id,
        target: target.length > 0 ? target : DEFAULT_PASTE_TARGET,
      });
    } catch {
      /* vanished under us */
    } finally {
      rmSync(taking, { force: true });
    }
  }
  return requests;
}

/**
 * Answer one request. Staged and renamed into place so the shim, which polls
 * for the file, never reads a half-written payload. An empty file is a valid
 * answer and means "nothing of that target" — the shim turns it into the
 * failure a real clipboard tool reports.
 */
export function answerPasteRequest(
  dir: string,
  id: string,
  payload: Buffer | null,
): void {
  const target = path.join(dir, `${PASTE_RESPONSE_PREFIX}${id}`);
  const staging = `${target}.writing`;
  try {
    writeFileSync(staging, payload ?? Buffer.alloc(0));
    renameSync(staging, target);
  } catch {
    try {
      rmSync(staging, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Watch the relay dir for paste requests and answer each from the host
 * clipboard. The mirror of `watchClipboard`, and it polls for the same reason:
 * the dir lives on a bind mount, where fs events are unreliable.
 */
export function watchPasteRequests(opts: {
  relayDir: string;
  /** Injected by the tests; defaults to the real host clipboard. */
  read?: (target: string) => Buffer | null;
  /** Poll interval in ms. Default 50 — a paste is a keystroke, it must feel instant. */
  intervalMs?: number;
}): { dispose(): void } {
  const read = opts.read ?? ((target: string) => readHostClipboard(target));
  const poll = setInterval(() => {
    for (const request of takePasteRequests(opts.relayDir)) {
      let payload: Buffer | null = null;
      try {
        payload = read(request.target);
      } catch {
        payload = null;
      }
      answerPasteRequest(opts.relayDir, request.id, payload);
    }
  }, opts.intervalMs ?? 50);
  return {
    dispose(): void {
      clearInterval(poll);
    },
  };
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
