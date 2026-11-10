import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import { matchMonocerosFeature } from '../util/ref.js';
import { workbenchRoot } from '../config/paths.js';
import { mergeJson } from './copilot-settings.js';
import type { CreateOptions } from './types.js';

/**
 * Materialize the `agent-roles` feature: three roles that split a task
 * (planner → developer → reviewer), the three skills that drive them, and the
 * permission layer that holds each role to its job. Written for every coding
 * agent the workbench carries: Claude Code, OpenCode and Copilot.
 *
 * One control flow for all of them (ADR 0067): **the session leads, the roles
 * are subagents.** The skill runs in the session, asks the user there, and
 * delegates the writing, the implementing and the reviewing. That is the only
 * shape every agent supports, because a subagent cannot reach the user in
 * Claude Code and nothing documents that it can in the others.
 *
 * With one flow there is one text. The role bodies and the skills are shared
 * by all agents; what differs per agent is only the frontmatter (how a role
 * is declared and how its permissions are held) and where the files go:
 *
 *   - Claude Code: `~/.claude/agents/*.md`, `~/.claude/skills/<name>/SKILL.md`,
 *     permissions through `guard.mjs` as a PreToolUse hook.
 *   - OpenCode: `~/.config/opencode/agents/*.md`, the same skills under
 *     `~/.config/opencode/skills/`, plus a thin command per skill so they stay
 *     reachable as `/agent-roles-…`. Permissions through the same `guard.mjs`,
 *     run by a plugin in `~/.config/opencode/plugins/` since OpenCode has no
 *     hook command, with the coarse rules kept as glob permissions in the
 *     agent in case the plugin does not load.
 *   - Copilot: `~/.copilot/agents/*.agent.md`, `~/.copilot/skills/`, the
 *     same `guard.mjs` as an agent-scoped hook, and each role's effort in
 *     `~/.copilot/settings.json`.
 *
 * Every one of those directories is a persistent-home bind mount owned by the
 * agent's own feature (ADR 0020), so the files are written here at apply,
 * host-side, never by an install.sh (ADR 0018).
 *
 * The plans and the guard live in the workspace, under
 * `.monoceros/agent-roles/`: every agent can reach the workspace root without
 * extra permissions, a plan written in one agent can be shipped from another,
 * and wiping `projects/` leaves it alone.
 */

/** The feature's own name, which is also the prefix of everything it writes. */
const FEATURE = 'agent-roles';
const PREFIX = `${FEATURE}-`;

/** The guard plugin's file name in OpenCode's global plugins directory. */
const OPENCODE_PLUGIN = `${PREFIX}guard.js`;

/** The two features this one replaces. Still read, with a warning (ADR 0067). */
export const LEGACY_FEATURES = ['claude-code-roles', 'opencode-roles'] as const;

/**
 * Names the replaced features wrote. Removed on every apply, by name rather
 * than by a `monoceros-` prefix sweep: other things may carry that prefix.
 * The design role (ADR 0050) is among them, because a container that once
 * applied it still has it on disk.
 */
const LEGACY_AGENTS = [
  'monoceros-planner',
  'monoceros-implement',
  'monoceros-review',
  'monoceros-design',
  'monoceros-designer',
];
const LEGACY_SKILLS = [
  'monoceros-plan',
  'monoceros-ship',
  'monoceros-review',
  'monoceros-design',
];

export const ROLES = ['planner', 'developer', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];
const SKILLS = ['plan', 'ship', 'review'] as const;

export const AGENTS = ['claude-code', 'opencode', 'copilot'] as const;
export type Agent = (typeof AGENTS)[number];

const AGENT_LABEL: Record<Agent, string> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  copilot: 'Copilot',
};

/** The flat options the two replaced features had, per role. */
const LEGACY_MODEL_OPTION: Record<Role, string> = {
  planner: 'plannerModel',
  developer: 'implementModel',
  reviewer: 'reviewModel',
};
const LEGACY_EFFORT_OPTION: Record<Role, string> = {
  planner: 'plannerEffort',
  developer: 'implementEffort',
  reviewer: 'reviewEffort',
};

/** Model aliases Claude Code accepts, beyond a full `claude-…` id. */
export const CLAUDE_MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];
/** Effort levels Claude Code accepts. */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/**
 * Effort levels Copilot accepts (`--reasoning-effort`, Copilot CLI 1.0.107).
 * Which of them a model supports depends on the model.
 */
export const COPILOT_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** The feature's directory, plans and guard, as the container sees them. */
export function rolesDir(containerName: string): string {
  return `/workspaces/${containerName}/.monoceros/${FEATURE}`;
}

