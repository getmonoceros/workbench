import { readEnvFile } from './env-file.js';
import { migrateGlobalYml } from './global-yml-migration.js';
import { DEFAULT_UPGRADE_STALE_DAYS } from './machine-state.js';
import { globalEnvPath, monocerosHome, prettyPath } from './paths.js';

/**
 * Machine-global settings, read from `<MONOCEROS_HOME>/monoceros-config.env`
 * (ADR 0061). One Traefik singleton and one upgrade nudge
 * per machine, so these live beside the shared secrets rather than in any
 * workbench yml. The file is optional; every setting has a default.
 *
 * The env and not a yml of its own: a second config file only for two
 * scalars was one more place to look, and no yml ever holds personal data.
 */

/** Default Traefik host port when `MONOCEROS_HOST_PORT` is unset. */
export const DEFAULT_PROXY_HOST_PORT = 80;

export const HOST_PORT_VAR = 'MONOCEROS_HOST_PORT';
export const UPGRADE_STALE_DAYS_VAR = 'MONOCEROS_UPGRADE_STALE_DAYS';

export interface MachineSettings {
  /** Host port the Traefik singleton binds (ADR 0007). */
  hostPort: number;
  /** Days after the last `monoceros upgrade` before apply nudges (ADR 0018). */
  upgradeStaleDays: number;
}

export interface ReadMachineSettingsOptions {
  /** Override of the user-data home. Tests inject a tmpdir. */
  monocerosHome?: string;
  /**
   * Where the one-time migration of a legacy `monoceros-config.yml` reports
   * what it did. The caller's logger, so the message lands in its output.
   */
  notify?: (message: string) => void;
}

/**
 * Read the machine-global settings. Migrates a legacy `monoceros-config.yml`
 * first, once, so a value the builder set there is not silently lost.
 *
 * Throws on a value that is set but not a number in range: the builder wrote
 * it on purpose, and falling back to the default would put the proxy on a
 * port they did not choose.
 */
export async function readMachineSettings(
  opts: ReadMachineSettingsOptions = {},
): Promise<MachineSettings> {
  const home = opts.monocerosHome ?? monocerosHome();
  const notice = await migrateGlobalYml(home);
  if (notice) (opts.notify ?? console.warn)(notice);

  const envPath = globalEnvPath(home);
  const env = readEnvFile(envPath);
  return {
    hostPort: intSetting(env, HOST_PORT_VAR, envPath, {
      fallback: DEFAULT_PROXY_HOST_PORT,
      min: 1,
      max: 65535,
    }),
    upgradeStaleDays: intSetting(env, UPGRADE_STALE_DAYS_VAR, envPath, {
      fallback: DEFAULT_UPGRADE_STALE_DAYS,
      min: 1,
    }),
  };
}

function intSetting(
  env: Record<string, string>,
  key: string,
  envPath: string,
  range: { fallback: number; min: number; max?: number },
): number {
  const raw = env[key]?.trim() ?? '';
  if (raw === '') return range.fallback;
  const value = Number(raw);
  const inRange =
    Number.isInteger(value) &&
    value >= range.min &&
    (range.max === undefined || value <= range.max);
  if (!inRange) {
    const bounds =
      range.max === undefined
        ? `a whole number from ${range.min}`
        : `a whole number from ${range.min} to ${range.max}`;
    throw new Error(
      `${key} in ${prettyPath(envPath)} must be ${bounds}, got "${raw}".`,
    );
  }
  return value;
}
