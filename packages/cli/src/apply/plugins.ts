import type { FeatureEntry, PluginEntry } from '../config/schema.js';
import { loadFeatureManifestSummary } from '../init/manifest.js';
import {
  spawnDevcontainer,
  type DevcontainerSpawn,
} from '../devcontainer/cli.js';

/**
 * Agent plugins declared on a feature entry, installed into the container
 * after it is up.
 *
 * Monoceros does NOT write the agent's own settings file. It runs the agent's
 * CLI (`claude plugin marketplace add` / `claude plugin install`) inside the
 * container and lets it register and enable the plugin. The reason is a
 * naming trap: the key a marketplace is registered under is not chosen by
 * whoever declares it, it comes from the `name` in the marketplace's own
 * manifest. Writing `extraKnownMarketplaces` under a key of our choosing
 * registers the marketplace fine and then leaves every plugin disabled,
 * because `enabledPlugins` needs `plugin@<manifest name>` and we would have
 * to fetch the manifest to learn it. Both CLI commands are idempotent and
 * work without the agent being logged in, so they fit a build step. See ADR
 * 0053.
 */

/** One marketplace to register, resolved to what the container will see. */
export interface ResolvedPluginSource {
  /** Feature that declared it, for messages. */
  featureRef: string;
  /** The agent CLI that manages it (`claude`). */
  cli: string;
  /** HTTPS URL, or an absolute in-container path under the workspace. */
  source: string;
  /** Plugin names to install from it. */
  enable: readonly string[];
}

/**
 * Feature entries carrying `plugins:`, paired with the CLI that can act on
 * them. Throws when a feature declares plugins but its agent has no plugin
 * CLI in the catalog — including any third-party ref, which resolves to no
 * descriptor at all. Silently installing nothing would look like success.
 */
export function resolvePluginSources(
  features: readonly FeatureEntry[],
  containerName: string,
  componentsRoot?: string,
): ResolvedPluginSource[] {
  const out: ResolvedPluginSource[] = [];
  for (const feature of features) {
    const plugins = feature.plugins ?? [];
    if (plugins.length === 0) continue;
    const cli = loadFeatureManifestSummary(
      feature.ref,
      componentsRoot,
    )?.pluginCli;
    if (!cli) {
      throw new Error(
        `The feature ${feature.ref} does not host agent plugins, so \`plugins:\` on it would do nothing. ` +
          `Move the block to a feature whose agent reads plugins (today: claude), or remove it.`,
      );
    }
    for (const plugin of plugins) {
      out.push({
        featureRef: feature.ref,
        cli,
        source: pluginSource(plugin, containerName),
        enable: plugin.enable,
      });
    }
  }
  return out;
}

/**
 * What the agent CLI is handed inside the container: the URL as written, or
 * the workspace path made absolute. The schema guarantees exactly one of the
 * two, so the fallback is unreachable and exists only for the type.
 */
function pluginSource(plugin: PluginEntry, containerName: string): string {
  if (plugin.url !== undefined) return plugin.url;
  return `/workspaces/${containerName}/projects/${plugin.path}`;
}

/**
 * The plugin marketplaces that are fetched over https, in the shape the repo
 * credential pre-flight consumes. A private marketplace needs the same token
 * as a private repo — the agent CLI clones it with the container's git, off
 * the same mounted credential helper — so its host has to go through the same
 * provider resolution and the same "declare `provider:`" gate.
 */
export function pluginCredentialHosts(
  features: readonly FeatureEntry[],
): { url: string; provider?: 'github' | 'gitlab' | 'bitbucket' }[] {
  const out: { url: string; provider?: 'github' | 'gitlab' | 'bitbucket' }[] =
    [];
  for (const feature of features) {
    for (const plugin of feature.plugins ?? []) {
      if (plugin.url === undefined) continue;
      out.push({
        url: plugin.url,
        ...(plugin.provider ? { provider: plugin.provider } : {}),
      });
    }
  }
  return out;
}

export interface InstallPluginsOptions {
  /** Materialized container dir (the devcontainer workspace folder). */
  root: string;
  sources: readonly ResolvedPluginSource[];
  logSink?: NodeJS.WritableStream;
  silent?: boolean;
  spawn?: DevcontainerSpawn;
}

/** What went wrong, per marketplace or plugin, for one summary warning. */
export interface InstallPluginsResult {
  installed: string[];
  failures: string[];
}

/**
 * Register each marketplace and install the plugins named on it, inside the
 * running container.
 *
 * Best-effort: a marketplace that cannot be reached, or a plugin name that
 * does not exist in it, is reported and does not fail the apply. The
 * workbench itself is sound at this point — the container is up, the agent is
 * installed, the repos are cloned — and taking all of that down over a plugin
 * would be the worse trade. The warning names what is missing and the builder
 * can re-run apply once the cause is fixed.
 */
export async function installPlugins(
  opts: InstallPluginsOptions,
): Promise<InstallPluginsResult> {
  const spawnFn = opts.spawn ?? spawnDevcontainer;
  const installed: string[] = [];
  const failures: string[] = [];

  const exec = (command: readonly string[]): Promise<number> =>
    spawnFn(
      [
        'exec',
        '--workspace-folder',
        opts.root,
        '--mount-workspace-git-root=false',
        '--',
        ...command,
      ],
      opts.root,
      {
        ...(opts.logSink ? { logSink: opts.logSink } : {}),
        ...(opts.silent ? { quiet: true } : {}),
      },
    );

  for (const source of opts.sources) {
    const addCode = await exec([
      source.cli,
      'plugin',
      'marketplace',
      'add',
      source.source,
    ]);
    if (addCode !== 0) {
      // Every plugin of this marketplace is out — naming them one by one
      // would repeat the same cause N times.
      failures.push(
        `${source.source} could not be registered (exit ${addCode}); ${source.enable.join(', ')} not installed`,
      );
      continue;
    }
    for (const name of source.enable) {
      const installCode = await exec([source.cli, 'plugin', 'install', name]);
      if (installCode === 0) {
        installed.push(name);
      } else {
        failures.push(
          `${name} could not be installed from ${source.source} (exit ${installCode})`,
        );
      }
    }
  }
  return { installed, failures };
}
