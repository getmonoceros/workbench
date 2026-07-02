import { Writable } from 'node:stream';
import { stripAnsi } from '../util/format.js';

/**
 * Apply-time phase spinner + tail buffer. ADR 0013 step 2.
 *
 * In interactive mode (TTY, no `--verbose`), the raw `@devcontainers/cli`
 * output is suppressed on screen and replaced by a single line: a
 * spinner glyph plus the current phase label. The phase advances when
 * recognizable triggers appear in the stream (see {@link PHASE_TRIGGERS}).
 *
 * The same stream chunks feed a {@link TAIL_LINES}-line ring buffer.
 * On failure the caller pulls that tail out and prints it to stderr,
 * so the builder sees the actual diagnostic instead of an empty
 * "apply failed" message — the rest lives in the apply log file.
 *
 * In non-interactive mode the spinner is replaced by plain
 * `> phase…` lines on phase changes — useful when output is piped to
 * a file. The stream itself is NOT echoed there either; the log
 * file is the source of truth.
 */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_INTERVAL_MS = 80;
const TAIL_LINES = 15;

/**
 * Stream triggers that advance the spinner label. Order matters — the
 * first match per line wins, so put more specific patterns first.
 * Each pattern is matched against single output lines after ANSI
 * stripping, so any colour/style codes in upstream output do not
 * interfere with detection.
 */
const PHASE_TRIGGERS: ReadonlyArray<{
  pattern: RegExp;
  /** A fixed label, or one derived from the matched line's capture groups. */
  label: string | ((m: RegExpMatchArray) => string);
}> = [
  // Feature/layer build — distinct phase, often the longest single
  // step. Image mode runs `docker build`; compose mode runs
  // `docker compose … build <services>`. We match the build *subcommand*
  // (a space-delimited ` build`), NOT the substring — the compose `up`
  // line below carries `-f …devcontainer.build-<n>.yml` and would
  // otherwise false-match here and swallow the "starting" phase.
  {
    pattern: /Start: Run: docker (?:build\b|compose\b.* build\b)/i,
    label: 'building feature layers…',
  },
  // Container create/start. Image mode: `docker run` (pulls if needed,
  // creates, starts). Compose mode: `docker compose … up -d <services>`.
  {
    pattern: /Start: Run: docker (?:run\b|compose\b.* up\b)/i,
    label: 'starting container…',
  },
  // post-create.sh sub-steps. Repo clones are the long, network-bound
  // part; surface which repo is being cloned instead of an opaque
  // "running postCreate…". The marker is the `→ Cloning <path> from …`
  // line post-create.sh echoes (see create/scaffold.ts). A devcontainer
  // timestamp prefix is fine — the pattern is unanchored.
  {
    pattern: /→ Cloning (\S+) from /,
    label: (m) => `cloning ${m[1]}…`,
  },
  { pattern: /Running the postCreateCommand/i, label: 'running postCreate…' },
];

export interface ApplyProgressOptions {
  /** Stream to write the spinner to. Usually `process.stderr`. */
  out: NodeJS.WriteStream;
  /**
   * When true, emit the spinner via `\r\x1b[K` cursor manipulation.
   * When false, emit a plain `> phase…\n` line on each phase change.
   * Tests use `false` with an in-memory stream; production picks
   * based on `out.isTTY && !verbose`.
   */
  interactive: boolean;
  /** Override the clock for deterministic elapsed-time formatting. */
  now?: () => number;
}

export interface ApplyProgress {
  /** Change the visible phase label. No-op if same as current. */
  setPhase(label: string): void;
  /**
   * Print `line` above the spinner: pause the spinner, write the line
   * with a trailing newline (added if missing), restart the spinner.
   * Use for one-off status lines that must stay visible — `Features: …`
   * or a Traefik-routing warning.
   */
  println(line: string): void;
  /** Stop the spinner and emit `✔ <label>` (elapsed time appended). */
  succeed(label?: string): void;
  /** Stop the spinner; return the captured tail lines. */
  fail(): { tailLines: string[] };
  /**
   * Writable to pass to `spawnDevcontainer` as `progressSink`. Drives
   * phase detection and fills the tail ring buffer.
   */
  readonly streamSink: Writable;
}

