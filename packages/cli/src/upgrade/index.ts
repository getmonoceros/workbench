import { existsSync, promises as fs } from 'node:fs';
import { consola } from 'consola';
import {
  containerConfigPath,
  monocerosHome as defaultMonocerosHome,
} from '../config/paths.js';
import { compareRuntimeVersions } from '../create/catalog.js';
import {
  runApply,
  type RunApplyOptions,
  type RunApplyResult,
} from '../apply/index.js';

/**
 * `monoceros upgrade` — change the pinned runtime image version of a
 * container and re-apply. The image version is part of the container's
 * yml (ADR 0017); routine `apply` never bumps it, so this is the one
 * deliberate path that does.
 *
 *   monoceros upgrade <name>            → pin to the latest published version
 *   monoceros upgrade <name> <version>  → pin to an exact version
 *   monoceros upgrade --list            → list available versions, change nothing
 */

const RUNTIME_REPO = 'getmonoceros/monoceros-runtime';
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export type VersionFetcher = () => Promise<string[]>;

interface UpgradeLogger {
  info: (msg: string) => void;
  success: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface UpgradeOptions {
  /** Container/config name. Required unless `list` is set. */
  name?: string;
  /** Exact version to pin. Omitted → resolve the latest published version. */
  version?: string;
  /** List available versions and exit without changing anything. */
  list?: boolean;
  cliVersion: string;
  monocerosHome?: string;
  logger?: UpgradeLogger;
  /** Test seam: resolve the set of available versions (sorted, latest last). */
  fetchVersions?: VersionFetcher;
  /** Test seam: the apply runner (defaults to the real `runApply`). */
  applyRunner?: (opts: RunApplyOptions) => Promise<RunApplyResult>;
}

/**
 * List the published runtime image versions from GHCR. The image is
 * public, so no credentials are needed — but the OCI registry still
 * requires a bearer token, which GHCR hands out anonymously. Filtered
 * to exact `major.minor.patch` tags and sorted ascending (latest last).
 */
export async function fetchRuntimeVersions(): Promise<string[]> {
  const tokenUrl = `https://ghcr.io/token?service=ghcr.io&scope=repository:${RUNTIME_REPO}:pull`;
  const tokenRes = await fetch(tokenUrl);
  if (!tokenRes.ok) {
    throw new Error(
      `Could not get a GHCR token (HTTP ${tokenRes.status}). Pass an explicit version to skip the lookup: \`monoceros upgrade <name> <version>\`.`,
    );
  }
  const { token } = (await tokenRes.json()) as { token?: string };
  if (!token) throw new Error('GHCR token response contained no token.');
  const tagsRes = await fetch(`https://ghcr.io/v2/${RUNTIME_REPO}/tags/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!tagsRes.ok) {
    throw new Error(
      `Could not list runtime versions (HTTP ${tagsRes.status}). Pass an explicit version: \`monoceros upgrade <name> <version>\`.`,
    );
  }
  const { tags } = (await tagsRes.json()) as { tags?: string[] };
  return (tags ?? [])
    .filter((t) => VERSION_RE.test(t))
    .sort(compareRuntimeVersions);
}

/**
 * Set `runtimeVersion` in a yml document, preserving everything else.
 * Replaces an existing line, inserts after `schemaVersion:` when
 * absent, or prepends as a last resort. Pure — no I/O.
 */
export function setRuntimeVersion(yml: string, version: string): string {
  if (/^runtimeVersion:.*$/m.test(yml)) {
    return yml.replace(/^runtimeVersion:.*$/m, `runtimeVersion: ${version}`);
  }
  if (/^schemaVersion:.*$/m.test(yml)) {
    return yml.replace(
      /^(schemaVersion:.*)$/m,
      `$1\nruntimeVersion: ${version}`,
    );
  }
  return `runtimeVersion: ${version}\n${yml}`;
}

export async function runUpgrade(opts: UpgradeOptions): Promise<number> {
  const home = opts.monocerosHome ?? defaultMonocerosHome();
  const logger = opts.logger ?? consola;
  const fetchVersions = opts.fetchVersions ?? fetchRuntimeVersions;

  if (opts.list) {
    const versions = await fetchVersions();
    if (versions.length === 0) {
      logger.info('No published runtime versions found.');
      return 0;
    }
    logger.info(
      `Available runtime versions (latest last):\n  ${versions.join('\n  ')}`,
    );
    return 0;
  }

  if (!opts.name) {
    throw new Error(
      'Usage: `monoceros upgrade <name> [version]` (or `monoceros upgrade --list`).',
    );
  }

  const ymlPath = containerConfigPath(opts.name, home);
  if (!existsSync(ymlPath)) {
    throw new Error(
      `No such config: ${ymlPath}. Run \`monoceros init <template> ${opts.name}\` first.`,
    );
  }

  let target = opts.version;
  if (target !== undefined && !VERSION_RE.test(target)) {
    throw new Error(
      `Invalid version ${JSON.stringify(target)}. Expected an exact version like '1.1.0'.`,
    );
  }
  if (target === undefined) {
    const versions = await fetchVersions();
    target = versions[versions.length - 1];
    if (!target) {
      throw new Error('Could not determine the latest runtime version.');
    }
    logger.info(`Latest published runtime version: ${target}`);
  }

  const raw = await fs.readFile(ymlPath, 'utf8');
  const updated = setRuntimeVersion(raw, target);
  if (updated === raw) {
    logger.info(`'${opts.name}' is already pinned to runtime ${target}.`);
  } else {
    await fs.writeFile(ymlPath, updated);
    logger.success(`Pinned '${opts.name}' to runtime ${target}. Re-applying…`);
  }

  const apply = opts.applyRunner ?? runApply;
  const result = await apply({
    name: opts.name,
    cliVersion: opts.cliVersion,
    monocerosHome: home,
  });
  return result.containerExitCode;
}