/** Where the plans are written, as the container sees it. */
export function plansDir(containerName: string): string {
  return `${rolesDir(containerName)}/plans`;
}

/**
 * Permission patterns that match the plans and the feature's directory in
 * both spellings an OpenCode tool can produce: `edit` asks with the path
 * relative to the worktree (`projects/<app>`), which starts with `../..` for
 * anything in the workspace root, and `external_directory` asks with the
 * absolute path. A leading `*` covers both.
 */
const ROLES_MATCH = `*/.monoceros/${FEATURE}`;
const PLANS_MATCH = `${ROLES_MATCH}/plans`;

/** Is `value` something Claude Code takes as a model? */
export function isClaudeModel(value: string): boolean {
  return CLAUDE_MODEL_ALIASES.includes(value) || value.startsWith('claude-');
}

/**
 * Is `value` an OpenCode model reference? Shape only: `provider/model-id`,
 * where the id may itself contain slashes (`openrouter/moonshotai/kimi-k3`).
 * Which ids exist is the provider's business.
 */
export function isOpencodeModel(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*\/\S+$/i.test(value);
}

/** The yml's `roles:` block: per role, per agent, model and effort. */
export type RolesBlock = NonNullable<CreateOptions['agentRoles']>;

export interface RoleSettings {
  model: string;
  /** Claude Code's `effort`, or OpenCode's model variant. Empty: not set. */
  effort: string;
}

/** What the yml says for one role in one agent, trimmed; empty when unset. */
function declared(
  roles: RolesBlock | undefined,
  role: Role,
  agent: Agent,
): RoleSettings {
  const entry = roles?.[role]?.[agent];
  return {
    model: (entry?.model ?? '').trim(),
    effort: (entry?.effort ?? '').trim(),
  };
}

/**
 * What one role runs on in one agent. Each agent is configured under its own
 * name in the `roles:` block, so nothing is guessed from the spelling of a
 * value. Unset means the session's model and effort, except in OpenCode: there
 * a role falls back to the `opencode` feature's own `model`, as the old
 * `opencode-roles` did, and takes a variant only together with a model of its
 * own, because a variant belongs to a model and an unknown one is a
 * model-resolution error rather than a no-op.
 */
export function roleSettings(
  roles: RolesBlock | undefined,
  role: Role,
  agent: Agent,
  opencodeFallbackModel = '',
): RoleSettings {
  const { model, effort } = declared(roles, role, agent);
  if (agent !== 'opencode') return { model, effort };
  return {
    model: model || opencodeFallbackModel,
    effort: model ? effort : '',
  };
}

/** The coding agents this workbench carries, by their feature. */
export function presentAgents(features: CreateOptions['features']): Agent[] {
  return AGENTS.filter((agent) => featureOptions(features, agent));
}

/**
 * The roles to work from: the `roles:` block of the `agent-roles` entry, or
 * the flat options of one of the two features it replaced, translated into
 * the same block (`claude-code-roles` under `claude-code`, `opencode-roles`
 * under `opencode`), so an older yml keeps working. `legacy` names the old
 * feature when one was used. Undefined when the workbench has none of them.
 */
export function resolveRoles(
  opts: Pick<CreateOptions, 'features' | 'agentRoles'>,
): { roles?: RolesBlock; legacy?: string } | undefined {
  if (featureOptions(opts.features, FEATURE)) {
    return opts.agentRoles ? { roles: opts.agentRoles } : {};
  }
  for (const legacy of LEGACY_FEATURES) {
    const options = featureOptions(opts.features, legacy);
    if (!options) continue;
    return { roles: legacyRolesBlock(legacy, options), legacy };
  }
  return undefined;
}

/**
 * One replaced feature's flat options as the `roles:` block, under the agent
 * that feature served. Fields that were not set are left out. Used by apply
 * for an older yml and by `add-feature agent-roles`, which writes this block
 * so switching over keeps the models and efforts the builder chose.
 */
export function legacyRolesBlock(
  legacy: (typeof LEGACY_FEATURES)[number],
  options: Record<string, unknown> | undefined,
): RolesBlock {
  const agent: Agent =
    legacy === 'claude-code-roles' ? 'claude-code' : 'opencode';
  const roles: RolesBlock = {};
  for (const role of ROLES) {
    const model = str(options, LEGACY_MODEL_OPTION[role]);
    const effort = str(options, LEGACY_EFFORT_OPTION[role]);
    if (!model && !effort) continue;
    roles[role] = {
      [agent]: { ...(model && { model }), ...(effort && { effort }) },
    };
  }
  return roles;
}

