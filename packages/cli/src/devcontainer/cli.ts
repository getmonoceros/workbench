import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

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
}

export type DevcontainerSpawn = (
  args: string[],
  cwd: string,
  options?: DevcontainerSpawnOptions,
) => Promise<number>;

// Default spawn implementation: runs the @devcontainers/cli binary
// directly. Stdio is inherited by default; pass { quiet: true } to
// suppress output on success.
export const spawnDevcontainer: DevcontainerSpawn = (
  args,
  cwd,
  options = {},
) => {
  const binPath = devcontainerCliPath();
  return new Promise((resolve, reject) => {
    if (options.quiet) {
      const child = spawn(process.execPath, [binPath, ...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      child.on('error', reject);
      child.on('exit', (code) => {
        const exitCode = code ?? 0;
        if (exitCode !== 0) {
          process.stderr.write(Buffer.concat(stderrChunks));
          process.stderr.write(Buffer.concat(stdoutChunks));
        }
        resolve(exitCode);
      });
      return;
    }
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
};