export function createApplyProgress(opts: ApplyProgressOptions): ApplyProgress {
  const out = opts.out;
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  let phase = 'preparing…';
  let frameIdx = 0;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const tail: string[] = [];
  let lineBuf = '';

  const writeSpinner = (): void => {
    if (!opts.interactive || stopped) return;
    out.write(`\r\x1b[K${FRAMES[frameIdx]} ${phase}`);
  };
  const clearLine = (): void => {
    if (!opts.interactive) return;
    out.write('\r\x1b[K');
  };

  const setPhase = (label: string): void => {
    if (phase === label) return;
    phase = label;
    if (opts.interactive) {
      writeSpinner();
    } else {
      out.write(`> ${label}\n`);
    }
  };

  const println = (line: string): void => {
    clearLine();
    const withNewline = line.endsWith('\n') ? line : `${line}\n`;
    out.write(withNewline);
    writeSpinner();
  };

  const fmtElapsed = (): string => {
    const ms = now() - startedAt;
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (!stopped) {
      stopped = true;
      clearLine();
    }
  };

  const succeed = (label?: string): void => {
    stop();
    const text = label ?? `container ready (${fmtElapsed()})`;
    out.write(`✔ ${text}\n`);
  };

  const fail = (): { tailLines: string[] } => {
    stop();
    return { tailLines: [...tail] };
  };

  const streamSink = new Writable({
    write(chunk, _enc, cb): void {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      lineBuf += stripAnsi(text);
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (line.length === 0) continue;
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
        for (const trig of PHASE_TRIGGERS) {
          const m = line.match(trig.pattern);
          if (m) {
            setPhase(
              typeof trig.label === 'function' ? trig.label(m) : trig.label,
            );
            break;
          }
        }
      }
      cb();
    },
  });

  if (opts.interactive) {
    writeSpinner();
    timer = setInterval(() => {
      frameIdx = (frameIdx + 1) % FRAMES.length;
      writeSpinner();
    }, FRAME_INTERVAL_MS);
    // Don't keep the event loop alive just because the spinner is
    // ticking — the apply work itself owns the lifetime.
    timer.unref?.();
  }

  return {
    setPhase,
    println,
    succeed,
    fail,
    streamSink,
  };
}

/**
 * Logger shape compatible with the rest of the apply pipeline that
 * routes info/warn/success through a {@link ApplyProgress} (above the
 * spinner) and into the apply log sink.
 */
export function progressTeeLogger(
  progress: ApplyProgress,
  sink: Writable,
): {
  info: (msg: string) => void;
  success: (msg: string) => void;
  warn: (msg: string) => void;
} {
  const fileLine = (level: string, msg: string): void => {
    sink.write(`[${level}] ${msg}\n`);
  };
  return {
    info: (msg) => {
      progress.println(msg);
      fileLine('info', msg);
    },
    success: (msg) => {
      progress.println(`✔ ${msg}`);
      fileLine('ok', msg);
    },
    warn: (msg) => {
      progress.println(`! ${msg}`);
      fileLine('warn', msg);
    },
  };
}

/**
 * Logger that only writes to the apply log sink. Used in interactive
 * mode for diagnostic chatter from `runContainerCycle`'s compose
 * pre-cleanup ([cleanup] tearing down…, removing containers, etc.) —
 * the spinner phase covers what is happening on screen; the full
 * detail lives in the log file.
 */
export function logFileOnlyLogger(sink: Writable): {
  info: (msg: string) => void;
  success: (msg: string) => void;
  warn: (msg: string) => void;
} {
  const fileLine = (level: string, msg: string): void => {
    sink.write(`[${level}] ${msg}\n`);
  };
  return {
    info: (msg) => fileLine('info', msg),
    success: (msg) => fileLine('ok', msg),
    warn: (msg) => fileLine('warn', msg),
  };
}

/**
 * SIGINT cleanup for `monoceros apply`: stop the spinner, mark the
 * log file with an abort marker, close the file, then call `onExit`
 * (which production wires to `process.exit(130)`). Extracted from
 * `runApply` so the abort flow can be exercised without registering
 * a real signal handler.
 *
 * The returned function is the handler itself. Re-entry — a second
 * Ctrl+C while the first cleanup is still running — is guarded so
 * the second press becomes a no-op and lets the runtime handle a
 * hard kill.
 */
export interface ApplyAbortDeps {
  progress: ApplyProgress | null;
  /**
   * Where the `⏹ aborted` line and the final log-path pointer are
   * written. Production uses `process.stderr` (or the same stream
   * the spinner uses); tests inject an in-memory writable.
   */
  out: { write: (chunk: string) => void };
  log: {
    stream: { write: (chunk: string) => void };
    close: () => Promise<void>;
    path: string;
  };
  /** Format the final pointer line — kept injectable for ANSI-free assertions. */
  formatLogPointer: (path: string) => string;
  /** Process-terminator. Production passes a function calling `process.exit(130)`. */
  onExit: () => void;
}

export function createSigintAbort(deps: ApplyAbortDeps): () => void {
  let aborted = false;
  return (): void => {
    if (aborted) return;
    aborted = true;
    if (deps.progress) deps.progress.fail();
    deps.out.write('\n⏹ aborted\n');
    deps.log.stream.write('\n[abort] SIGINT received\n');
    void deps.log.close().finally(() => {
      deps.out.write(`\n  ${deps.formatLogPointer(deps.log.path)}\n`);
      deps.onExit();
    });
  };
}
