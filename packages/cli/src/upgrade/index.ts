import { existsSync, promises as fs } from 'node:fs';
import { consola } from 'consola';
import {
  containerConfigPath,
  containerConfigsDir,
  monocerosHome as defaultMonocerosHome,
} from '../config/paths.js';
import { markUpgraded } from '../config/machine-state.js';
import { compareRuntimeVersions } from '../create/catalog.js';
import { type DockerExec } from '../proxy/index.js';
import { pruneStaleImages } from './prune.js';
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
  /** Clock seam for the last-upgrade timestamp. */
  now?: Date;
  /** Test seam: resolve the set of available versions (sorted, latest last). */
  fetchVersions?: VersionFetcher;
  /** Test seam: the apply runner (defaults to the real `runApply`). */
  applyRunner?: (opts: RunApplyOptions) => Promise<RunApplyResult>;
  /** Test seam: docker exec used by the image prune. */
  dockerExec?: DockerExec;
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

  if (opts.version !== undefined) {
    if (!opts.name) {
      throw new Error(
        'A specific version can only be pinned for one container: `monoceros upgrade <name> <version>`.',
      );
    }
    if (!VERSION_RE.test(opts.version)) {
      throw new Error(
        `Invalid version ${JSON.stringify(opts.version)}. Expected an exact version like '1.1.0'.`,
      );
    }
  }

  if (opts.name && !existsSync(containerConfigPath(opts.name, home))) {
    throw new Error(
      `No such config: ${containerConfigPath(opts.name, home)}. Run \`monoceros init <template> ${opts.name}\` first.`,
    );
  }

  // `upgrade <name>` targets one container; bare `upgrade` is global —
  // refresh everything in use. Prune + the staleness timestamp are global
  // either way (ADR 0018).
  const targets = opts.name ? [opts.name] : await listContainerNames(home);
  const apply = opts.applyRunner ?? runApply;
  const now = opts.now ?? new Date();

  const finishGlobally = async (): Promise<void> => {
    await pruneStaleImages({
      home,
      currentContainerNames: new Set(await listContainerNames(home)),
      ...(opts.dockerExec ? { exec: opts.dockerExec } : {}),
      logger,
    });
    await markUpgraded(now.toISOString(), home);
  };

  if (targets.length === 0) {
    logger.info('No containers to upgrade.');
    await finishGlobally();
    return 0;
  }

  // The base version to pin: an explicit one (per-container only), else the
  // latest published. `setRuntimeVersion` only rewrites the yml when it
  // actually changes, so an already-latest base is left untouched ("only when
  // a newer version exists").
  let pinVersion = opts.version;
  if (pinVersion === undefined) {
    const versions = await fetchVersions();
    pinVersion = versions[versions.length - 1];
    if (!pinVersion) {
      throw new Error('Could not determine the latest runtime version.');
    }
    logger.info(`Latest published runtime version: ${pinVersion}`);
  }

  let worstExit = 0;
  for (const name of targets) {
    const ymlPath = containerConfigPath(name, home);
    if (!existsSync(ymlPath)) continue; // removed mid-run — skip
    const raw = await fs.readFile(ymlPath, 'utf8');
    const updated = setRuntimeVersion(raw, pinVersion);
    if (updated !== raw) {
      await fs.writeFile(ymlPath, updated);
      logger.info(`Pinned '${name}' to runtime ${pinVersion}.`);
    }
    logger.info(`Refreshing '${name}' (rebuild — latest tools)…`);
    const result = await apply({
      name,
      cliVersion: opts.cliVersion,
      monocerosHome: home,
      rebuild: true,
    });
    if (result.containerExitCode !== 0) {
      worstExit = result.containerExitCode;
      logger.warn?.(
        `Upgrade of '${name}' failed (exit ${result.containerExitCode}).`,
      );
    }
  }

  // Prune stale images + stamp the run only when every target succeeded, so a
  // failed refresh keeps nudging instead of looking done.
  if (worstExit === 0) {
    await finishGlobally();
    logger.success(
      opts.name
        ? `Upgraded '${opts.name}'.`
        : `Upgraded ${targets.length} container${targets.length === 1 ? '' : 's'}.`,
    );
  }
  return worstExit;
}

/** Container config names (`<name>.yml` → `<name>`) under the home. */
async function listContainerNames(home: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(containerConfigsDir(home));
    return entries
      .filter((e) => e.endsWith('.yml'))
      .map((e) => e.slice(0, -'.yml'.length));
  } catch {
    return [];
  }
}
