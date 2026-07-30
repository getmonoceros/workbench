import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayClipboardFile } from '../src/devcontainer/browser-bridge.js';
import {
  hostClipboardCommands,
  takeClipboardPayload,
  watchClipboard,
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

  it('writes nothing when asked to paste instead of copy', () => {
    // A bare `xsel` prints the selection; `xclip -o` does too. Neither is a
    // copy, so neither may leave a payload for the host.
    for (const [name, args] of [
      ['xsel', []],
      ['xclip', ['-o']],
    ] as const) {
      const dir = tempDir();
      const out = runRelay(dir, name, [...args]);
      expect(out).toBe('');
      expect(existsSync(path.join(dir, 'bridge', 'clipboard'))).toBe(false);
    }
  });

  it('leaves no staging file behind', () => {
    const dir = tempDir();
    runRelay(dir, 'pbcopy', [], 'payload');
    expect(readdirSync(path.join(dir, 'bridge'))).toEqual(['clipboard']);
  });
});