/** How an agent is spelled in the env names. */
const ENV_AGENT: Record<Agent, string> = {
  'claude-code': 'CLAUDE',
  opencode: 'OPENCODE',
  copilot: 'COPILOT',
};
export type RoleField = 'model' | 'effort';
const FIELDS: readonly RoleField[] = ['model', 'effort'];

/** One role's field in one agent as an env name: `AGENT_ROLES_CLAUDE_PLANNER_MODEL`. */
export function rolesEnvVar(
  agent: Agent,
  role: Role,
  field: RoleField,
): string {
  return `AGENT_ROLES_${ENV_AGENT[agent]}_${role.toUpperCase()}_${field.toUpperCase()}`;
}

/**
 * The `roles:` block `init` and `add-feature` write: every role for each
 * given agent, each field a `${VAR}` reference, the way a feature's
 * credential is written. Which models someone has depends on the person and
 * their plan, not on the project, so the value lives in the env, where the
 * shared `monoceros-config.env` can hold it for every workbench. A field
 * `carried` over from a replaced feature keeps its literal value.
 */
export function rolesRefBlock(
  agents: readonly Agent[],
  carried: RolesBlock = {},
): RolesBlock {
  const block: RolesBlock = {};
  for (const role of ROLES) {
    for (const agent of agents) {
      const kept = carried[role]?.[agent];
      const forRole = (block[role] ??= {});
      forRole[agent] = {
        model: kept?.model ?? `\${${rolesEnvVar(agent, role, 'model')}}`,
        effort: kept?.effort ?? `\${${rolesEnvVar(agent, role, 'effort')}}`,
      };
    }
  }
  return block;
}

/**
 * What `init`, `add-feature` and `apply` say when the workbench carries
 * agent-roles but no coding agent: the roles have nothing to run in, and
 * there are no role settings to ask for until an agent is added.
 */
export function noAgentHint(containerName: string): string {
  return (
    `[${FEATURE}] this workbench has no coding agent yet, so the roles have nothing to run in. ` +
    `Add one, and its role settings are written and asked for:\n` +
    `  monoceros add-feature ${containerName} claude\n` +
    `  monoceros add-feature ${containerName} opencode\n` +
    `  monoceros add-feature ${containerName} copilot`
  );
}

/** Whether these feature refs carry agent-roles without any coding agent. */
export function rolesWithoutAgent(refs: readonly string[]): boolean {
  const names = refs.map((ref) => matchMonocerosFeature(ref)?.name);
  return (
    names.includes(FEATURE) && !AGENTS.some((agent) => names.includes(agent))
  );
}

/** What the prompt says about one role variable, or undefined for any other. */
export function describeRolesEnvVar(name: string): string | undefined {
  for (const agent of AGENTS) {
    for (const role of ROLES) {
      for (const field of FIELDS) {
        if (rolesEnvVar(agent, role, field) !== name) continue;
        const what = `${field === 'model' ? 'Model' : 'Effort'} for the ${role} in ${AGENT_LABEL[agent]}`;
        const values =
          agent === 'claude-code'
            ? field === 'model'
              ? `${CLAUDE_MODEL_ALIASES.join(', ')} or a claude-… id`
              : CLAUDE_EFFORTS.join(', ')
            : agent === 'copilot'
              ? field === 'model'
                ? 'a Copilot model id'
                : COPILOT_EFFORTS.join(', ')
              : field === 'model'
                ? 'provider/model-id, e.g. openrouter/moonshotai/kimi-k3'
                : "the model's variant, only together with a model";
        return `${what}: ${values}. Empty runs it on the session's.`;
      }
    }
  }
  return undefined;
}

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const WHOLE_VAR_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** The `${VAR}` names the block references, in order, once each. */
export function rolesEnvRefs(roles: RolesBlock | null | undefined): string[] {
  const out = new Set<string>();
  for (const role of ROLES) {
    for (const agent of AGENTS) {
      for (const field of FIELDS) {
        const value = roles?.[role]?.[agent]?.[field];
        if (typeof value !== 'string') continue;
        for (const m of value.matchAll(VAR_RE)) out.add(m[1]!);
      }
    }
  }
  return [...out];
}

/**
 * Resolve the block's `${VAR}` references against the merged env at apply. A
 * reference that is missing or empty leaves the field unset, so the role runs
 * on the session's model, the same rule a feature option follows. `sources`
 * maps `role.agent.field` to the variable a value came from, so a bad value is
 * reported under the name the builder has to fix.
 */
