import { PassThrough } from 'node:stream';
import { REPO_DOCS_URL } from '../config/schema.js';
import type { FeatureEntry, PluginEntry } from '../config/schema.js';
import { loadFeatureManifestSummary } from '../init/manifest.js';
import {
  spawnDevcontainer,
  type DevcontainerSpawn,
} from '../devcontainer/cli.js';
import { bold, cyan, stripAnsi, warnHeading, yellow } from '../util/format.js';

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

/** One thing that did not work, with the reason it did not. */
export interface PluginFailure {
  /** What was attempted, in the builder's words. */
  what: string;
  /** The line(s) from the agent CLI that say why. Never an exit code alone. */
  cause: string;
  /** What to do about it, when the cause is one we recognise. */
  hint?: string;
}

export interface InstallPluginsResult {
  installed: string[];
  failures: PluginFailure[];
}

/**
 * Lines the agent CLI prints that carry no information: its own spinner
 * labels, and the progress noise git writes to stderr on the way to the real
 * error. Dropping them is what turns a wall of output into one readable
 * cause.
 */
const NOISE = [
  /^Adding marketplace/i,
  /^Installing plugin/i,
  /^Cloning into /i,
  /^remote:/i,
  /^Receiving objects/i,
  /^Resolving deltas/i,
];

/**
 * Turn the agent CLI's output into the reason a step failed.
 *
 * An exit code is not a reason. `git` puts the actual cause on its own line
 * (`fatal: …`) and the agent wraps it in a line of its own (`✘ Failed to add
 * marketplace: …`), so both are worth keeping and everything between them is
 * not. When nothing recognisable is left, the last line of output beats a
 * number.
 */
export function describePluginFailure(
  output: string,
  exitCode: number,
): { cause: string; hint?: string } {
  const lines = stripAnsi(output)
    .split('\n')
    .map((l) => l.replace(/[\r…]+$/, '').trim())
    .filter((l) => l.length > 0)
    .filter((l) => !NOISE.some((re) => re.test(l)));

  const decorated = lines.map((l) =>
    l
      .replace(/^[✘✖x!]\s*/u, '')
      // git's clone progress gets concatenated onto the agent's error line;
      // the temp checkout path is never the reason for anything.
      .replace(/:?\s*Cloning into '[^']*'\.*$/, '')
      .replace(/[\s:]+$/, '')
      .trim(),
  );
  const fatal = decorated.find((l) => /^(fatal|error):/i.test(l));
  const failed = decorated.find((l) => /^Failed to /i.test(l));
  const picked = [failed, fatal].filter(
    (l, i, all): l is string => Boolean(l) && all.indexOf(l) === i,
  );

  const cause =
    picked.length > 0
      ? picked.join(' / ')
      : (decorated.at(-1) ?? `the command exited ${exitCode} without output`);

  // The one cause worth naming a fix for: git had no credentials and, in a
  // container, no one to ask. Every spelling git and its helpers use for it.
  const authFailed =
    /unable to get password|could not read (Username|Password)|Authentication failed|terminal prompts disabled|Permission denied \(publickey\)|remote: (Invalid username|Repository not found)/i.test(
      stripAnsi(output),
    );
  return {
    cause,
    ...(authFailed
      ? {
          hint: 'Most often a private marketplace whose token is missing: set it in\n   the env file, same as for a private repo.',
        }
      : {}),
  };
}

/**
 * Render the failures as an end-of-apply warning block, in the vocabulary the
 * repo-access, failed-clone and feature-note blocks already use: `⚠` heading
 * in bold yellow, a yellow lead-in, bullets, then what it means. A builder
 * should not have to learn a fourth way of being told "nothing is broken, but
 * look at this".
 */
