import { spawnSync } from 'node:child_process';
import { cyan } from '../util/format.js';

/**
 * Windows-only preflight that gives an actionable message when Docker
 * Desktop's WSL 2 backend has no Linux distro to run.
 *
 * Symptom on the user side: Docker Desktop won't start (or its daemon
 * is unreachable) and — confusingly — reports "Virtualization support
 * not detected", even with virtualization enabled in BIOS and
 * `wsl --version` printing fine. The real cause is that the WSL
 * platform is installed but no WSL 2 distro is registered, so the
 * backend has no foundation. Without this preflight `monoceros` would
 * just bubble up a generic "docker daemon unreachable" failure that
 * never points at WSL.
 *
 * Mirrors the shape of bootstrapDockerGroup (Linux): probe cheaply,
 * speak up only in the precise broken state, stay silent otherwise.
 * Unlike the Linux helper there's nothing to re-exec — the best
 * recovery is a clear hint, so we print one to stderr and return.
 *
 * Order matters for cost: a registered WSL 2 distro is the common,
 * healthy case (Docker Desktop registers its own `docker-desktop`
 * v2 distro once its backend is up), so we check that first and
 * return without ever probing docker. Only when no WSL 2 distro
 * exists do we confirm docker is installed before warning.
 */

export interface BootstrapWslBackendOptions {
  /** Override platform detection. Tests inject 'win32'. */
  platform?: NodeJS.Platform;
  /** Probe a command for exit code. Tests inject deterministic results. */
  probe?: (cmd: string, args: readonly string[]) => number;
  /** Return raw `wsl -l -v` stdout, or null if the query failed. */
  wslDistros?: () => string | null;
  /** Sink for the hint. Defaults to stderr. Tests capture it. */
  warn?: (msg: string) => void;
}

export function bootstrapWslBackend(
  opts: BootstrapWslBackendOptions = {},
): void {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return;

  const listDistros = opts.wslDistros ?? defaultWslDistros;
  const raw = listDistros();
  // A registered WSL 2 distro means the backend has a foundation —
  // any healthy Docker Desktop install lands here (its `docker-desktop`
  // distro is v2) and we stay silent. `raw === null` means the wsl
  // query failed or WSL isn't installed at all → treat as no distro.
  if (raw !== null && hasWsl2Distro(raw)) return;

  // No WSL 2 distro. Only speak up if Docker is actually installed —
  // a missing docker has its own (installer) story, and we don't want
  // to nag users who aren't reaching for Docker yet.
  const probe = opts.probe ?? defaultProbe;
  if (probe('docker', ['--version']) !== 0) return;

  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
  warn(formatWslBackendHint());
}

/**
 * True iff `raw` (the stdout of `wsl -l -v`) lists at least one distro
 * on WSL version 2. Robust against the UTF-16LE encoding WSL uses by
 * default (strips NUL bytes) in case WSL_UTF8 wasn't honored.
 */
export function hasWsl2Distro(raw: string): boolean {
  // Strip NUL bytes: older WSL ignores WSL_UTF8 and emits UTF-16LE,
  // which read as UTF-8 is every-other-byte NUL.
  const text = raw.split(String.fromCharCode(0)).join('');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip the header row (`NAME  STATE  VERSION`).
    if (/\bNAME\b/i.test(trimmed) && /\bVERSION\b/i.test(trimmed)) continue;
    // Columns: [*] NAME STATE VERSION — the version is the last token.
    const tokens = trimmed.replace(/^\*\s*/, '').split(/\s+/);
    if (tokens[tokens.length - 1] === '2') return true;
  }
  return false;
}

/**
 * Builder-facing hint when Docker is unreachable and no WSL 2 distro
 * is registered. install.ps1 carries an equivalent message in
 * PowerShell (we can't share strings across runtimes without ceremony).
 */
export function formatWslBackendHint(): string {
  return [
    `Docker's daemon isn't reachable, and no WSL 2 distro is registered.`,
    `Docker Desktop runs on the WSL 2 backend, so without a distro it`,
    `can't start -- often shown as the misleading "Virtualization support`,
    `not detected" (even with virtualization enabled in BIOS).`,
    ``,
    `Fix it in an elevated PowerShell:`,
    ``,
    cyan(`  wsl --set-default-version 2`),
    cyan(`  wsl --update`),
    cyan(`  wsl --install -d Ubuntu`),
    ``,
    `Then reboot and start Docker Desktop.`,
  ].join('\n');
}

function defaultProbe(cmd: string, args: readonly string[]): number {
  const result = spawnSync(cmd, [...args], { stdio: 'ignore', timeout: 10000 });
  return result.status ?? 1;
}

function defaultWslDistros(): string | null {
  // WSL_UTF8 makes `wsl -l -v` emit UTF-8 instead of UTF-16LE (which
  // otherwise arrives riddled with NUL bytes). hasWsl2Distro strips
  // NULs anyway for older WSL builds that ignore the env var.
  const result = spawnSync('wsl', ['-l', '-v'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, WSL_UTF8: '1' },
    timeout: 5000,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout;
}