export function interpolateRoles(
  roles: RolesBlock | undefined,
  env: Record<string, string>,
): { roles: RolesBlock | undefined; sources: Record<string, string> } {
  if (!roles) return { roles, sources: {} };
  const out: RolesBlock = {};
  const sources: Record<string, string> = {};
  for (const role of ROLES) {
    for (const agent of AGENTS) {
      const entry = roles[role]?.[agent];
      if (!entry) continue;
      const settings: { model?: string; effort?: string } = {};
      for (const field of FIELDS) {
        const raw = entry[field];
        if (typeof raw !== 'string') continue;
        let missing = false;
        const value = raw
          .replace(VAR_RE, (_m, name: string) => {
            const v = env[name];
            if (v === undefined) missing = true;
            return v ?? '';
          })
          .trim();
        if (missing || !value) continue;
        settings[field] = value;
        const whole = WHOLE_VAR_RE.exec(raw.trim());
        if (whole) sources[`${role}.${agent}.${field}`] = whole[1]!;
      }
      if (Object.keys(settings).length === 0) continue;
      (out[role] ??= {})[agent] = settings;
    }
  }
  return { roles: Object.keys(out).length > 0 ? out : undefined, sources };
}

/**
 * Validate the `roles:` block at APPLY, before anything is built.
 *
 * A role's model lands verbatim in an agent definition, and nothing between
 * the yml and the running agent looks at it. A real run had
 * `implementModel: "sonet"`: the subagent refused to start, the session picked
 * its own replacement, and the run finished on a model nobody had chosen.
 *
 * Each agent is checked in its own vocabulary: Claude Code's aliases and
 * levels are a closed set, OpenCode needs `provider/model-id`, Copilot's
 * levels are a closed set and its model names are not checked. A placeholder left from the commented example is
 * refused for every agent. An agent the workbench does not carry is not
 * checked; its lines are ignored at write time.
 */
export function validateAgentRoles(
  opts: Pick<CreateOptions, 'features' | 'agentRoles'>,
  sources: Record<string, string> = {},
): void {
  const resolved = resolveRoles(opts);
  if (!resolved?.roles) return;
  const label = resolved.legacy ?? FEATURE;
  const agents = presentAgents(opts.features);
  for (const role of ROLES) {
    for (const agent of agents) {
      const { model, effort } = declared(resolved.roles, role, agent);
      const where = `roles.${role}.${agent}`;
      // A value from the env is reported under its env name, since that is
      // where the builder has to fix it.
      const at = (field: RoleField): string =>
        sources[`${role}.${agent}.${field}`] ?? `${where}.${field}`;
      for (const [field, value] of [
        ['model', model],
        ['effort', effort],
      ] as const) {
        if (/[<>]/.test(value)) {
          throw new Error(
            `${label}: ${at(field)} is still the placeholder '${value}'. Fill it in, or comment the line out again.`,
          );
        }
      }
      if (agent === 'claude-code') {
        if (model && !isClaudeModel(model)) {
          throw new Error(
            `${label}: unknown Claude Code model '${model}' for ${at('model')}.` +
              `${suggest(model, CLAUDE_MODEL_ALIASES)}` +
              ` Use one of ${CLAUDE_MODEL_ALIASES.join(', ')}, or a full model id like 'claude-opus-5'.`,
          );
        }
        if (effort && !CLAUDE_EFFORTS.includes(effort)) {
          throw new Error(
            `${label}: unknown effort '${effort}' for ${at('effort')}.` +
              `${suggest(effort, CLAUDE_EFFORTS)}` +
              ` Use one of ${CLAUDE_EFFORTS.join(', ')}.`,
          );
        }
      }
      if (agent === 'opencode') {
        if (model && !isOpencodeModel(model)) {
          throw new Error(
            `${label}: '${model}' for ${at('model')} is not a 'provider/model-id' reference.` +
              ` Write it the way OpenCode does, e.g. 'anthropic/claude-sonnet-5' or 'openrouter/moonshotai/kimi-k3'.`,
          );
        }
        if (effort && !model) {
          throw new Error(
            `${label}: ${at('effort')} sets an effort for the OpenCode ${role}, but no model. In OpenCode the effort is a variant of the model next to it, so set the model as well.`,
          );
        }
      }
      if (agent === 'copilot' && effort && !COPILOT_EFFORTS.includes(effort)) {
        throw new Error(
          `${label}: unknown effort '${effort}' for ${at('effort')}.` +
            `${suggest(effort, COPILOT_EFFORTS)}` +
            ` Use one of ${COPILOT_EFFORTS.join(', ')}.`,
        );
      }
    }
  }
}

