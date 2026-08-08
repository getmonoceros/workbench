import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayClipboardFile } from '../src/devcontainer/browser-bridge.js';
import {
  answerPasteRequest,
  clipboardInfoToTargets,
  hostClipboardCommands,
  hostPasteCommands,
  takeClipboardPayload,
  takePasteRequests,
  watchClipboard,
  watchPasteRequests,
} from '../src/devcontainer/clipboard-bridge.js';

const RELAY_SCRIPT = path.join(
  fileURLToPath(new URL('../../..', import.meta.url)),
  'images/runtime/clipboard-relay.sh',
);

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'monoceros-clipboard-'));
}

/**
 * Run the runtime relay shim under a given tool name. Omit `stdin` for a
 * paste-mode invocation: like the real `xclip -o`, the shim exits without
 * reading, so writing into it would race us into EPIPE — and no caller pipes
 * into a paste anyway.
 */
function runRelay(
  dir: string,
  name: string,
  args: string[],
  stdin?: string,
): string {
  const link = path.join(dir, name);
  copyFileSync(RELAY_SCRIPT, link);
  chmodSync(link, 0o755);
  return execFileSync(link, args, {
    ...(stdin === undefined
      ? { stdio: ['ignore', 'pipe', 'pipe'] as const }
      : { input: stdin }),
    encoding: 'utf8',
    env: { ...process.env, MONOCEROS_BRIDGE_DIR: path.join(dir, 'bridge') },
  });
}

/** Result of driving the shim in paste mode, from both ends of the relay. */
interface PasteRun {
  status: number | null;
  stdout: Buffer;
  /** The target the shim asked the host for, seen in the request file. */
  requestedTarget: string | null;
}

/**
 * Run the shim in paste mode and play the host side by hand: watch the bridge
 * dir for the request, then answer it (or don't, to exercise the timeout).
 * Async because the shim blocks on our answer — a synchronous child would
 * deadlock the poll that is supposed to unblock it.
 */
