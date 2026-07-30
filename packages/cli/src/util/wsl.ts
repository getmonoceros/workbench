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