export async function writeAgentRoles(
  targetDir: string,
  containerName: string,
  opts: Pick<CreateOptions, 'features' | 'agentRoles'>,
): Promise<void> {
  const resolved = resolveRoles(opts);
  const agents = resolved ? presentAgents(opts.features) : [];

  // The replaced features' files go in every case: with agent-roles they are
  // duplicates under old names, without it they are leftovers that stay live
  // in a persistent home until something deletes them.
  for (const agent of AGENTS) await removeLegacyFiles(targetDir, agent);
  await fsp.rm(path.join(targetDir, 'home', '.claude', 'monoceros-roles'), {
    recursive: true,
    force: true,
  });

  // An agent that is absent, or every agent when the feature is: its role
  // files go. Absent from the yml, possibly still on disk, because each of
  // these trees is a persistent bind mount.
  for (const agent of AGENTS) {
    if (!agents.includes(agent)) await removeAgentFiles(targetDir, agent);
  }
  if (!resolved) {
    // The guard goes with the feature; the plans stay. They are the builder's
    // work, not ours to delete.
    await fsp.rm(path.join(targetDir, '.monoceros', FEATURE, 'guard.mjs'), {
      force: true,
    });
    return;
  }

  // Adding first matters: `add-feature agent-roles` carries the old entry's
  // models and efforts over, and it can only read them while it is there.
  if (resolved.legacy) {
    consola.warn(
      `[${FEATURE}] '${resolved.legacy}' is replaced by '${FEATURE}', which serves every coding agent in the workbench. ` +
        `The roles are written from '${resolved.legacy}' for now, under their new names (/agent-roles-plan, /agent-roles-ship, /agent-roles-review). Switch over with:\n` +
        `  monoceros add-feature ${containerName} ${FEATURE}\n` +
        `  monoceros remove-feature ${containerName} ${resolved.legacy}`,
    );
  } else {
    // Halfway through that switch: the new entry is in, the old one is still
    // read by nothing but sits in the yml.
    for (const legacy of LEGACY_FEATURES) {
      if (!featureOptions(opts.features, legacy)) continue;
      consola.warn(
        `[${FEATURE}] '${legacy}' is no longer used next to '${FEATURE}'. Remove it with:\n` +
          `  monoceros remove-feature ${containerName} ${legacy}`,
      );
    }
  }
  if (agents.length === 0) {
    consola.warn(noAgentHint(containerName));
    return;
  }

  const templates = path.join(workbenchRoot(), 'templates', FEATURE);
  const vars = templateVars(containerName);

  // The feature's own directory in the workspace: the plans folder, so the
  // first `find` over it does not fail, and the guard.
  await fsp.mkdir(path.join(targetDir, '.monoceros', FEATURE, 'plans'), {
    recursive: true,
  });
  const guard = await readTemplate(path.join(templates, 'guard.mjs'));
  if (guard !== undefined) {
    await fsp.writeFile(
      path.join(targetDir, '.monoceros', FEATURE, 'guard.mjs'),
      render(guard, vars),
    );
  }

  const opencodeFallback = str(
    featureOptions(opts.features, 'opencode'),
    'model',
  );
  reportIgnoredSettings(resolved.roles, agents);

  for (const agent of agents) {
    const layout = agentLayout(targetDir, agent);

    await pruneStale(
      layout.agentsDir,
      ROLES.map((role) => `${PREFIX}${role}${layout.agentSuffix}`),
    );
    await fsp.mkdir(layout.agentsDir, { recursive: true });
    for (const role of ROLES) {
      const front = await readTemplate(
        path.join(templates, 'frontmatter', agent, `${role}.yml`),
      );
      const body = await readTemplate(
        path.join(templates, 'roles', `${role}.md`),
      );
      if (front === undefined || body === undefined) continue;
      const settings = roleSettings(
        resolved.roles,
        role,
        agent,
        opencodeFallback,
      );
      await fsp.writeFile(
        path.join(layout.agentsDir, `${PREFIX}${role}${layout.agentSuffix}`),
        renderAgent(agent, front, body, settings, vars),
      );
    }

    await pruneStale(
      layout.skillsDir,
      SKILLS.map((skill) => `${PREFIX}${skill}`),
    );
    for (const skill of SKILLS) {
      const body = await readTemplate(
        path.join(templates, 'skills', `${PREFIX}${skill}.md`),
      );
      if (body === undefined) continue;
      const dir = path.join(layout.skillsDir, `${PREFIX}${skill}`);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'SKILL.md'), render(body, vars));
    }

    if (layout.pluginsDir) {
      // OpenCode has no hook command; this plugin runs the guard instead.
      const plugin = await readTemplate(
        path.join(templates, 'opencode-plugin.js'),
      );
      await pruneStale(layout.pluginsDir, plugin ? [OPENCODE_PLUGIN] : []);
      if (plugin !== undefined) {
        await fsp.mkdir(layout.pluginsDir, { recursive: true });
        await fsp.writeFile(
          path.join(layout.pluginsDir, OPENCODE_PLUGIN),
          render(plugin, vars),
        );
      }
    }

    if (layout.commandsDir) {
      // OpenCode reaches a skill through the skill tool or an `@` mention,
      // not as `/name`. A one-line command per skill keeps the same slash
      // command in every agent.
      await pruneStale(
        layout.commandsDir,
        SKILLS.map((skill) => `${PREFIX}${skill}.md`),
      );
      await fsp.mkdir(layout.commandsDir, { recursive: true });
      for (const skill of SKILLS) {
        const body = await readTemplate(
          path.join(templates, 'opencode-commands', `${PREFIX}${skill}.md`),
        );
        if (body === undefined) continue;
        await fsp.writeFile(
          path.join(layout.commandsDir, `${PREFIX}${skill}.md`),
          body,
        );
      }
    }
  }

  if (agents.includes('opencode')) {
    await writeOpencodeVariants(
      targetDir,
      Object.fromEntries(
        ROLES.map((role) => [
          `${PREFIX}${role}`,
          roleSettings(resolved.roles, role, 'opencode', opencodeFallback)
            .effort,
        ]),
      ),
    );
  }
  if (agents.includes('copilot')) {
    await writeCopilotEfforts(
      targetDir,
      Object.fromEntries(
        ROLES.map((role) => [
          `${PREFIX}${role}`,
          roleSettings(resolved.roles, role, 'copilot').effort,
        ]),
      ),
    );
  }
}