async function pasteRelay(
  dir: string,
  name: string,
  args: string[],
  answer?: Buffer,
): Promise<PasteRun> {
  const link = path.join(dir, name);
  copyFileSync(RELAY_SCRIPT, link);
  chmodSync(link, 0o755);
  const bridge = path.join(dir, 'bridge');
  const child = spawn(link, args, {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      MONOCEROS_BRIDGE_DIR: bridge,
      // Long enough that a slow CI box still sees our answer, short enough
      // that the no-answer cases do not stall the suite.
      MONOCEROS_CLIPBOARD_TIMEOUT_MS: '1500',
    },
  });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

  let requestedTarget: string | null = null;
  const exited = new Promise<number | null>((resolve) =>
    child.on('close', (code) => resolve(code)),
  );
  // Poll for the request the same way the real host watcher does.
  for (
    let waited = 0;
    waited < 1500 && requestedTarget === null;
    waited += 10
  ) {
    const pending = (existsSync(bridge) ? readdirSync(bridge) : []).find(
      (entry) => entry.startsWith('paste-req.') && !entry.endsWith('.tmp'),
    );
    if (pending) {
      requestedTarget = readFileSync(path.join(bridge, pending), 'utf8');
      const id = pending.slice('paste-req.'.length);
      rmSync(path.join(bridge, pending), { force: true });
      if (answer !== undefined) {
        const res = path.join(bridge, `paste-res.${id}`);
        writeFileSync(`${res}.writing`, answer);
        renameSync(`${res}.writing`, res);
      }
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return {
    status: await exited,
    stdout: Buffer.concat(chunks),
    requestedTarget,
  };
}

describe('relayClipboardFile', () => {
  it('sits next to the url-file in the container relay dir', () => {
    expect(relayClipboardFile('/root')).toBe(
      path.join('/root', '.monoceros-bridge', 'clipboard'),
    );
  });
});

describe('hostClipboardCommands', () => {
  it('uses pbcopy on macOS', () => {
    expect(hostClipboardCommands('darwin', {})).toEqual([['pbcopy', []]]);
  });

  it('reaches the Windows clipboard from WSL, UTF-8 safe', () => {
    const [first] = hostClipboardCommands('linux', {
      WSL_DISTRO_NAME: 'monoceros',
    });
    expect(first?.[0]).toBe('powershell.exe');
    // clip.exe would mangle non-ASCII — it reads the console codepage.
    expect(first?.[1].join(' ')).toContain('Set-Clipboard');
  });

  it('prefers wl-copy under Wayland and xclip otherwise', () => {
    expect(
      hostClipboardCommands('linux', { WAYLAND_DISPLAY: 'wayland-0' })[0],
    ).toEqual(['wl-copy', []]);
    expect(hostClipboardCommands('linux', {})[0]).toEqual([
      'xclip',
      ['-selection', 'clipboard'],
    ]);
  });

  it('always offers a fallback, so one missing tool is not the end', () => {
    expect(hostClipboardCommands('linux', {}).length).toBeGreaterThan(1);
  });
});

describe('takeClipboardPayload', () => {
  it('takes the payload and leaves nothing behind', () => {
    const dir = tempDir();
    const file = path.join(dir, 'clipboard');
    writeFileSync(file, 'copied text');
    expect(takeClipboardPayload(file)).toBe('copied text');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('preserves the payload verbatim — no trimming, no added newline', () => {
    const dir = tempDir();
    const file = path.join(dir, 'clipboard');
    writeFileSync(file, '  two words\nand a line  ');
    expect(takeClipboardPayload(file)).toBe('  two words\nand a line  ');
  });

  it('returns null when there is nothing to take, or it is empty', () => {
    const dir = tempDir();
    const file = path.join(dir, 'clipboard');
    expect(takeClipboardPayload(file)).toBeNull();
    writeFileSync(file, '');
    expect(takeClipboardPayload(file)).toBeNull();
  });

  it('hands the payload to exactly one taker', () => {
    // The per-session bridge and the always-on daemon can watch the same file;
    // the rename is what keeps a copy from landing on the clipboard twice.
    const dir = tempDir();
    const file = path.join(dir, 'clipboard');
    writeFileSync(file, 'once');
    expect(takeClipboardPayload(file)).toBe('once');
    expect(takeClipboardPayload(file)).toBeNull();
  });
});

describe('watchClipboard', () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });

  it('relays each payload the container drops, and stops on dispose', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'clipboard');
    const written: string[] = [];
    const watcher = watchClipboard({
      clipboardFile: file,
      write: (text) => written.push(text),
      intervalMs: 5,
    });
    disposers.push(() => watcher.dispose());

    writeFileSync(file, 'first');
    await vi.waitFor(() => expect(written).toEqual(['first']));
    // Same text again is a real second copy, not a poll artefact — relay it.
    writeFileSync(file, 'first');
    await vi.waitFor(() => expect(written).toEqual(['first', 'first']));

    watcher.dispose();
    writeFileSync(file, 'after dispose');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(written).toEqual(['first', 'first']);
    expect(existsSync(file)).toBe(true);
  });
});

