import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { containerLogsDir } from '../config/paths.js';
import { stripAnsi } from '../util/format.js';

/**
 * Per-apply log file under `<home>/container/<name>/logs/`.
 *
 * Step 1 of ADR 0013: the terminal still receives the live
 * `@devcontainers/cli` stream and the existing `▸ Container` section
 * lines unchanged. In parallel, a Writable is offered to the
 * devcontainer spawn (`logSink`) and a tee-logger mirrors the
 * `logger.info/.success/.warn` calls into the same file, so the log
 * contains the full apply transcript including the bits the spawn
 * stream does not see (Features list, traefik warnings, compose
 * pre-cleanup).
 *
 * Caller responsibilities:
 *  - call `close()` exactly once after the container cycle finishes,
 *    on the happy path and on the error path
 *  - hand the resulting `path` to the user via a final `ℹ log: <path>`
 *    line so the artifact is discoverable
 */
export interface ApplyLogOptions {
  name: string;
  home: string;
  cliVersion: string;
  configPath: string;
  now?: Date;
}

export interface ApplyLog {
  /** Absolute path to the open log file. */
  path: string;
  /** Underlying write stream — pass as `logSink` to devcontainer spawns. */
  stream: WriteStream;
  /** Plain-text mirror sink for our own status lines (ANSI-stripped). */
  sink: Writable;
  /** Close the file. Safe to call once; subsequent calls are no-ops. */
  close(): Promise<void>;
}

function safeIsoStamp(d: Date): string {
  // ISO with `:` and `.` replaced — colons are invalid in NTFS filenames
  // and `.` before the suffix would imply a doubled extension.
  return d.toISOString().replace(/[:.]/g, '-');
}

export function createApplyLog(opts: ApplyLogOptions): ApplyLog {
  const now = opts.now ?? new Date();
  const dir = containerLogsDir(opts.name, opts.home);
  mkdirSync(dir, { recursive: true });
  const file = `apply-${opts.name}-${safeIsoStamp(now)}.log`;
  const fullPath = path.join(dir, file);
  const stream = createWriteStream(fullPath, { flags: 'w' });

  // Header — small, human-readable, fixed key=value style so `grep` and
  // future tooling can find the apply context without parsing prose.
  const header = [
    `# monoceros apply log`,
    `# command:     monoceros apply ${opts.name}`,
    `# started:     ${now.toISOString()}`,
    `# cli-version: ${opts.cliVersion}`,
    `# config:      ${opts.configPath}`,
    `# host:        ${process.platform}/${process.arch} node ${process.version}`,
    ``,
    ``,
  ].join('\n');
  stream.write(header);

  // ANSI-stripping Writable for our own status lines. devcontainer-cli
  // output passes through `stream` directly (the masked secret pipeline
  // upstream of it doesn't add ANSI; timestamps + JSON are plain text).
  const sink = new Writable({
    write(chunk, _enc, cb): void {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stream.write(stripAnsi(text), cb);
    },
  });

  let closed = false;
  return {
    path: fullPath,
    stream,
    sink,
    close: () =>
      new Promise<void>((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        closed = true;
        sink.end(() => {
          stream.end(() => resolve());
        });
      }),
  };
}

/**
 * Wrap an apply logger so each `info/success/warn` call is also
 * appended to `sink` with a level prefix. Section markers stay on
 * screen only — they are structural for the terminal, the log file
 * gets its own header.
 */
export interface TeeableLogger {
  info: (msg: string) => void;
  success: (msg: string) => void;
  warn?: (msg: string) => void;
  section?: (label: string) => void;
}

export function teeApplyLogger<L extends TeeableLogger>(
  base: L,
  sink: Writable,
): L {
  const write = (level: string, msg: string): void => {
    sink.write(`[${level}] ${msg}\n`);
  };
  const wrapped: TeeableLogger = {
    info: (msg) => {
      base.info(msg);
      write('info', msg);
    },
    success: (msg) => {
      base.success(msg);
      write('ok', msg);
    },
    warn: (msg) => {
      (base.warn ?? base.info)(msg);
      write('warn', msg);
    },
  };
  if (base.section) wrapped.section = base.section.bind(base);
  return wrapped as L;
}