interface AgentLayout {
  agentsDir: string;
  /** File name after the role name: `.md`, or Copilot's `.agent.md`. */
  agentSuffix: string;
  skillsDir: string;
  /** OpenCode only: where the slash commands for the skills go. */
  commandsDir?: string;
  /** OpenCode only: where the guard plugin goes. */
  pluginsDir?: string;
  /** OpenCode only: the config file the role variants are merged into. */
  configFile?: string;
}

function agentLayout(targetDir: string, agent: Agent): AgentLayout {
  const home = path.join(targetDir, 'home');
  switch (agent) {
    case 'claude-code':
      return {
        agentsDir: path.join(home, '.claude', 'agents'),
        agentSuffix: '.md',
        skillsDir: path.join(home, '.claude', 'skills'),
      };
    case 'opencode': {
      const dir = path.join(home, '.config', 'opencode');
      return {
        agentsDir: path.join(dir, 'agents'),
        agentSuffix: '.md',
        skillsDir: path.join(dir, 'skills'),
        commandsDir: path.join(dir, 'commands'),
        pluginsDir: path.join(dir, 'plugins'),
        configFile: path.join(dir, 'opencode.json'),
      };
    }
    case 'copilot':
      return {
        agentsDir: path.join(home, '.copilot', 'agents'),
        agentSuffix: '.agent.md',
        skillsDir: path.join(home, '.copilot', 'skills'),
      };
  }
}

/**
 * How each agent's generated files say where a lasting change belongs. A
 * project-level copy wins in Claude Code and OpenCode; in Copilot the personal
 * agent wins over the repository's, so there the copy needs a name of its own.
 */
const CUSTOMISE: Record<Agent, string[]> = {
  'claude-code': [
    "To customise, copy this file into a project's `.claude/agents/`, which",
    'wins over the global one and is yours to keep.',
  ],
  opencode: [
    "To customise, copy this file into a project's `.opencode/agents/`, which",
    'wins over the global one and is yours to keep.',
  ],
  copilot: [
    'Copilot prefers this personal agent over a repository one with the same',
    'name, so to customise, copy it into `.github/agents/` under a name of',
    'your own.',
  ],
};

