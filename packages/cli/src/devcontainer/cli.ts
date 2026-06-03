import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createSecretMaskStream, maskSecrets } from '../util/mask-secrets.js';
import {
  createRuntimePullHintStream,
  type PullHintState,
} from './runtime-pull-hint.js';

const require_ = createRequire(import.meta.url);

let cachedBinaryPath: string | null = null;

// Resolve the absolute path to the `@devcontainers/cli` JS entry point. We
// invoke it via `node <path>` rather than relying on a `.bin/` shim being on
// PATH, so the CLI works regardless of how the user installed the workbench.
export function devcontainerCliPath(): string {
  if (cachedBinaryPath) return cachedBinaryPath;
  const pkgJsonPath = require_.resolve('@devcontainers/cli/package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const binEntry =
    typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.devcontainer ?? '');
  if (!binEntry) {
    throw new Error('Could not resolve @devcontainers/cli bin entry.');
  }
  cachedBinaryPath = path.resolve(path.dirname(pkgJsonPath), binEntry);
  return cachedBinaryPath;
}

export interface DevcontainerSpawnOptions {
  // When true, capture stdout and stderr instead of inheriting them.
  // The buffered output is only flushed (to stderr) if the process exits
  // non-zero, so successful no-op invocations stay silent. Use this for
  // intermediate steps like the implicit `up` that `monoceros run` does
  // before `exec`; leave it unset for explicit lifecycle calls
  // (`monoceros start`) and for the final exec where the user expects to
  // see output.
  quiet?: boolean;
  // When true, hand the child process direct stdio. Pure `inherit` —
  // no piping, no secret masking, no buffering. Required for any
  // interactive use case (`monoceros shell`, the `exec` step of
  // `monoceros run`): bash detects a non-TTY stdin/stdout and exits
  // immediately, which makes a stdio-pipe approach a non-starter.
  // The build/log paths in apply and start still go through the
  // masked-pipe path, where there's no TTY at stake.
  interactive?: boolean;
  // Optional additional sink that receives a copy of the masked
  // stdout/stderr stream. Used by `apply` to mirror the live
  // devcontainer-cli output into a per-apply log file. The spawn
  // never ends this stream — the caller closes it after the apply
  // wraps up. See ADR 0013 and apply/apply-log.ts.
  logSink?: NodeJS.WritableStream;
  // Optional sink that receives the same masked stream as `logSink`.
  // Used by the spinner / phase detector. See apply/apply-progress.ts.
  progressSink?: NodeJS.WritableStream;
  // When true, do NOT pipe the masked stream to process.stdout/stderr.
  // The output is captured by `logSink` and/or `progressSink` instead.
  // Set in interactive apply mode where the spinner owns the terminal;
  // verbose / non-TTY mode leaves it false so output still streams live.
  silent?: boolean;
}

export type DevcontainerSpawn = (
  args: string[],
  cwd: string,
  options?: DevcontainerSpawnOptions,
) => Promise<number>;

// Default spawn implementation: runs the @devcontainers/cli binary
// directly. Both stdout and stderr are streamed through a secret
// masker (see util/mask-secrets.ts) so that feature options like
// Atlassian apiTokens or GitHub PATs do not leak verbatim to the
// terminal when devcontainer-cli logs the build args / feature
// option dumps. With `{ quiet: true }` output is buffered (and
// masked) and only flushed on a non-zero exit.
export const spawnDevcontainer: DevcontainerSpawn = (
  args,
  cwd,
  options = {},
) => {
  const binPath = devcontainerCliPath();
  return new Promise((resolve, reject) => {
    if (options.interactive) {
      // Direct inherit — required so the child binary sees a real
      // TTY on stdin/stdout/stderr. Secret masking is irrelevant
      // here (the builder is running an interactive command;
      // build-time option dumps don't fire on this path).
      const child = spawn(process.execPath, [binPath, ...args], {
        cwd,
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 0));
      return;
    }
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (options.quiet) {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      child.on('error', reject);
      child.on('exit', (code) => {
        const exitCode = code ?? 0;
        if (exitCode !== 0) {
          process.stderr.write(
            maskSecrets(Buffer.concat(stderrChunks).toString('utf8')),
          );
          process.stderr.write(
            maskSecrets(Buffer.concat(stdoutChunks).toString('utf8')),
          );
        }
        resolve(exitCode);
      });
      return;
    }
    // Shared so the "downloading runtime image…" hint fires once even
    // though devcontainer-cli may log the manifest line on either stream.
    const pullHint: PullHintState = { hinted: false };
    const stdoutPipe = child.stdout
      ?.pipe(createSecretMaskStream())
      .pipe(createRuntimePullHintStream(pullHint));
    const stderrPipe = child.stderr
      ?.pipe(createSecretMaskStream())
      .pipe(createRuntimePullHintStream(pullHint));
    // Live terminal echo — suppressed when the apply runs in
    // interactive mode (`silent: true`) and the spinner owns the
    // screen. Verbose / non-TTY apply paths leave silent off so the
    // raw stream still surfaces.
    if (!options.silent) {
      stdoutPipe?.pipe(process.stdout);
      stderrPipe?.pipe(process.stderr);
    }
    // Tee both masked streams into the apply log sink. `end: false`
    // so the caller (apply/index.ts) controls when the log file
    // closes — stdout and stderr both feed it, and the file should
    // outlive whichever ends first.
    if (options.logSink) {
      stdoutPipe?.pipe(options.logSink, { end: false });
      stderrPipe?.pipe(options.logSink, { end: false });
    }
    if (options.progressSink) {
      stdoutPipe?.pipe(options.progressSink, { end: false });
      stderrPipe?.pipe(options.progressSink, { end: false });
    }
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
};