describe('runtime relay shim', () => {
  it('copies stdin to the bridge dir when invoked as a copy tool', () => {
    const dir = tempDir();
    runRelay(dir, 'pbcopy', [], 'from the container');
    expect(takeClipboardPayload(path.join(dir, 'bridge', 'clipboard'))).toBe(
      'from the container',
    );
  });

  it('copies under every name a tool probes for, flags and all', () => {
    for (const [name, args] of [
      ['xclip', ['-selection', 'clipboard']],
      ['xsel', ['--clipboard', '--input']],
      ['wl-copy', []],
    ] as const) {
      const dir = tempDir();
      runRelay(dir, name, [...args], `via ${name}`);
      expect(takeClipboardPayload(path.join(dir, 'bridge', 'clipboard'))).toBe(
        `via ${name}`,
      );
    }
  });

  it('leaves no copy payload when asked to paste', async () => {
    // A bare `xsel` prints the selection; `xclip -o` does too. Neither is a
    // copy, so neither may leave a payload for the host clipboard.
    for (const [name, args] of [
      ['xsel', []],
      ['xclip', ['-o']],
    ] as const) {
      const dir = tempDir();
      await pasteRelay(dir, name, [...args], Buffer.from('text'));
      expect(existsSync(path.join(dir, 'bridge', 'clipboard'))).toBe(false);
    }
  });

  it('hands the host payload to stdout, bytes intact', async () => {
    // The whole point: a PNG on the host clipboard has to arrive in the
    // container byte-for-byte, NUL bytes and all.
    const dir = tempDir();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x1a]);
    const run = await pasteRelay(
      dir,
      'xclip',
      ['-selection', 'clipboard', '-t', 'image/png', '-o'],
      png,
    );
    expect(run.status).toBe(0);
    expect(run.stdout.equals(png)).toBe(true);
  });

  it('fails the paste when the host has nothing, so a caller can fall back', async () => {
    // `xclip -t image/png -o > f || wl-paste --type image/png > f` chains on
    // the exit code. Exiting 0 with no output would leave the caller holding
    // an empty file it believes is a PNG. Both an empty answer and no answer
    // at all have to fail.
    for (const answer of [Buffer.alloc(0), undefined]) {
      const dir = tempDir();
      const run = await pasteRelay(
        dir,
        'xclip',
        ['-selection', 'clipboard', '-t', 'image/png', '-o'],
        answer,
      );
      expect(run.status).not.toBe(0);
      expect(run.stdout.length).toBe(0);
    }
  });

  it('leaves nothing behind in the relay dir, answered or not', async () => {
    const dir = tempDir();
    await pasteRelay(
      dir,
      'xclip',
      ['-t', 'image/png', '-o'],
      Buffer.from('png'),
    );
    expect(readdirSync(path.join(dir, 'bridge'))).toEqual([]);
  });

  it('names the target it wants, in each spelling the tools use', async () => {
    for (const [name, args, expected] of [
      ['xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], 'TARGETS'],
      [
        'xclip',
        ['-selection', 'clipboard', '-t', 'image/png', '-o'],
        'image/png',
      ],
      ['wl-paste', ['--type', 'image/png'], 'image/png'],
      ['wl-paste', ['--type=image/bmp'], 'image/bmp'],
      // wl-paste spells the type list `-l`; xclip spells it `-t TARGETS`.
      ['wl-paste', ['-l'], 'TARGETS'],
      // A bare paste means plain text, the way `pbpaste` and `xclip -o` do.
      ['pbpaste', [], 'text/plain'],
      ['xsel', [], 'text/plain'],
    ] as const) {
      const dir = tempDir();
      const run = await pasteRelay(dir, name, [...args], Buffer.from('x'));
      expect(`${name} ${args.join(' ')} -> ${run.requestedTarget}`).toBe(
        `${name} ${args.join(' ')} -> ${expected}`,
      );
    }
  });

  it('leaves no staging file behind', () => {
    const dir = tempDir();
    runRelay(dir, 'pbcopy', [], 'payload');
    expect(readdirSync(path.join(dir, 'bridge'))).toEqual(['clipboard']);
  });
});

describe('clipboardInfoToTargets', () => {
  // Verbatim from `osascript -e 'clipboard info'` with a screenshot copied.
  const SCREENSHOT =
    '«class PNGf», 47299, «class AVIF», 13495, «class 8BPS», 209622, ' +
    'GIF picture, 13534, «class jp2 », 52336, JPEG picture, 35707, ' +
    'TIFF picture, 2387528, «class BMP », 2384058, «class TPIC», 97590';

  it('translates macOS classes into the MIME names a caller greps for', () => {
    expect(clipboardInfoToTargets(SCREENSHOT)).toEqual([
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/tiff',
      'image/bmp',
    ]);
  });

  it('reports text once, however many flavours macOS holds it in', () => {
    const info = '«class utf8», 11, «class ut16», 24, string, 11';
    expect(clipboardInfoToTargets(info)).toEqual(['text/plain']);
  });

  it('says nothing about flavours with no MIME name', () => {
    expect(clipboardInfoToTargets('«class 8BPS», 209622')).toEqual([]);
  });
});

