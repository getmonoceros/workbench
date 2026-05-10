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

export type DevcontainerSpawn = (
  args: string[],
  cwd: string,
) => Promise<number>;

// Default spawn implementation: runs the @devcontainers/cli binary with
// stdio inherited so interactive shells and subcommand output flow through.
export const spawnDevcontainer: DevcontainerSpawn = (args, cwd) => {
  const binPath = devcontainerCliPath();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
};
