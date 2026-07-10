import { spawn } from 'node:child_process';
import os from 'node:os';
import { isWsl } from './ssh-attach.js';

/**
 * Windows/WSL networking for `monoceros share`.
 *
 * On Windows the CLI runs inside a WSL distro and the app/terminator run in
 * docker there. In WSL2's default NAT mode the distro has its own subnet
 * (e.g. `172.x`), which is:
 *   - the wrong thing to advertise (a phone on the LAN can't reach `172.x`), and
 *   - not reachable at all from other devices - a `0.0.0.0` bind in the distro
 *     only lives on the WSL NAT network.
 *
 * The supported fix is WSL **mirrored networking** (`.wslconfig`
 * `networkingMode=mirrored`, Windows 11 22H2+): the distro then shares the
 * Windows host's interfaces, so a `0.0.0.0` bind is reachable on the real LAN
 * IP and that IP is visible from inside WSL. We detect the situation and, in
 * NAT mode, tell the user how to switch - rather than printing a dead URL.
 */

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function capture(
  cmd: string,
  args: readonly string[],
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn(cmd, args as string[], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.on('error', () => resolve({ stdout: '', code: -1 }));
    child.on('exit', (code) => resolve({ stdout, code: code ?? -1 }));
  });
}

/**
 * The Windows host's primary LAN IPv4 (the up interface that owns the default
 * route), queried from inside WSL via `powershell.exe`. `null` when it can't be
 * determined or we're not on WSL.
 */
export async function windowsLanIpv4(): Promise<string | null> {
  if (!isWsl()) return null;
  const psScript =
    "(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq 'Up' } | " +
    'Select-Object -First 1 -ExpandProperty IPv4Address).IPAddress';
  const r = await capture('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    psScript,
  ]);
  const ip = r.stdout.replace(/\r/g, '').trim().split(/\s+/)[0] ?? '';
  return IPV4_RE.test(ip) ? ip : null;
}

/** Does WSL currently see this IP on one of its own interfaces? */
function localInterfacesInclude(ip: string): boolean {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && addr.address === ip) return true;
    }
  }
  return false;
}

export interface WslLanTarget {
  /** The Windows LAN IPv4 to advertise + cover in the cert, if resolvable. */
  lanIp: string | null;
  /**
   * True when the Windows LAN IP is visible from inside WSL - i.e. mirrored
   * networking is active and `0.0.0.0` binds are reachable on the LAN. False
   * in NAT mode, where the port is not LAN-reachable without switching.
   */
  mirrored: boolean;
}

/**
 * Resolve how `share` should present itself on Windows/WSL: the real LAN IP and
 * whether the port is actually reachable there (mirrored) or not (NAT).
 */
export async function wslLanTarget(): Promise<WslLanTarget> {
  const lanIp = await windowsLanIpv4();
  return {
    lanIp,
    mirrored: lanIp !== null && localInterfacesInclude(lanIp),
  };
}