function renderAgent(
  agent: Agent,
  frontmatter: string,
  body: string,
  settings: RoleSettings,
  vars: Record<string, string>,
): string {
  let front = render(frontmatter, vars);
  front = fillLine(
    front,
    'MODEL_LINE',
    settings.model && `model: ${settings.model}`,
  );
  // OpenCode's variant is not a frontmatter field; it goes to opencode.json.
  front = fillLine(
    front,
    'EFFORT_LINE',
    agent === 'claude-code' && settings.effort
      ? `effort: ${settings.effort}`
      : '',
  );
  const header = [
    '<!-- Generated by `monoceros apply` from the agent-roles feature. Edits here',
    '     are overwritten on the next apply.',
    ...CUSTOMISE[agent].map((line) => `     ${line}`),
    '-->',
  ].join('\n');
  return `---\n${front.trimEnd()}\n---\n\n${header}\n\n${render(body, vars)}`;
}

function templateVars(containerName: string): Record<string, string> {
  return {
    ROLES_DIR: rolesDir(containerName),
    PLANS_DIR: plansDir(containerName),
    ROLES_MATCH,
    PLANS_MATCH,
    GUARD: `${rolesDir(containerName)}/guard.mjs`,
  };
}

/**
 * Fill the `{{NAME}}` placeholders. Exported for the tests, which assert the
 * rendering rules rather than the prose.
 */
