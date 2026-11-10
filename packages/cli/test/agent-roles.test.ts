import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { consola } from 'consola';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDescriptorCatalog } from '../src/catalog/load.js';
import {
  fillLine,
  plansDir,
  roleSettings,
  validateAgentRoles,
  writeAgentRoles,
  type RolesBlock,
} from '../src/create/agent-roles.js';
import { parseConfig } from '../src/config/index.js';
import { solutionConfigToCreateOptions } from '../src/config/transform.js';
import { normalizeOptions } from '../src/create/scaffold.js';
import { buildComponentCatalog } from '../src/init/components.js';

const F = 'ghcr.io/getmonoceros/monoceros-features';
const ROLES = `${F}/agent-roles:1`;
const CLAUDE = `${F}/claude-code:1`;
const OPENCODE = `${F}/opencode:1`;
const COPILOT = `${F}/copilot:1`;
const LEGACY_CC = `${F}/claude-code-roles:1`;
const LEGACY_OC = `${F}/opencode-roles:1`;

const NAME = 'acme';
const PLANS = '/workspaces/acme/.monoceros/agent-roles/plans';
const GUARD = '/workspaces/acme/.monoceros/agent-roles/guard.mjs';

const ROLE_FILES = [
  'agent-roles-developer',
  'agent-roles-planner',
  'agent-roles-reviewer',
];
const SKILL_NAMES = [
  'agent-roles-plan',
  'agent-roles-review',
  'agent-roles-ship',
];

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'monoceros-agent-roles-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const home = (...p: string[]) => path.join(dir, 'home', ...p);
const read = (p: string) => readFile(p, 'utf8');
const ls = async (p: string) => (await readdir(p)).sort();

const claudeAgent = (role: string) =>
  read(home('.claude', 'agents', `agent-roles-${role}.md`));
const opencodeAgent = (role: string) =>
  read(home('.config', 'opencode', 'agents', `agent-roles-${role}.md`));
const copilotAgent = (role: string) =>
  read(home('.copilot', 'agents', `agent-roles-${role}.agent.md`));
const skill = (name: string) =>
  read(home('.claude', 'skills', name, 'SKILL.md'));

const all = { [CLAUDE]: {}, [OPENCODE]: {}, [COPILOT]: {}, [ROLES]: {} };

type Features = Record<string, Record<string, string | number | boolean>>;
const write = (features: Features, agentRoles?: RolesBlock) =>
  writeAgentRoles(dir, NAME, { features, agentRoles });

