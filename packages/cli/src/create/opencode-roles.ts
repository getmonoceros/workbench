import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import { matchMonocerosFeature } from '../util/ref.js';
import { workbenchRoot } from '../config/paths.js';
import type { CreateOptions } from './types.js';

/**
 * Materialize the `opencode-roles` feature: three OpenCode agents that split a
 * task (plan → implement → review) plus the commands that drive them.
 *
 * Why this is written at APPLY and not by the feature's install.sh: the files
 * belong under `~/.config/opencode/`, and that directory is a persistent-home
 * bind mount owned by the `opencode` feature (ADR 0020). Anything a layer put
 * there is shadowed by the host-side directory the moment the container
 * starts, so the host side has to write it - the same reason `opencode.json`
 * is written here (ADR 0018).
 *
 * The markdown lives in `templates/opencode-roles/` and ships with the CLI,
 * so the prompts stay readable and diffable instead of hiding inside string
 * literals. Two placeholders are filled here:
 *
 *   - `{{MODEL_LINE}}` — the agent's `model:` frontmatter line, or nothing.
 *     Each role falls back to the `opencode` feature's own `model` option, and
 *     when that is empty too the line is dropped entirely and OpenCode uses
 *     whatever the session runs on. Deliberately no baked-in defaults: model
 *     ids age faster than releases.
 *   - `{{PLANS_DIR}}` / `{{PLANS_DIR_TILDE}}` — where plans are written.
 *     Inside OpenCode's own data directory, which the `opencode` feature
 *     persists, so a plan survives an apply and survives wiping `projects/`.
 *
 * Files are overwritten on every apply, and each one says so in a comment: a
 * project-level `.opencode/agents/<name>.md` wins over the global one, which
 * is the supported way to customise a role without fighting the next apply.
 */

/** Container-side home of the workspace user; the plans dir hangs off it. */
const CONTAINER_HOME = '/home/node';
const PLANS_DIR = `${CONTAINER_HOME}/.local/share/opencode/plans`;
const PLANS_DIR_TILDE = '~/.local/share/opencode/plans';
/**
 * The same directory as a permission pattern that matches BOTH spellings a
 * tool can produce. `edit` asks with the path relative to the worktree
 * (`path.relative(instance.worktree, filePath)` in edit.ts), and the plans
 * directory is outside the workspace - so the relative form starts with
 * `../../..`, which an absolute pattern can never match. That is not a
 * theoretical concern: it locked the planner out of its own plans directory
 * until the leading `*` was added. `external_directory` asks with the
 * canonical absolute path, so both forms have to be covered.
 */
const PLANS_MATCH = '*/.local/share/opencode/plans';

const AGENTS = [
  'monoceros-planner',
  'monoceros-implement',
  'monoceros-review',
] as const;
const COMMANDS = [
  'monoceros-plan',
  'monoceros-ship',
  'monoceros-review',
] as const;

/** Which option supplies each agent's model variant (OpenCode's word for
 *  reasoning effort). Unlike the model, this cannot go into the agent's
 *  frontmatter: OpenCode documents `variant` for the JSON config only, so it
 *  is merged into `opencode.json` further down. */
const EFFORT_OPTION: Record<(typeof AGENTS)[number], string> = {
  'monoceros-planner': 'plannerEffort',
  'monoceros-implement': 'implementEffort',
  'monoceros-review': 'reviewEffort',
};

/** Which option on the roles feature supplies each agent's model. */
const MODEL_OPTION: Record<(typeof AGENTS)[number], string> = {
  'monoceros-planner': 'plannerModel',
  'monoceros-implement': 'implementModel',
  'monoceros-review': 'reviewModel',
};

function featureOptions(
  features: CreateOptions['features'],
  name: string,
): Record<string, unknown> | undefined {
  if (!features) return undefined;
  const entry = Object.entries(features).find(
    ([ref]) => matchMonocerosFeature(ref)?.name === name,
  );
  return entry ? (entry[1] ?? {}) : undefined;
}

