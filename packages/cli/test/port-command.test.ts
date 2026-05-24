import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPortListing } from '../src/commands/port.js';

/**
 * Build a writable stream that captures everything written to it as a
 * single string. Honors an explicit isTTY toggle so we can exercise
 * both the pipe-friendly and the aligned-column branches without
 * touching process.stdout.
 */
function captureStream(isTty: boolean): {
  stream: NodeJS.WriteStream;
  read: () => string;
} {
  const passthrough = new PassThrough();
  let buffer = '';
  passthrough.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
  });
  // PassThrough satisfies the writable parts of WriteStream; only
  // isTTY isn't there. Cast through a small intersection rather than
  // any so the misuse is contained.
  const stream = passthrough as unknown as NodeJS.WriteStream & {
    isTTY: boolean;
  };
  stream.isTTY = isTty;
  return { stream, read: () => buffer };
}

describe('runPortListing', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-port-'));
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('prints a default row plus a per-port row in the non-TTY branch', async () => {
    await writeFile(
      path.join(home, 'container-configs', 'demo.yml'),
      [
        'schemaVersion: 1',
        'name: demo',
        'routing:',
        '  ports:',
        '    - 3000',
        '    - 5173',
        '',
      ].join('\n'),
    );
    const { stream, read } = captureStream(false);
    const exit = await runPortListing({
      name: 'demo',
      monocerosHome: home,
      out: stream,
    });
    expect(exit).toBe(0);
    // Split on newlines instead of trim+split so a trailing empty
    // tag column on the last line doesn't get stripped along with
    // the trailing newline.
    const lines = read().split('\n').slice(0, -1);
    expect(lines).toEqual([
      '3000\thttp://demo.localhost\tdefault',
      '3000\thttp://demo-3000.localhost\t',
      '5173\thttp://demo-5173.localhost\t',
    ]);
  });

  it('appends the host-port suffix when routing.hostPort != 80', async () => {
    await writeFile(
      path.join(home, 'container-configs', 'demo.yml'),
      [
        'schemaVersion: 1',
        'name: demo',
        'routing:',
        '  ports:',
        '    - 3000',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(home, 'monoceros-config.yml'),
      ['schemaVersion: 1', 'routing:', '  hostPort: 8080', ''].join('\n'),
    );
    const { stream, read } = captureStream(false);
    await runPortListing({ name: 'demo', monocerosHome: home, out: stream });
    expect(read()).toContain('http://demo.localhost:8080');
    expect(read()).toContain('http://demo-3000.localhost:8080');
  });

  it('emits a hint and exits 0 when no ports are declared', async () => {
    await writeFile(
      path.join(home, 'container-configs', 'demo.yml'),
      'schemaVersion: 1\nname: demo\n',
    );
    const hints: string[] = [];
    const { stream, read } = captureStream(false);
    const exit = await runPortListing({
      name: 'demo',
      monocerosHome: home,
      out: stream,
      info: (m) => hints.push(m),
    });
    expect(exit).toBe(0);
    expect(read()).toBe('');
    expect(hints[0]).toMatch(/No ports declared in demo\.yml/);
    expect(hints[0]).toMatch(/monoceros add-port demo/);
  });

  it('renders the TTY-aligned table when isTTY is true', async () => {
    await writeFile(
      path.join(home, 'container-configs', 'demo.yml'),
      [
        'schemaVersion: 1',
        'name: demo',
        'routing:',
        '  ports:',
        '    - 3000',
        '',
      ].join('\n'),
    );
    const { stream, read } = captureStream(true);
    await runPortListing({ name: 'demo', monocerosHome: home, out: stream });
    // ANSI colours are present in TTY mode; we don't assert on the
    // escape sequences (palette could be tuned), only on the
    // human-friendly arrow and parenthetical-default tag.
    expect(read()).toMatch(/3000.+→.+http:\/\/demo\.localhost/);
    expect(read()).toContain('(default)');
  });
});