export function formatPluginFailures(
  failures: readonly PluginFailure[],
  containerName: string,
): string {
  const lines: string[] = [
    ...warnHeading('Agent plugins not installed'),
    yellow('   Declared in the yml, but not in the container:'),
  ];
  for (const failure of failures) {
    lines.push(`     • ${failure.what}`);
    lines.push(`       ${failure.cause}`);
  }
  const hints = [...new Set(failures.map((f) => f.hint).filter(Boolean))];
  lines.push('', bold('   The container is up; only the plugins are missing.'));
  for (const hint of hints) lines.push(`   ${hint}`);
  lines.push(
    `   Fix the cause, then re-apply: ${cyan(`monoceros apply ${containerName}`)}`,
    '',
    // Same footer as the repo-access block: a private marketplace is
    // authenticated exactly like a private repo, so it is the same page.
    `   Details: ${cyan(REPO_DOCS_URL)}`,
  );
  return lines.join('\n');
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
  const failures: PluginFailure[] = [];

  // The agent CLI's output is captured rather than streamed: on success it is
  // chatter, and on failure the builder is better served by the one line that
  // says why than by the whole transcript. The full text still reaches the
  // apply log through `logSink`.
  const exec = async (
    command: readonly string[],
  ): Promise<{ code: number; output: string }> => {
    const captured = new PassThrough();
    const chunks: Buffer[] = [];
    captured.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    const code = await spawnFn(
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
        progressSink: captured,
        silent: true,
      },
    );
    return { code, output: Buffer.concat(chunks).toString('utf8') };
  };

  for (const source of opts.sources) {
    const add = await exec([
      source.cli,
      'plugin',
      'marketplace',
      'add',
      source.source,
    ]);
    if (add.code !== 0) {
      // Every plugin of this marketplace is out — naming them one by one
      // would repeat the same cause N times.
      failures.push({
        what: `could not register ${source.source}, so ${source.enable.join(', ')} ${source.enable.length === 1 ? 'was' : 'were'} not installed`,
        ...describePluginFailure(add.output, add.code),
      });
      continue;
    }

    // `add` on a marketplace that is already on disk is a pure no-op: it does
    // not pull. Since ~/.claude survives a rebuild, that would freeze a
    // workbench on whatever the marketplace held the first time it was
    // registered, and no amount of re-applying would ever pick up a fix. So
    // when it was already there, refresh it and the plugins on top of it.
    const registered = marketplaceName(add.output);
    if (registered?.alreadyPresent) {
      const update = await exec([
        source.cli,
        'plugin',
        'marketplace',
        'update',
        registered.name,
      ]);
      if (update.code !== 0) {
        // Not fatal: the plugins that are there keep working, they are just
        // the older ones.
        failures.push({
          what: `could not refresh ${source.source}; ${source.enable.join(', ')} stayed at the version already in the container`,
          ...describePluginFailure(update.output, update.code),
        });
        continue;
      }
    }

    for (const name of source.enable) {
      const install = await exec([source.cli, 'plugin', 'install', name]);
      if (install.code !== 0) {
        failures.push({
          what: `could not install ${name} from ${source.source}`,
          ...describePluginFailure(install.output, install.code),
        });
        continue;
      }
      installed.push(name);
      // `install` on an already-installed plugin is also a no-op, so the
      // refreshed marketplace only reaches the agent through an explicit
      // update. Harmless when it is already current.
      if (registered?.alreadyPresent) {
        const update = await exec([source.cli, 'plugin', 'update', name]);
        if (update.code !== 0) {
          failures.push({
            what: `could not update ${name}; the version already in the container stayed`,
            ...describePluginFailure(update.output, update.code),
          });
        }
      }
    }
  }
  return { installed, failures };
}

/**
 * The marketplace name out of what `marketplace add` printed, plus whether it
 * was already on disk. The name is not ours to choose — it comes from the
 * marketplace's own manifest — and this is the one place it is stated in a
 * form we can read, which is why the refresh can be targeted at one
 * marketplace instead of updating every one the builder ever added.
 */
export function marketplaceName(
  output: string,
): { name: string; alreadyPresent: boolean } | undefined {
  const text = stripAnsi(output);
  const added = /Successfully added marketplace:\s*([^\s(]+)/.exec(text);
  if (added?.[1]) return { name: added[1], alreadyPresent: false };
  const present = /Marketplace ['"]([^'"]+)['"] already on disk/.exec(text);
  if (present?.[1]) return { name: present[1], alreadyPresent: true };
  return undefined;
}