function str(
  options: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = options?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

export async function writeOpencodeRoles(
  targetDir: string,
  features: CreateOptions['features'],
): Promise<void> {
  const roles = featureOptions(features, 'opencode-roles');
  if (!roles) {
    // Absent from the yml, possibly still on disk: `~/.config/opencode` is a
    // persistent bind mount, so dropping the feature leaves every agent and
    // command in place and the roles keep working in a container that no longer
    // declares them. Removing the feature has to remove its files.
    await removeOpencodeRoles(targetDir);
    return;
  }

  const opencode = featureOptions(features, 'opencode');
  if (!opencode) {
    consola.warn(
      '[opencode-roles] the `opencode` feature is not in this container, so the agents and commands have nothing to run in. Add it with `monoceros add-feature <name> opencode`.',
    );
  }
  const fallbackModel = str(opencode, 'model');

  const templates = path.join(workbenchRoot(), 'templates', 'opencode-roles');
  const configDir = path.join(targetDir, 'home', '.config', 'opencode');

  for (const [kind, names] of [
    ['agents', AGENTS],
    ['commands', COMMANDS],
  ] as const) {
    const outDir = path.join(configDir, kind);
    // A role this CLI no longer ships has to go, and nothing else does it:
    // `~/.config/opencode` is a persistent bind mount, so an agent or command
    // from an older apply stays on disk and stays live forever.
    await pruneStaleEntries(
      outDir,
      names.map((name) => `${name}.md`),
    );
    await fsp.mkdir(outDir, { recursive: true });
    for (const name of names) {
      const src = path.join(templates, kind, `${name}.md`);
      let body: string;
      try {
        body = await fsp.readFile(src, 'utf8');
      } catch {
        // A missing template is a broken CLI bundle, not a user error - say
        // which file and carry on with the rest rather than failing the apply.
        consola.warn(`[opencode-roles] template missing: ${src}`);
        continue;
      }
      const model =
        kind === 'agents'
          ? str(roles, MODEL_OPTION[name as (typeof AGENTS)[number]]) ||
            fallbackModel
          : '';
      body = renderRoleTemplate(body, model);
      await fsp.writeFile(path.join(outDir, `${name}.md`), body);
    }
  }

  await writeAgentVariants(targetDir, roles);
}

/**
 * Take the feature's files out of the container tree, including the role
 * entries merged into `opencode.json`.
 *
 * Only what the feature owns. The same directories hold agents, commands and
 * plugins from elsewhere, so the `monoceros-` prefix decides rather than a
 * sweep of the directory. The prefix rather than the AGENTS/COMMANDS lists on
 * purpose: a role this CLI no longer ships still has to be cleaned up, and
 * only the prefix catches it.
 */
async function removeOpencodeRoles(targetDir: string): Promise<void> {
  const configDir = path.join(targetDir, 'home', '.config', 'opencode');
  for (const kind of ['agents', 'commands', 'plugin'] as const) {
    await removeNamespacedEntries(path.join(configDir, kind));
  }
  await removeAgentEntries(path.join(configDir, 'opencode.json'));
}

/**
 * Delete the `monoceros-*` entries in a directory that this CLI no longer
 * ships, keeping the ones it is about to write. The same directories hold
 * agents and commands from elsewhere, so the prefix decides what we may touch
 * and `keep` decides what survives.
 */
async function pruneStaleEntries(
  dir: string,
  keep: readonly string[],
): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith('monoceros-')) continue;
    if (keep.includes(entry)) continue;
    await fsp.rm(path.join(dir, entry), { recursive: true, force: true });
  }
}

/**
 * Delete every `monoceros-*` entry in a directory, file or directory alike.
 * A missing directory is the normal case (the feature was never applied here)
 * and stays missing: creating it would make the no-op case visible on disk.
 */
async function removeNamespacedEntries(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith('monoceros-')) continue;
    await fsp.rm(path.join(dir, entry), { recursive: true, force: true });
  }
}

/**
 * Drop the roles out of `opencode.json`'s `agent` block, the counterpart of
 * `writeAgentVariants`. Everything else in the file stays, including agents the
 * builder configured themselves; the file is only rewritten when something
 * actually went.
 */
async function removeAgentEntries(file: string): Promise<void> {
  if (!existsSync(file)) return;
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return;
    config = parsed as Record<string, unknown>;
  } catch {
    // Malformed opencode.json - leave it alone rather than clobbering a file
    // the builder may be in the middle of editing.
    return;
  }
  if (typeof config.agent !== 'object' || config.agent === null) return;
  const agents = config.agent as Record<string, unknown>;
  const stale = Object.keys(agents).filter((name) =>
    name.startsWith('monoceros-'),
  );
  if (stale.length === 0) return;
  for (const name of stale) delete agents[name];
  if (Object.keys(agents).length === 0) delete config.agent;
  await fsp.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Merge each role's variant into `opencode.json`'s `agent` block.
 *
 * Not the frontmatter: OpenCode's markdown agents document `description`,
 * `mode`, `model`, `temperature` and `permission`, and `variant` is not among
 * them - it lives in the JSON `AgentConfig`. Writing it into the markdown
 * would be a silent no-op, which is worse than not offering the option.
 *
 * The merge preserves everything else in the file (`writeOpencodeConfig` runs
 * before this and owns the model, the provider key and the instructions), and
 * it removes the key again when the option is cleared, so dropping a value
 * from the yml really drops it from the container.
 */
async function writeAgentVariants(
  targetDir: string,
  roles: Record<string, unknown>,
): Promise<void> {
  const file = path.join(
    targetDir,
    'home',
    '.config',
    'opencode',
    'opencode.json',
  );
  let config: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const txt = await fsp.readFile(file, 'utf8');
      if (txt.trim()) {
        const parsed: unknown = JSON.parse(txt);
        if (typeof parsed === 'object' && parsed !== null) {
          config = parsed as Record<string, unknown>;
        }
      }
    } catch {
      // Malformed opencode.json - leave it alone rather than clobbering a file
      // the builder may be in the middle of editing.
      return;
    }
  }

  const agents =
    typeof config.agent === 'object' && config.agent !== null
      ? (config.agent as Record<string, Record<string, unknown>>)
      : {};

  for (const name of AGENTS) {
    const variant = str(roles, EFFORT_OPTION[name]);
    const entry = agents[name] ?? {};
    if (variant) entry.variant = variant;
    else delete entry.variant;
    if (Object.keys(entry).length > 0) agents[name] = entry;
    else delete agents[name];
  }

  if (Object.keys(agents).length > 0) config.agent = agents;
  else delete config.agent;

  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Fill the template placeholders. Exported for the tests, which assert the
 * rendering rules rather than the prose.
 */
export function renderRoleTemplate(body: string, model: string): string {
  const out = body
    .replaceAll('{{PLANS_DIR_TILDE}}', PLANS_DIR_TILDE)
    .replaceAll('{{PLANS_MATCH}}', PLANS_MATCH)
    .replaceAll('{{PLANS_DIR}}', PLANS_DIR);
  if (!model) {
    // Drop the whole line, including its newline: an agent without a `model`
    // runs on the session's model, which is what "unset" has to mean.
    return out.replace(/^\{\{MODEL_LINE\}\}\n/m, '');
  }
  return out.replace('{{MODEL_LINE}}', `model: ${model}`);
}
