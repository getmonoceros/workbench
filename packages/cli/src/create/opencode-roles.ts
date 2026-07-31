import { promises as fsp } from 'node:fs';
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
  if (!roles) return; // feature not in the yml → nothing to write

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
}

/**
 * Fill the template placeholders. Exported for the tests, which assert the
 * rendering rules rather than the prose.
 */
export function renderRoleTemplate(body: string, model: string): string {
  const out = body
    .replaceAll('{{PLANS_DIR_TILDE}}', PLANS_DIR_TILDE)
    .replaceAll('{{PLANS_DIR}}', PLANS_DIR);
  if (!model) {
    // Drop the whole line, including its newline: an agent without a `model`
    // runs on the session's model, which is what "unset" has to mean.
    return out.replace(/^\{\{MODEL_LINE\}\}\n/m, '');
  }
  return out.replace('{{MODEL_LINE}}', `model: ${model}`);
}