describe('hostPasteCommands', () => {
  it('reads an image off the macOS pasteboard by its AppleScript class', () => {
    const [first] = hostPasteCommands('image/png', '/tmp/out', 'darwin', {});
    expect(first?.[0]).toBe('osascript');
    expect(first?.[1].join(' ')).toContain('«class PNGf»');
  });

  it('uses pbpaste for text rather than an AppleScript detour', () => {
    const [first] = hostPasteCommands('text/plain', '/tmp/out', 'darwin', {});
    expect(first?.[1].join(' ')).toContain('pbpaste');
  });

  it('offers nothing for a flavour macOS cannot hold', () => {
    expect(hostPasteCommands('image/webp', '/tmp/out', 'darwin', {})).toEqual(
      [],
    );
  });

  it('needs -Sta on Windows, or the clipboard API refuses', () => {
    const [first] = hostPasteCommands('image/png', 'C:\\out', 'win32', {});
    expect(first?.[0]).toBe('powershell.exe');
    expect(first?.[1]).toContain('-Sta');
    expect(first?.[1].join(' ')).toContain('GetImage');
  });

  it('reaches the Windows clipboard from WSL too', () => {
    const [first] = hostPasteCommands('image/png', '/tmp/out', 'linux', {
      WSL_DISTRO_NAME: 'monoceros',
    });
    expect(first?.[0]).toBe('powershell.exe');
  });

  it('passes the target through untouched to a real Linux tool', () => {
    const [first] = hostPasteCommands('image/png', '/tmp/out', 'linux', {});
    expect(first?.[1].join(' ')).toContain('-t image/png');
    const [wayland] = hostPasteCommands('image/png', '/tmp/out', 'linux', {
      WAYLAND_DISPLAY: 'wayland-0',
    });
    expect(wayland?.[1].join(' ')).toContain('wl-paste --type image/png');
  });
});

describe('takePasteRequests', () => {
  it('reads the target and hands the request to exactly one taker', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'paste-req.42'), 'image/png');
    expect(takePasteRequests(dir)).toEqual([{ id: '42', target: 'image/png' }]);
    expect(takePasteRequests(dir)).toEqual([]);
  });

  it('ignores a request still being staged', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'paste-req.42.tmp'), 'image/p');
    expect(takePasteRequests(dir)).toEqual([]);
  });

  it('treats an empty request as the plain-text default', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'paste-req.7'), '');
    expect(takePasteRequests(dir)).toEqual([{ id: '7', target: 'text/plain' }]);
  });
});

describe('answerPasteRequest', () => {
  it('leaves the response in one piece, with no staging file', () => {
    const dir = tempDir();
    answerPasteRequest(dir, '9', Buffer.from([1, 2, 3]));
    expect(readdirSync(dir)).toEqual(['paste-res.9']);
    expect(readFileSync(path.join(dir, 'paste-res.9'))).toEqual(
      Buffer.from([1, 2, 3]),
    );
  });

  it('answers an empty file when the host has nothing', () => {
    const dir = tempDir();
    answerPasteRequest(dir, '9', null);
    expect(readFileSync(path.join(dir, 'paste-res.9')).length).toBe(0);
  });
});

describe('paste round trip', () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });

  it('carries a host PNG into the container through the real shim', async () => {
    // End to end over the actual relay protocol: the shim asks, the host
    // watcher answers, the bytes come out of stdout. This is the path a CLI
    // takes when someone pastes a screenshot inside the container.
    const dir = tempDir();
    const bridge = path.join(dir, 'bridge');
    mkdirSync(bridge, { recursive: true });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const asked: string[] = [];
    const watcher = watchPasteRequests({
      relayDir: bridge,
      read: (target) => {
        asked.push(target);
        if (target === 'TARGETS') return Buffer.from('image/png\n');
        return target === 'image/png' ? png : null;
      },
      intervalMs: 5,
    });
    disposers.push(() => watcher.dispose());

    const link = path.join(dir, 'xclip');
    copyFileSync(RELAY_SCRIPT, link);
    chmodSync(link, 0o755);
    // Async, never spawnSync: the shim blocks until the watcher answers, and
    // a synchronous child would block the event loop the watcher polls on.
    const run = (
      args: string[],
    ): Promise<{ status: number | null; stdout: Buffer }> =>
      new Promise((resolve) => {
        const child = spawn(link, args, {
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, MONOCEROS_BRIDGE_DIR: bridge },
        });
        const chunks: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.on('close', (status) =>
          resolve({ status, stdout: Buffer.concat(chunks) }),
        );
      });

    const targets = await run(['-t', 'TARGETS', '-o']);
    expect(targets.stdout.toString()).toContain('image/png');
    const image = await run(['-t', 'image/png', '-o']);
    expect(image.status).toBe(0);
    expect(image.stdout.equals(png)).toBe(true);
    expect(asked).toEqual(['TARGETS', 'image/png']);
    // Nothing lingers: a stale response would be served to the next paste.
    expect(readdirSync(bridge)).toEqual([]);
  });
});
