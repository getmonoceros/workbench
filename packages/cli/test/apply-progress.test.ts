import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createApplyProgress,
  logFileOnlyLogger,
  progressTeeLogger,
} from '../src/apply/apply-progress.js';

// Fake WriteStream that captures everything written so we can assert
// on the exact byte sequence the spinner would emit, without touching
// process.stderr. `isTTY` is part of the surface area the apply code
// branches on; we expose it as a plain property.
function makeFakeOut(opts: { isTTY: boolean }): {
  stream: NodeJS.WriteStream;
  written: () => string;
} {
  const chunks: string[] = [];
  const write = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  // Cast through unknown — we only use `.write` and `.isTTY` on this
  // object, the rest of the WriteStream shape doesn't matter for the
  // tests.
  const stream = { write, isTTY: opts.isTTY } as unknown as NodeJS.WriteStream;
  return { stream, written: () => chunks.join('') };
}

function makeSinkBuffer(): { sink: Writable; text: () => string } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb): void {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  return { sink, text: () => chunks.join('') };
}

describe('createApplyProgress (non-interactive)', () => {
  it('emits plain `> phase` lines on phase changes', () => {
    const { stream, written } = makeFakeOut({ isTTY: false });
    const progress = createApplyProgress({ out: stream, interactive: false });
    progress.setPhase('starting container…');
    progress.setPhase('running postCreate…');
    progress.setPhase('running postCreate…'); // duplicate — no-op
    expect(written()).toBe('> starting container…\n> running postCreate…\n');
  });

  it('println writes the line verbatim (with trailing newline)', () => {
    const { stream, written } = makeFakeOut({ isTTY: false });
    const progress = createApplyProgress({ out: stream, interactive: false });
    progress.println('Features: x, y, z');
    progress.println('done\n'); // explicit newline kept, not doubled
    expect(written()).toBe('Features: x, y, z\ndone\n');
  });

  it('succeed prints ✔ with formatted elapsed time', () => {
    const { stream, written } = makeFakeOut({ isTTY: false });
    let nowMs = 1_000;
    const progress = createApplyProgress({
      out: stream,
      interactive: false,
      now: () => nowMs,
    });
    nowMs += 74_000; // 1m 14s
    progress.succeed();
    expect(written()).toBe('✔ container ready (1m 14s)\n');
  });

  it('succeed under a minute uses Xs format', () => {
    const { stream, written } = makeFakeOut({ isTTY: false });
    let nowMs = 0;
    const progress = createApplyProgress({
      out: stream,
      interactive: false,
      now: () => nowMs,
    });
    nowMs += 12_400;
    progress.succeed();
    expect(written()).toBe('✔ container ready (12s)\n');
  });

  it('succeed accepts a custom label', () => {
    const { stream, written } = makeFakeOut({ isTTY: false });
    const progress = createApplyProgress({
      out: stream,
      interactive: false,
      now: () => 0,
    });
    progress.succeed('done');
    expect(written()).toBe('✔ done\n');
  });
});

describe('createApplyProgress stream sink (phase detection + tail)', () => {
  it('advances phase on `Start: Run: docker run`', () => {
    const { stream, written } = makeFakeOut({ isTTY: false });
    const progress = createApplyProgress({ out: stream, interactive: false });
    progress.streamSink.write(
      '[2026-06-03T15:15:21.431Z] Start: Run: docker run --sig-proxy=false …\n',
    );
    expect(written()).toBe('> starting container…\n');
  });

  it('advances phase on `Running the postCreateCommand`', () => {
    const { stream, written } = makeFakeOut({ isTTY: false });
    const progress = createApplyProgress({ out: stream, interactive: false });
    progress.streamSink.write(
      'Running the postCreateCommand from devcontainer.json...\n',
    );
    expect(written()).toBe('> running postCreate…\n');
  });

  it('handles split chunks across newlines without losing trigger lines', () => {
    const { stream, written } = makeFakeOut({ isTTY: false });
    const progress = createApplyProgress({ out: stream, interactive: false });
    progress.streamSink.write('[12:00:00] Start: ');
    progress.streamSink.write('Run: docker run thing\nNext line\n');
    expect(written()).toBe('> starting container…\n');
  });

  it('captures the last 15 lines as the tail buffer (older lines drop)', () => {
    const { stream } = makeFakeOut({ isTTY: false });
    const progress = createApplyProgress({ out: stream, interactive: false });
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) lines.push(`line-${i}`);
    progress.streamSink.write(lines.join('\n') + '\n');
    const { tailLines } = progress.fail();
    expect(tailLines).toHaveLength(15);
    expect(tailLines[0]).toBe('line-5');
    expect(tailLines[14]).toBe('line-19');
  });

  it('strips ANSI escape codes before matching triggers and buffering tail', () => {
    const { stream, written } = makeFakeOut({ isTTY: false });
    const progress = createApplyProgress({ out: stream, interactive: false });
    // Tinted phase line — match still succeeds.
    progress.streamSink.write('\x1b[90mStart: Run: docker run x\x1b[0m\n');
    expect(written()).toBe('> starting container…\n');
    const { tailLines } = progress.fail();
    expect(tailLines).toEqual(['Start: Run: docker run x']);
  });
});

describe('createApplyProgress (interactive)', () => {
  it('renders an ANSI clear+spinner line and clears it on succeed', () => {
    const { stream, written } = makeFakeOut({ isTTY: true });
    let nowMs = 0;
    const progress = createApplyProgress({
      out: stream,
      interactive: true,
      now: () => nowMs,
    });
    progress.setPhase('starting container…');
    nowMs += 5_000;
    progress.succeed();
    const out = written();
    // Spinner output contains the cursor reset + clear + frame + label.
    expect(out).toContain('\r\x1b[K');
    expect(out).toContain('starting container…');
    // Final line printed below the (cleared) spinner.
    expect(out).toContain('✔ container ready (5s)\n');
  });

  it('println pauses the spinner, writes the line, then re-renders the spinner', () => {
    const { stream, written } = makeFakeOut({ isTTY: true });
    const progress = createApplyProgress({
      out: stream,
      interactive: true,
      now: () => 0,
    });
    progress.println('Features: foo');
    progress.succeed();
    const out = written();
    // eslint-disable-next-line no-control-regex
    expect(out).toMatch(/\r\x1b\[KFeatures: foo\n/);
    expect(out).toContain('✔ container ready');
  });
});

describe('progressTeeLogger / logFileOnlyLogger', () => {
  it('progressTeeLogger writes to progress.println AND the file sink', () => {
    const { stream } = makeFakeOut({ isTTY: false });
    const progress = createApplyProgress({ out: stream, interactive: false });
    const { sink, text } = makeSinkBuffer();
    const lg = progressTeeLogger(progress, sink);
    lg.info('hello');
    lg.warn('careful');
    lg.success('done');
    expect(text()).toBe('[info] hello\n[warn] careful\n[ok] done\n');
  });

  it('logFileOnlyLogger does not touch the screen, only the file sink', () => {
    const { stream, written } = makeFakeOut({ isTTY: false });
    const progress = createApplyProgress({ out: stream, interactive: false });
    const { sink, text } = makeSinkBuffer();
    const lg = logFileOnlyLogger(sink);
    lg.info('chatter');
    lg.warn('quiet');
    lg.success('hush');
    // Stream untouched — phase still at the initial state, no other output.
    expect(written()).toBe('');
    expect(text()).toBe('[info] chatter\n[warn] quiet\n[ok] hush\n');
    progress.fail();
  });
});