describe('writeAgentRoles', () => {
  it('writes nothing without the feature', async () => {
    await write({ [CLAUDE]: {} });
    await expect(readdir(home('.claude', 'agents'))).rejects.toThrow();
    await expect(
      readdir(path.join(dir, '.monoceros', 'agent-roles')),
    ).rejects.toThrow();
  });

  it('writes roles and skills for every coding agent present', async () => {
    await write(all);

    expect(await ls(home('.claude', 'agents'))).toEqual(
      ROLE_FILES.map((r) => `${r}.md`),
    );
    expect(await ls(home('.claude', 'skills'))).toEqual(SKILL_NAMES);

    expect(await ls(home('.config', 'opencode', 'agents'))).toEqual(
      ROLE_FILES.map((r) => `${r}.md`),
    );
    expect(await ls(home('.config', 'opencode', 'skills'))).toEqual(
      SKILL_NAMES,
    );
    // OpenCode reaches a skill through its skill tool, not as `/name`, so a
    // thin command per skill keeps the slash command the same everywhere.
    expect(await ls(home('.config', 'opencode', 'commands'))).toEqual(
      SKILL_NAMES.map((s) => `${s}.md`),
    );

    expect(await ls(home('.copilot', 'agents'))).toEqual(
      ROLE_FILES.map((r) => `${r}.agent.md`),
    );
    expect(await ls(home('.copilot', 'skills'))).toEqual(SKILL_NAMES);

    await expect(
      read(path.join(dir, '.monoceros', 'agent-roles', 'guard.mjs')),
    ).resolves.toContain('PreToolUse');
    expect(
      await readdir(path.join(dir, '.monoceros', 'agent-roles', 'plans')),
    ).toEqual([]);
  });

  // One text for every agent is the point of the feature (ADR 0067): the
  // skills a session follows must not differ between agents, or a lesson
  // fixed in one copy stays broken in another.
  it('gives every agent the same skill text', async () => {
    await write(all);
    for (const name of SKILL_NAMES) {
      const claude = await skill(name);
      expect(
        await read(home('.config', 'opencode', 'skills', name, 'SKILL.md')),
      ).toBe(claude);
      expect(await read(home('.copilot', 'skills', name, 'SKILL.md'))).toBe(
        claude,
      );
    }
  });

  it('writes only for the agents that are there', async () => {
    await write({ [OPENCODE]: {}, [ROLES]: {} });
    expect(await ls(home('.config', 'opencode', 'agents'))).toHaveLength(3);
    await expect(readdir(home('.claude', 'agents'))).rejects.toThrow();
    await expect(readdir(home('.copilot', 'agents'))).rejects.toThrow();
  });

  it('writes nothing but a warning when no coding agent is there', async () => {
    await write({ [ROLES]: {} });
    for (const p of [
      home('.claude', 'agents'),
      home('.config', 'opencode', 'agents'),
      home('.copilot', 'agents'),
    ]) {
      await expect(readdir(p)).rejects.toThrow();
    }
  });

  // Every one of these trees is a persistent bind mount, so a file an earlier
  // apply wrote stays live until something deletes it. Dropping the feature,
  // or an agent, has to take the role files with it - and only those.
  it('removes its files when the feature leaves the yml, and keeps the plans', async () => {
    await write(all);
    await mkdir(home('.claude', 'skills', 'twg'), { recursive: true });
    await writeFile(home('.claude', 'agents', 'my-own.md'), 'mine\n');
    const plan = path.join(dir, '.monoceros', 'agent-roles', 'plans', 'a.md');
    await writeFile(plan, '# a plan\n');

    await write({
      [CLAUDE]: {},
      [OPENCODE]: {},
      [COPILOT]: {},
    });

    expect(await ls(home('.claude', 'agents'))).toEqual(['my-own.md']);
    expect(await ls(home('.claude', 'skills'))).toEqual(['twg']);
    expect(await ls(home('.config', 'opencode', 'agents'))).toEqual([]);
    expect(await ls(home('.config', 'opencode', 'commands'))).toEqual([]);
    expect(await ls(home('.config', 'opencode', 'plugins'))).toEqual([]);
    expect(await ls(home('.copilot', 'agents'))).toEqual([]);
    await expect(
      read(path.join(dir, '.monoceros', 'agent-roles', 'guard.mjs')),
    ).rejects.toThrow();
    // The plans are the builder's work, not ours to delete.
    expect(await read(plan)).toBe('# a plan\n');
  });

  it('removes the roles of an agent that left the yml', async () => {
    await write(all);
    await write({ [CLAUDE]: {}, [ROLES]: {} });
    expect(await ls(home('.claude', 'agents'))).toHaveLength(3);
    expect(await ls(home('.copilot', 'agents'))).toEqual([]);
    expect(await ls(home('.config', 'opencode', 'agents'))).toEqual([]);
    expect(await ls(home('.config', 'opencode', 'plugins'))).toEqual([]);
  });

  // The two features this one replaces wrote under `monoceros-` names, and a
  // container that once applied them still has them on disk - the design role
  // too (ADR 0050). OpenCode reads `~/.claude/skills` as well, so an old Claude
  // Code skill left there would run in OpenCode without its role's guard,
  // which is the very interference that kept the two features apart.
  it('removes what the replaced features wrote, by name', async () => {
    await mkdir(home('.claude', 'agents'), { recursive: true });
    await mkdir(home('.claude', 'skills', 'monoceros-plan'), {
      recursive: true,
    });
    await mkdir(home('.claude', 'skills', 'monoceros-guide'), {
      recursive: true,
    });
    await mkdir(home('.claude', 'monoceros-roles'), { recursive: true });
    for (const name of ['monoceros-planner', 'monoceros-designer']) {
      await writeFile(home('.claude', 'agents', `${name}.md`), 'old\n');
    }
    await mkdir(home('.config', 'opencode', 'commands'), { recursive: true });
    await writeFile(
      home('.config', 'opencode', 'commands', 'monoceros-ship.md'),
      'old\n',
    );
    await writeFile(
      home('.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        model: 'x/y',
        agent: { 'monoceros-planner': { variant: 'max' }, mine: {} },
      }),
    );

    await write(all);

    expect(await ls(home('.claude', 'agents'))).toEqual(
      ROLE_FILES.map((r) => `${r}.md`),
    );
    // Only the names the old features shipped; another `monoceros-` skill is
    // not ours to delete.
    expect(await ls(home('.claude', 'skills'))).toEqual(
      [...SKILL_NAMES, 'monoceros-guide'].sort(),
    );
    await expect(readdir(home('.claude', 'monoceros-roles'))).rejects.toThrow();
    expect(await ls(home('.config', 'opencode', 'commands'))).toEqual(
      SKILL_NAMES.map((s) => `${s}.md`),
    );
    const cfg = JSON.parse(
      await read(home('.config', 'opencode', 'opencode.json')),
    );
    expect(cfg.model).toBe('x/y');
    expect(Object.keys(cfg.agent)).toContain('mine');
    expect(Object.keys(cfg.agent)).not.toContain('monoceros-planner');
  });

  // An older yml keeps working: the replaced feature's options are honoured,
  // the roles are written under their new names, and nothing of the old names
  // is left behind.
  it('honours a replaced feature in the yml', async () => {
    await write({
      [CLAUDE]: {},
      [LEGACY_CC]: { plannerModel: 'haiku' },
    });
    expect(await claudeAgent('planner')).toContain('\nmodel: haiku\n');
  });

  // add-feature carries the old settings over, and only while the old entry
  // is still in the yml, so the hint names the add first. Once both are in,
  // the old entry is dead weight and apply says how to drop it.
  it('tells an older yml to add agent-roles before removing the old feature', async () => {
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {});
    try {
      await write({ [CLAUDE]: {}, [LEGACY_CC]: {} });
      const hint = String(warn.mock.calls[0]?.[0]);
      expect(hint.indexOf('add-feature acme agent-roles')).toBeLessThan(
        hint.indexOf('remove-feature acme claude-code-roles'),
      );
      warn.mockClear();
      await write({ [CLAUDE]: {}, [ROLES]: {}, [LEGACY_CC]: {} });
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        'remove-feature acme claude-code-roles',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('renders every placeholder', async () => {
    await write(all);
    const files = [
      ...(await Promise.all(
        ['planner', 'developer', 'reviewer'].flatMap((r) => [
          claudeAgent(r),
          opencodeAgent(r),
          copilotAgent(r),
        ]),
      )),
      ...(await Promise.all(SKILL_NAMES.map(skill))),
      await read(path.join(dir, '.monoceros', 'agent-roles', 'guard.mjs')),
    ];
    for (const body of files) expect(body).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  // Plans live in the workspace, which every agent can reach without extra
  // permissions, and spelled out absolute: an agent expanding `~` or a
  // relative path itself is how a write ends up outside what its guard allows.
  it('points every role and skill at the workspace plans folder', async () => {
    await write(all);
    expect(await claudeAgent('planner')).toContain(`${PLANS}/<app>/<slug>.md`);
    expect(await skill('agent-roles-ship')).toContain(`find ${PLANS}`);
    expect(await skill('agent-roles-review')).toContain(`find ${PLANS}`);
    expect(plansDir(NAME)).toBe(PLANS);
  });

  describe('the session leads', () => {
    // A subagent cannot reach the user in Claude Code, and nothing documents
    // that it can in OpenCode or Copilot. So the asking happens in the skill,
    // in the session, and the planner is told it cannot ask.
    it('keeps the questions in the session and out of the planner', async () => {
      await write(all);
      for (const body of [
        await claudeAgent('planner'),
        await opencodeAgent('planner'),
        await copilotAgent('planner'),
      ]) {
        expect(body).toContain('You cannot ask questions');
      }
      expect(await skill('agent-roles-plan')).toContain(
        'One question at a time',
      );
    });

    // No role delegates. OpenCode's planner used to drive the whole chain;
    // with the session leading everywhere, every role stays at depth one.
    it('lets no role start another agent', async () => {
      await write(all);
      for (const role of ['planner', 'developer']) {
        expect(await claudeAgent(role)).toContain('disallowedTools: Agent');
      }
      for (const role of ['planner', 'developer', 'reviewer']) {
        const body = await opencodeAgent(role);
        expect(body).toContain('mode: subagent');
        expect(body).toContain('task: deny');
      }
      expect(await copilotAgent('developer')).not.toContain("'agent'");
    });

    // Copilot subagents do not read the custom instructions unless the agent
    // asks for them, and the roles need the briefing as much as the session.
    it('gives the Copilot roles the briefing', async () => {
      await write(all);
      for (const role of ['planner', 'developer', 'reviewer']) {
        expect(await copilotAgent(role)).toContain(
          'include-custom-instructions: true',
        );
      }
    });

    // The developer's description is what a session reads when it decides
    // whether to delegate. "Use for every code change" invited it to hand any
    // change to a role that needs a plan file, and made the roles look like
    // the only way to work.
    it('keeps the developer to plans, not ordinary changes', async () => {
      await write(all);
      for (const body of [
        await claudeAgent('developer'),
        await opencodeAgent('developer'),
        await copilotAgent('developer'),
      ]) {
        expect(body).toContain('never for an ordinary code change');
        expect(body).not.toContain('Use for every code change');
      }
    });
  });

  describe('permissions', () => {
    // The guard is the only layer that survives Claude Code's Auto Mode, and
    // Copilot cannot say "this file only" in an agent either.
    it('wires the guard into the Claude Code and Copilot roles', async () => {
      await write(all);
      for (const role of ['planner', 'developer', 'reviewer']) {
        expect(await claudeAgent(role)).toContain(
          `command: 'node ${GUARD} ${role}'`,
        );
        expect(await copilotAgent(role)).toContain(
          `command: 'node ${GUARD} ${role} copilot'`,
        );
      }
    });

    it('gives the reviewer read-only tools', async () => {
      await write(all);
      expect(await claudeAgent('reviewer')).toContain(
        'tools: Read, Grep, Glob, Bash, TodoWrite',
      );
      expect(await copilotAgent('reviewer')).not.toContain("'edit'");
      expect(await opencodeAgent('reviewer')).toContain('edit: deny');
    });

    // OpenCode's edit tool asks with the path relative to the worktree, and
    // the plans sit above it in the workspace. A pattern that only matches the
    // absolute path locked the planner out of its own plans once.
    it('covers both path spellings in the OpenCode permissions', async () => {
      await write(all);
      const planner = await opencodeAgent('planner');
      expect(planner).toContain(
        `edit: { '*': deny, '${PLANS}/*': allow, '*/.monoceros/agent-roles/plans/*': allow }`,
      );
      const developer = await opencodeAgent('developer');
      expect(developer).toContain(`'*/.monoceros/agent-roles/*': deny`);
    });

    // OpenCode has no hook command, so a plugin runs the guard. Its globs
    // could not tell `> file` from `2>&1`, a quoted arrow, `>&2` or a `>` in a
    // heredoc body, and refused real probes over each of them in turn.
    it('runs the guard in OpenCode through a plugin', async () => {
      await write(all);
      const plugins = home('.config', 'opencode', 'plugins');
      expect(await ls(plugins)).toEqual(['agent-roles-guard.js']);
      const plugin = await read(path.join(plugins, 'agent-roles-guard.js'));
      expect(plugin).toContain(`const GUARD = '${GUARD}';`);
      expect(plugin).not.toContain('{{');
    });

    it('leaves the redirect rules in OpenCode to the guard', async () => {
      await write(all);
      for (const role of ['planner', 'reviewer']) {
        const body = await opencodeAgent(role);
        expect(body).not.toContain("'* >*': deny");
        expect(body).not.toContain('/dev/null');
        // The rules a glob gets right stay, in case the plugin does not load.
        expect(body).toContain("'git push*': deny");
        expect(body).toContain("'sed -i*': deny");
      }
      expect(await opencodeAgent('planner')).toContain("'*<<*': deny");
    });

    it("keeps a builder's own OpenCode plugins", async () => {
      const plugins = home('.config', 'opencode', 'plugins');
      await mkdir(plugins, { recursive: true });
      await writeFile(path.join(plugins, 'mine.js'), 'export {};\n');
      await write(all);
      await write({ [OPENCODE]: {} });
      expect(await ls(plugins)).toEqual(['mine.js']);
    });

    it('lets the developer commit but never publish', async () => {
      await write(all);
      const body = await opencodeAgent('developer');
      expect(body).toContain("'git push*': deny");
      expect(body).not.toContain("'git commit*': deny");
    });
  });

  describe('lessons from real runs', () => {
    // Regression from a real run: a skill that blocked model invocation was
    // unreachable from Claude Desktop over SSH, which never sees the slash
    // palette of the container. The guard against starting a planning
    // dialogue unasked lives in the description instead.
    it('keeps every skill reachable without a slash palette', async () => {
      await write(all);
      for (const name of SKILL_NAMES) {
        expect(await skill(name)).not.toContain('disable-model-invocation');
      }
      expect(await skill('agent-roles-plan')).toContain('asks for a plan');
    });

    // A `!`…`` line runs before the skill loads and is not a prompt anyone can
    // approve: in every mode but auto it aborted the skill. And only Claude
    // Code runs them. So the skills ask for the commands they need instead.
    it('has no shell substitution in any skill', async () => {
      await write(all);
      for (const name of SKILL_NAMES)
        expect(await skill(name)).not.toContain('!`');
    });

    it('keeps phase 0 functional and lets it follow an answer', async () => {
      await write(all);
      const plan = await skill('agent-roles-plan');
      expect(plan).toContain("Ask in the user's words, never in yours");
      expect(plan).toContain('Follow the answer');
      expect(plan).toContain(
        'Stop when nothing is left that changes what gets built',
      );
      expect(plan).toMatch(/Not\s+"which database\?" but/);
    });

    // Two instances of one class: a 200 on `/`, and `2026-02-30` as the invalid
    // date JavaScript quietly rolls over. A check that would already pass
    // against today's code proves nothing.
    // A kimi-k3 planner wrote the acceptance as a heredoc into the plan; the
    // OpenCode reviewer's redirect rule refused it over its `>&2`. A script
    // goes next to the plan, never into the repository.
    it('keeps the acceptance command to one line, with a script next to the plan', async () => {
      await write(all);
      for (const body of [
        await claudeAgent('planner'),
        await copilotAgent('planner'),
        await opencodeAgent('planner'),
      ]) {
        expect(body).toContain('**That command is one line.**');
        expect(body).toMatch(
          /`bash \/\S+\/plans\/<app>\/<slug>\.acceptance\.sh`/,
        );
      }
    });

    it('makes the planner and the reviewer insist on checks that can fail', async () => {
      await write(all);
      expect(await claudeAgent('planner')).toContain(
        'Every check has to be able to fail',
      );
      expect(await claudeAgent('reviewer')).toContain(
        'Every check has to be able to fail',
      );
    });

    // A white page behind fifteen green tests: nothing fetched the module the
    // page imported. All three roles carry the rule.
    it('makes all three roles follow the page references, not just its status', async () => {
      await write(all);
      const planner = await claudeAgent('planner');
      const developer = await claudeAgent('developer');
      const reviewer = await claudeAgent('reviewer');
      expect(planner).toContain("follow the\n  page's references");
      expect(developer).toContain('A 200 on `/` proves nothing');
      expect(reviewer).toContain('a 200 on `/` does not settle it');
      for (const body of [planner, developer, reviewer]) {
        expect(body).toMatch(/content type/);
      }
    });

    it('names the env as the fix for a missing git identity', async () => {
      await write(all);
      const developer = await claudeAgent('developer');
      expect(developer).toContain('Please tell me who you are');
      expect(developer).toMatch(
        /GIT_USER_NAME` and `GIT_USER_EMAIL` in\s+`monoceros-config\.env`/,
      );
    });

    // Runs went on without the screens, and one read Figma through the
    // account's `claude.ai Figma` connector instead of the workbench's. The
    // session reads the design while the user is there, the planner saves a
    // fresh copy next to the plan, and the two roles after it use the copy.
    it('reads the design before planning and hands on a fresh copy', async () => {
      await write(all);
      const plan = await skill('agent-roles-plan');
      expect(plan).toContain('**stop here and plan nothing.**');
      expect(plan).toContain('`/design-login`');
      expect(plan).toContain('Read it every time');
      expect(plan).toContain('monoceros add-mcp-server <name> figma');
      expect(plan).toContain('`figma.com/make/…`');
      expect(plan).toContain("only the workbench's own connector counts");
      expect(plan).toContain('`claude.ai Figma`');
      const planner = await claudeAgent('planner');
      expect(planner).toContain('`claude.ai Figma`');
      expect(planner).toContain(`\`${PLANS}/<app>/<slug>.design/\``);
      expect(await claudeAgent('developer')).toContain(
        'Never open the design link yourself.',
      );
      expect(await claudeAgent('reviewer')).toContain(
        'Judge against the copy only, never the link',
      );
    });

    it("keeps ADRs a planned step and out of the developer's judgement", async () => {
      await write(all);
      const planner = await claudeAgent('planner');
      expect(planner).toContain('as a numbered step');
      expect(planner).toContain('Probe the next number, never guess it');
      const developer = await claudeAgent('developer');
      expect(developer).toContain('do not write an ADR');
      expect(developer).toContain('Name it in your deviations');
      expect(await claudeAgent('reviewer')).toContain('writes an ADR under');
    });

    // A reviewer found a test server left on a port and tried `kill` and
    // `DROP SCHEMA` on its way to the verdict. Leftovers are findings.
    it('makes the reviewer report leftovers instead of cleaning them up', async () => {
      await write(all);
      for (const body of [
        await claudeAgent('reviewer'),
        await copilotAgent('reviewer'),
        await opencodeAgent('reviewer'),
      ]) {
        expect(body).toContain('The same goes for what you find left behind');
        expect(body).toContain('you leave it where it is');
      }
    });

    // The host steps are the part that got dropped: green tests, a working
    // app, and nothing reachable in the browser.
    it('carries the host steps through every hand-over', async () => {
      await write(all);
      expect(await claudeAgent('developer')).toContain('**Host steps**');
      expect(await skill('agent-roles-ship')).toContain(
        "Carry the developer's **Host steps** section over verbatim",
      );
    });
  });

  describe('review without a plan', () => {
    // The dialog mode: a change made in conversation gets a review against
    // what the conversation set out to do. The reviewer must not see the
    // conversation, so the session writes the goal down for it.
    it('reviews against the conversation goal when no plan is named', async () => {
      await write(all);
      const review = await skill('agent-roles-review');
      expect(review).toContain('Against the conversation');
      expect(review).toContain('must\nnot see this conversation');
      expect(review).toContain('Base: <the ref>');
      const reviewer = await claudeAgent('reviewer');
      expect(reviewer).toContain('**A conversation goal.**');
      expect(reviewer).toContain('`git diff <base>`');
      expect(reviewer).toContain("find the\n   project's own test command");
    });

    // Without a plan nobody runs a repair loop: the session that made the
    // change fixes the findings, when the user says so.
    it('hands conversation findings back to the session, not to a developer', async () => {
      await write(all);
      expect(await skill('agent-roles-review')).toContain(
        'offer to fix the findings here',
      );
    });
  });

  describe('models and effort', () => {
    // Each agent is configured under its own name. Nothing is guessed from
    // the spelling of a value: Copilot writes Claude models as
    // `claude-opus-4.5`, Claude Code as `claude-opus-4-5`, and a guess sent one
    // agent's value to the other.
    it('gives each agent the model and effort set under its name', async () => {
      await write(all, {
        planner: {
          'claude-code': { model: 'opus', effort: 'xhigh' },
          copilot: { model: 'claude-opus-4.5' },
          opencode: { model: 'openrouter/moonshotai/kimi-k3', effort: 'max' },
        },
        developer: { 'claude-code': { model: 'sonnet' } },
      });
      expect(await claudeAgent('planner')).toContain('\nmodel: opus\n');
      expect(await claudeAgent('planner')).toContain('\neffort: xhigh\n');
      expect(await copilotAgent('planner')).toContain(
        '\nmodel: claude-opus-4.5\n',
      );
      expect(await opencodeAgent('planner')).toContain(
        '\nmodel: openrouter/moonshotai/kimi-k3\n',
      );
      expect(await claudeAgent('developer')).toContain('\nmodel: sonnet\n');
      // Not set for the developer in Copilot and OpenCode: the session's model.
      expect(await copilotAgent('developer')).not.toContain('model:');
      expect(await opencodeAgent('developer')).not.toContain('model:');
      const cfg = JSON.parse(
        await read(home('.config', 'opencode', 'opencode.json')),
      );
      expect(cfg.agent['agent-roles-planner']).toEqual({ variant: 'max' });
    });

    // Unset has to drop the whole line: an empty `model:` is not the same as
    // inheriting the session's, and would be a parse error.
    it('runs every role on the session model without a roles block', async () => {
      await write(all);
      for (const role of ['planner', 'developer', 'reviewer']) {
        for (const body of [
          await claudeAgent(role),
          await opencodeAgent(role),
          await copilotAgent(role),
        ]) {
          expect(body).not.toContain('model:');
          expect(body).not.toContain('effort:');
        }
      }
    });

    it("falls back to the opencode feature's model in OpenCode", async () => {
      await write({
        [OPENCODE]: { model: 'anthropic/claude-sonnet-5' },
        [ROLES]: {},
      });
      expect(await opencodeAgent('planner')).toContain(
        '\nmodel: anthropic/claude-sonnet-5\n',
      );
    });

    it('clears a variant that left the yml', async () => {
      const features = { [OPENCODE]: {}, [ROLES]: {} };
      await write(features, {
        developer: { opencode: { model: 'a/b', effort: 'max' } },
      });
      await write(features, { developer: { opencode: { model: 'a/b' } } });
      const cfg = JSON.parse(
        await read(home('.config', 'opencode', 'opencode.json')),
      );
      expect(cfg.agent).toBeUndefined();
    });

    // Copilot's agent files take a model but no effort; the effort is a
    // per-subagent user setting in settings.json (`subagents.agents.<name>`).
    it("writes Copilot's effort into its settings, next to what is there", async () => {
      const settings = home('.copilot', 'settings.json');
      await mkdir(home('.copilot'), { recursive: true });
      await writeFile(
        settings,
        JSON.stringify({
          defaultPermissionMode: 'assisted',
          subagents: {
            maxDepth: 2,
            agents: {
              mine: { effortLevel: 'low' },
              'agent-roles-planner': { contextTier: 'long_context' },
            },
          },
        }),
      );
      await write(all, {
        planner: { copilot: { model: 'gpt-6-astra', effort: 'high' } },
        reviewer: { copilot: { effort: 'xhigh' } },
      });
      expect(await copilotAgent('planner')).not.toContain('effort');
      expect(JSON.parse(await read(settings))).toEqual({
        defaultPermissionMode: 'assisted',
        subagents: {
          maxDepth: 2,
          agents: {
            mine: { effortLevel: 'low' },
            'agent-roles-planner': {
              contextTier: 'long_context',
              effortLevel: 'high',
            },
            'agent-roles-reviewer': { effortLevel: 'xhigh' },
          },
        },
      });
    });

    it('takes a Copilot effort out again when it leaves the yml or Copilot does', async () => {
      const settings = home('.copilot', 'settings.json');
      await write(all, {
        planner: { copilot: { effort: 'high' } },
        developer: { copilot: { effort: 'medium' } },
      });
      await write(all, { planner: { copilot: { effort: 'high' } } });
      expect(JSON.parse(await read(settings)).subagents.agents).toEqual({
        'agent-roles-planner': { effortLevel: 'high' },
      });
      await write({ [CLAUDE]: {}, [ROLES]: {} });
      expect(JSON.parse(await read(settings)).subagents).toBeUndefined();
    });

    it('keeps the effort for Copilot', () => {
      expect(
        roleSettings(
          { planner: { copilot: { model: 'gpt-5', effort: 'high' } } },
          'planner',
          'copilot',
        ),
      ).toEqual({ model: 'gpt-5', effort: 'high' });
    });

    // An older yml keeps working: the replaced feature's flat options land
    // under the agent it was for.
    it('translates the options of a replaced feature', async () => {
      await write({
        [CLAUDE]: {},
        [OPENCODE]: {},
        [LEGACY_OC]: { plannerModel: 'a/b', plannerEffort: 'max' },
      });
      expect(await opencodeAgent('planner')).toContain('\nmodel: a/b\n');
      expect(await claudeAgent('planner')).not.toContain('model:');
    });

    // Whether someone works in an agent is not in the yml, so the feature
    // sets no model for anyone. Its catalog entry contributes the bare ref;
    // the commented `roles:` example is the init/add-feature scaffold.
    it('contributes no options to a new yml', async () => {
      const componentsRoot = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'components',
      );
      const catalog = buildComponentCatalog(
        await loadDescriptorCatalog(componentsRoot),
      );
      const features = catalog.get('agent-roles')?.file.contributes.features;
      expect(features?.map((f) => f.ref)).toEqual([ROLES]);
      expect(Object.keys(features?.[0]?.options ?? {})).toEqual([]);
      // The replaced features are out of the catalog.
      expect(catalog.get('claude-code-roles')).toBeUndefined();
      expect(catalog.get('opencode-roles')).toBeUndefined();
    });
  });

  describe('fillLine', () => {
    it('drops the line, not just the placeholder, when there is no value', () => {
      expect(fillLine('a\n{{MODEL_LINE}}\nb\n', 'MODEL_LINE', '')).toBe(
        'a\nb\n',
      );
    });

    it('fills the line when there is a value', () => {
      expect(fillLine('{{MODEL_LINE}}\n', 'MODEL_LINE', 'model: haiku')).toBe(
        'model: haiku\n',
      );
    });
  });
});

describe('validateAgentRoles', () => {
  const v = (features: Features, agentRoles?: RolesBlock) => () =>
    validateAgentRoles({ features, agentRoles });

  it('accepts no roles block at all', () => {
    expect(v({})).not.toThrow();
    expect(v({ [ROLES]: {} })).not.toThrow();
  });

  // The typo that cost a whole run: the subagent refused to start, the session
  // picked its own replacement, and the chain finished on a model nobody had
  // chosen.
  it('rejects a mistyped Claude Code model and names the likely one', () => {
    expect(
      v(
        { [CLAUDE]: {}, [ROLES]: {} },
        {
          developer: { 'claude-code': { model: 'sonet' } },
        },
      ),
    ).toThrow(/unknown Claude Code model 'sonet'.*Did you mean 'sonnet'\?/s);
  });

  it('rejects a mistyped Claude Code effort', () => {
    expect(
      v(
        { [CLAUDE]: {}, [ROLES]: {} },
        {
          planner: { 'claude-code': { effort: 'xhig' } },
        },
      ),
    ).toThrow(/unknown effort 'xhig'.*Did you mean 'xhigh'\?/s);
  });

  // OpenCode needs the provider prefix; without it the request never reaches
  // a provider. And its effort is a variant of the model next to it.
  it('holds OpenCode to provider/model-id and a model next to an effort', () => {
    expect(
      v(
        { [OPENCODE]: {}, [ROLES]: {} },
        {
          reviewer: { opencode: { model: 'kimi-k3' } },
        },
      ),
    ).toThrow(/not a 'provider\/model-id' reference/);
    expect(
      v(
        { [OPENCODE]: {}, [ROLES]: {} },
        {
          reviewer: { opencode: { effort: 'max' } },
        },
      ),
    ).toThrow(/sets an effort for the OpenCode reviewer, but no model/);
  });

  it('rejects a Copilot effort Copilot does not know', () => {
    expect(
      v(
        { [COPILOT]: {}, [ROLES]: {} },
        {
          planner: { copilot: { model: 'gpt-6-astra', effort: 'hgh' } },
        },
      ),
    ).toThrow(/unknown effort 'hgh'.*Did you mean 'high'\?.*minimal/s);
    expect(
      v(
        { [COPILOT]: {}, [ROLES]: {} },
        { planner: { copilot: { effort: 'minimal' } } },
      ),
    ).not.toThrow();
  });

  // The commented example carries placeholders. Uncommented but not filled
  // in, Copilot would be handed `<copilot model>` as a model name.
  it('refuses a placeholder that was uncommented but not filled in', () => {
    expect(
      v(
        { [COPILOT]: {}, [ROLES]: {} },
        {
          planner: { copilot: { model: '<copilot model>' } },
        },
      ),
    ).toThrow(/still the placeholder/);
  });

  // Lines for an agent the workbench does not carry are ignored, not wrong:
  // the agent may come later, and the example lists all three.
  it('does not check an agent the workbench does not carry', () => {
    expect(
      v(
        { [CLAUDE]: {}, [ROLES]: {} },
        {
          planner: { opencode: { model: '<provider/model-id>' } },
        },
      ),
    ).not.toThrow();
  });

  it('validates a replaced feature under its own name', () => {
    expect(v({ [CLAUDE]: {}, [LEGACY_CC]: { plannerModel: 'opuss' } })).toThrow(
      /^claude-code-roles:/,
    );
  });
});

describe('the roles block in the yml', () => {
  const yml = (roles: string, ref = ROLES) =>
    [
      'schemaVersion: 1',
      'name: acme',
      'features:',
      `  - ref: ${CLAUDE}`,
      `  - ref: ${ref}`,
      roles,
      '',
    ].join('\n');

  // Through the same steps apply takes. A real run lost the block in
  // normalizeOptions, which rebuilds the options field by field, and every
  // role ran on the session's model while the yml named another.
  it('reaches the generator from the yml', () => {
    const { config } = parseConfig(
      yml(
        [
          '    roles:',
          '      planner:',
          '        claude-code: { model: opus, effort: high }',
        ].join('\n'),
      ),
    );
    expect(
      normalizeOptions(solutionConfigToCreateOptions(config)).agentRoles,
    ).toEqual({
      planner: { 'claude-code': { model: 'opus', effort: 'high' } },
    });
  });

  // A typo in a role or agent name would otherwise be silently ignored, and
  // the role would run on a model nobody chose.
  it('refuses an unknown role or agent name', () => {
    expect(() =>
      parseConfig(
        yml(
          ['    roles:', '      planer:', '        claude-code: {}'].join('\n'),
        ),
      ),
    ).toThrow(/planer/);
    expect(() =>
      parseConfig(
        yml(['    roles:', '      planner:', '        claude: {}'].join('\n')),
      ),
    ).toThrow(/claude/);
  });

  it('refuses roles on any other feature', () => {
    expect(() =>
      parseConfig(
        yml(
          ['    roles:', '      planner:', '        claude-code: {}'].join(
            '\n',
          ),
          `${F}/github-cli:1`,
        ),
      ),
    ).toThrow(/belongs to the agent-roles feature/);
  });

  // A fully commented block parses to nothing, so every role runs on the
  // session's model until a line is uncommented.
  it('treats a fully commented block as no block', () => {
    const { config } = parseConfig(
      yml(['    # roles:', '    #   planner:'].join('\n')),
    );
    expect(solutionConfigToCreateOptions(config).agentRoles).toBeUndefined();
  });
});
