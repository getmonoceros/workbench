import { readFileSync } from 'node:fs';

/**
 * Whether the "host" we're running on is a WSL distro — a headless Linux with
 * no browser and no clipboard of its own (e.g. Monoceros's managed distro on
 * Windows). The browser and clipboard the user actually sees are Windows', so
 * the host-side bridges have to reach them through interop.
 */
export function isWslHost(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== 'linux') return false;
  if (env['WSL_DISTRO_NAME']) return true;
  try {
    return readFileSync('/proc/sys/kernel/osrelease', 'utf8')
      .toLowerCase()
      .includes('microsoft');
  } catch {
    return false;
  }
}

/**
 * Whether this is Monoceros's own managed WSL distro - the one install.ps1
 * imports on Windows, sitting behind the Windows shim. Any other WSL distro is
 * a Linux the builder set up themselves and updates with the sh installer;
 * pointing THOSE at install.ps1 would import a second, managed distro next to
 * theirs instead of updating anything. A distro renamed via the installer's
 * `-DistroName` reads as unmanaged here - a deliberate false negative, because
 * the wrong answer in that direction only costs a stale shim.
 */
export function isManagedWslDistro(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isWslHost(platform, env)) return false;
  return (env['WSL_DISTRO_NAME'] ?? '').toLowerCase() === 'monoceros';
}