export function render(body: string, vars: Record<string, string>): string {
  let out = body;
  for (const [name, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${name}}}`, value);
  }
  return out;
}

/**
 * Replace a `{{NAME}}` placeholder line with `value`, or drop the line
 * entirely when there is no value. Dropping matters: an agent without a
 * `model` runs on the session's model, which is what "unset" has to mean. An
 * empty `model:` is not the same thing and would be a parse error.
 */
export function fillLine(body: string, name: string, value: string): string {
  if (!value)
    return body.replace(new RegExp(`^\\{\\{${name}\\}\\}\\n`, 'm'), '');
  return body.replace(`{{${name}}}`, value);
}

/**
 * Say once per apply what the `roles:` block sets for an agent the workbench
 * does not carry. Quiet when everything is used.
 */
function reportIgnoredSettings(
  roles: RolesBlock | undefined,
  agents: readonly Agent[],
): void {
  for (const agent of AGENTS) {
    if (agents.includes(agent)) continue;
    const set = ROLES.filter((role) => {
      const { model, effort } = declared(roles, role, agent);
      return model || effort;
    });
    if (set.length === 0) continue;
    consola.info(
      `[${FEATURE}] roles: ${AGENT_LABEL[agent]} is not in this workbench, so its lines (${set.join(', ')}) are ignored.`,
    );
  }
}

/** Take this feature's files out of one agent's tree. */
async function removeAgentFiles(
  targetDir: string,
  agent: Agent,
): Promise<void> {
  const layout = agentLayout(targetDir, agent);
  await pruneStale(layout.agentsDir, []);
  await pruneStale(layout.skillsDir, []);
  if (layout.commandsDir) await pruneStale(layout.commandsDir, []);
  if (layout.pluginsDir) await pruneStale(layout.pluginsDir, []);
  if (layout.configFile)
    await removeOpencodeAgentEntries(layout.configFile, PREFIX);
  if (agent === 'copilot') {
    const file = copilotSettingsFile(targetDir);
    if (existsSync(file)) await writeCopilotEfforts(targetDir, {});
  }
}

/**
 * Take the replaced features' files out of one agent's tree, by name. Claude
 * Code had agents and skills, OpenCode agents and commands plus entries in
 * `opencode.json`.
 */
async function removeLegacyFiles(
  targetDir: string,
  agent: Agent,
): Promise<void> {
  const layout = agentLayout(targetDir, agent);
  for (const name of LEGACY_AGENTS) {
    await fsp.rm(path.join(layout.agentsDir, `${name}.md`), { force: true });
  }
  for (const name of LEGACY_SKILLS) {
    await fsp.rm(path.join(layout.skillsDir, name), {
      recursive: true,
      force: true,
    });
    if (layout.commandsDir) {
      await fsp.rm(path.join(layout.commandsDir, `${name}.md`), {
        force: true,
      });
    }
  }
  if (layout.configFile) {
    await removeOpencodeAgentEntries(
      layout.configFile,
      'monoceros-',
      LEGACY_AGENTS,
    );
  }
}

/**
 * Delete the `agent-roles-*` entries in a directory that are not in `keep`.
 * The same directories hold agents, skills and commands from elsewhere, so the
 * prefix decides what we may touch and `keep` decides what survives. A missing
 * directory stays missing.
 */
async function pruneStale(dir: string, keep: readonly string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(PREFIX)) continue;
    if (keep.includes(entry)) continue;
    await fsp.rm(path.join(dir, entry), { recursive: true, force: true });
  }
}

/**
 * Merge each role's variant into `opencode.json`'s `agent` block.
 *
 * Not the frontmatter: OpenCode's markdown agents document `description`,
 * `mode`, `model`, `temperature` and `permission`, and `variant` is not among
 * them - it lives in the JSON `AgentConfig`. The merge keeps everything else
 * in the file, and it removes the key again when there is no variant, so
 * dropping a value from the yml really drops it from the container.
 */
async function writeOpencodeVariants(
  targetDir: string,
  variants: Record<string, string>,
): Promise<void> {
  const file = agentLayout(targetDir, 'opencode').configFile!;
  const config = await readJsonObject(file);
  if (config === undefined) return; // malformed: leave the builder's file alone

  const agents =
    typeof config.agent === 'object' && config.agent !== null
      ? (config.agent as Record<string, Record<string, unknown>>)
      : {};
  for (const [name, variant] of Object.entries(variants)) {
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

function copilotSettingsFile(targetDir: string): string {
  return path.join(targetDir, 'home', '.copilot', 'settings.json');
}

/**
 * Set each role's effort in Copilot's `settings.json`, under
 * `subagents.agents.<agent-name>.effortLevel`. Not the frontmatter: Copilot's
 * agent files take a `model` but no effort, which is a per-subagent user
 * setting there (`/subagents`). Every `agent-roles-*` entry is rewritten from
 * `efforts`, so a value dropped from the yml leaves the container too, and an
 * empty map removes them all. Other subagents' entries and any other field
 * the builder set on ours stay.
 */
async function writeCopilotEfforts(
  targetDir: string,
  efforts: Record<string, string>,
): Promise<void> {
  await mergeJson(copilotSettingsFile(targetDir), (config) => {
    const isObject = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v);
    const subagents = isObject(config.subagents) ? config.subagents : {};
    const agents = isObject(subagents.agents) ? subagents.agents : {};
    for (const name of Object.keys(agents)) {
      if (!name.startsWith(PREFIX) || name in efforts) continue;
      efforts[name] = '';
    }
    for (const [name, effort] of Object.entries(efforts)) {
      const entry = isObject(agents[name]) ? agents[name] : {};
      if (effort) entry.effortLevel = effort;
      else delete entry.effortLevel;
      if (Object.keys(entry).length > 0) agents[name] = entry;
      else delete agents[name];
    }
    if (Object.keys(agents).length > 0) subagents.agents = agents;
    else delete subagents.agents;
    if (Object.keys(subagents).length > 0) config.subagents = subagents;
    else delete config.subagents;
  });
}

/**
 * Drop role entries from `opencode.json`'s `agent` block: every key with the
 * prefix, or only the named ones when a list is given. Everything else stays;
 * the file is only rewritten when something actually went.
 */
async function removeOpencodeAgentEntries(
  file: string,
  prefix: string,
  only?: readonly string[],
): Promise<void> {
  if (!existsSync(file)) return;
  const config = await readJsonObject(file);
  if (!config || typeof config.agent !== 'object' || config.agent === null)
    return;
  const agents = config.agent as Record<string, unknown>;
  const stale = Object.keys(agents).filter(
    (name) => name.startsWith(prefix) && (!only || only.includes(name)),
  );
  if (stale.length === 0) return;
  for (const name of stale) delete agents[name];
  if (Object.keys(agents).length === 0) delete config.agent;
  await fsp.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * A JSON object from disk: `{}` when the file is missing or empty, undefined
 * when it is malformed, so a caller can leave a file alone that the builder
 * may be in the middle of editing.
 */
async function readJsonObject(
  file: string,
): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(file)) return {};
  try {
    const txt = await fsp.readFile(file, 'utf8');
    if (!txt.trim()) return {};
    const parsed: unknown = JSON.parse(txt);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
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
    consola.warn(`[${FEATURE}] template missing: ${file}`);
    return undefined;
  }
}

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

/**
 * Levenshtein distance, capped at what a "did you mean" is worth. Small and
 * local: this is the only place in the CLI that needs one.
 */
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(
        prev[j]! + 1,
        prev[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = prev[j]!;
      prev[j] = next;
    }
  }
  return prev[b.length]!;
}

/** The closest candidate, when one is close enough to be worth naming. */
function suggest(value: string, candidates: readonly string[]): string {
  let best = '';
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = distance(value.toLowerCase(), c);
    if (d < bestDistance) {
      bestDistance = d;
      best = c;
    }
  }
  // Two edits on a short word is still recognisably the same word; beyond
  // that a suggestion is noise ("did you mean sonnet?" for "gpt-4").
  return bestDistance <= 2 ? ` Did you mean '${best}'?` : '';
}
