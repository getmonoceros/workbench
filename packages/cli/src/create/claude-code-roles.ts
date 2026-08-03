import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import { matchMonocerosFeature } from '../util/ref.js';
import { workbenchRoot } from '../config/paths.js';
import type { CreateOptions } from './types.js';

/**
 * Materialize the `claude-code-roles` feature: three Claude Code subagents
 * that split a task (plan → implement → review), the three skills that drive
 * them, and the hook script that holds their permissions.
 *
 * The sibling of `opencode-roles` (ADR 0043), copied rather than shared: the
 * two drift in the details, and a template that has to satisfy both makes
 * both awkward.
 *
 * Written at APPLY, not by the feature's install.sh, for the same reason as
 * every other agent config: `~/.claude` is a persistent-home bind mount owned
 * by the `claude-code` feature (ADR 0020), so anything a layer put there is
 * shadowed the moment the container starts (ADR 0018).
 *
 * Three structural differences to the OpenCode side, each forced by Claude
 * Code rather than chosen (ADR 0044):
 *
 *   - **The session leads, never a subagent.** Claude Code withholds
 *     `AskUserQuestion` from every subagent, so the planner's phase 0 cannot
 *     run inside one. `/monoceros-plan` asks in the session and delegates only
 *     the writing. That also keeps implement and review at depth 1, so the
 *     chain does not depend on the subagent nesting limit.
 *   - **Permissions come from a hook, not from frontmatter.** Claude Code has
 *     no per-tool glob rules, and `permissionMode` is ignored outright when
 *     the session runs in Auto Mode, which is the `claude-code` feature's own
 *     default. A PreToolUse `deny` is honoured in every mode, so `guard.mjs`
 *     is the only layer that holds.
 *   - **Skills, not commands.** Claude Code merged custom commands into
 *     skills, so each one is a `SKILL.md` in its own directory.
 *
 * Placeholders filled here:
 *
 *   - `{{MODEL_LINE}}` — the agent's `model:` frontmatter line, or nothing.
 *     Empty means Claude Code's own default, which is `inherit`: the role runs
 *     on whatever the session runs on. Deliberately no baked-in defaults,
 *     model ids age faster than releases.
 *   - `{{EFFORT_LINE}}` — the agent's `effort:` line, or nothing. Empty means
 *     the role inherits the session's effort, which is what Claude Code does
 *     without the field. Same no-default reasoning as the model.
 *   - `{{PLANS_DIR}}` / `{{PLANS_DIR_TILDE}}` — where plans are written, under
 *     the persisted `~/.claude`, so a plan survives an apply and survives
 *     wiping `projects/`.
 *   - `{{GUARD}}` — the absolute path of the hook script, as the agents spell
 *     it in their `command:` lines.
 */

/** Container-side home of the workspace user; everything hangs off it. */
const CONTAINER_HOME = '/home/node';
const PLANS_DIR = `${CONTAINER_HOME}/.claude/plans`;
const PLANS_DIR_TILDE = '~/.claude/plans';
const GUARD = `${CONTAINER_HOME}/.claude/monoceros-roles/guard.mjs`;

const AGENTS = [
  'monoceros-planner',
  'monoceros-implement',
  'monoceros-review',
] as const;
const SKILLS = [
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

/** Which option supplies each agent's effort level. Same shape as the models. */
const EFFORT_OPTION: Record<(typeof AGENTS)[number], string> = {
  'monoceros-planner': 'plannerEffort',
  'monoceros-implement': 'implementEffort',
  'monoceros-review': 'reviewEffort',
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

export async function writeClaudeCodeRoles(
  targetDir: string,
  features: CreateOptions['features'],
): Promise<void> {
  const roles = featureOptions(features, 'claude-code-roles');
  if (!roles) return; // feature not in the yml → nothing to write

  if (!featureOptions(features, 'claude-code')) {
    consola.warn(
      '[claude-code-roles] the `claude-code` feature is not in this container, so the agents and skills have nothing to run in. Add it with `monoceros add-feature <name> claude-code`.',
    );
  }

  const templates = path.join(
    workbenchRoot(),
    'templates',
    'claude-code-roles',
  );
  const claudeDir = path.join(targetDir, 'home', '.claude');

  // Agents: one flat file each, under ~/.claude/agents/.
  const agentsDir = path.join(claudeDir, 'agents');
  await fsp.mkdir(agentsDir, { recursive: true });
  for (const name of AGENTS) {
    const body = await readTemplate(
      path.join(templates, 'agents', `${name}.md`),
    );
    if (body === undefined) continue;
    await fsp.writeFile(
      path.join(agentsDir, `${name}.md`),
      renderRoleTemplate(
        body,
        str(roles, MODEL_OPTION[name]),
        str(roles, EFFORT_OPTION[name]),
      ),
    );
  }

  // Skills: a directory each, with the body as SKILL.md. That is the shape
  // Claude Code wants; a flat `.md` would also work as a legacy command file,
  // but only the directory form can carry supporting files later.
  for (const name of SKILLS) {
    const body = await readTemplate(
      path.join(templates, 'skills', `${name}.md`),
    );
    if (body === undefined) continue;
    const outDir = path.join(claudeDir, 'skills', name);
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.writeFile(
      path.join(outDir, 'SKILL.md'),
      renderRoleTemplate(body, ''),
    );
  }

  // The hook script. Invoked as `node <path> <role>`, so the executable bit
  // does not matter - which is just as well, because it would not survive
  // every host filesystem the container tree lives on.
  const guard = await readTemplate(path.join(templates, 'guard.mjs'));
  if (guard !== undefined) {
    const outDir = path.join(claudeDir, 'monoceros-roles');
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.writeFile(
      path.join(outDir, 'guard.mjs'),
      renderRoleTemplate(guard, ''),
    );
  }
}

/**
 * Read a template, or warn and return undefined. A missing template is a
 * broken CLI bundle, not a user error: say which file and carry on with the
 * rest rather than failing the apply.
 */
async function readTemplate(file: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    consola.warn(`[claude-code-roles] template missing: ${file}`);
    return undefined;
  }
}

/**
 * Fill the template placeholders. Exported for the tests, which assert the
 * rendering rules rather than the prose.
 */
export function renderRoleTemplate(
  body: string,
  model: string,
  effort = '',
): string {
  const out = body
    .replaceAll('{{PLANS_DIR_TILDE}}', PLANS_DIR_TILDE)
    .replaceAll('{{PLANS_DIR}}', PLANS_DIR)
    .replaceAll('{{GUARD}}', GUARD);
  return fillLine(
    fillLine(out, 'MODEL_LINE', model && `model: ${model}`),
    'EFFORT_LINE',
    effort && `effort: ${effort}`,
  );
}

/**
 * Replace a `{{NAME}}` placeholder line with `value`, or drop the line
 * entirely when there is no value. Dropping matters: an agent without a
 * `model` defaults to `inherit` and one without an `effort` inherits the
 * session's, which is what "unset" has to mean. An empty `model:` is not the
 * same thing and would be a parse error.
 */
function fillLine(body: string, name: string, value: string): string {
  if (!value)
    return body.replace(new RegExp(`^\\{\\{${name}\\}\\}\\n`, 'm'), '');
  return body.replace(`{{${name}}}`, value);
}
