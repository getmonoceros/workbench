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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  renderRoleTemplate,
  writeClaudeCodeRoles,
} from '../src/create/claude-code-roles.js';

const CLAUDE = 'ghcr.io/getmonoceros/monoceros-features/claude-code:1';
const ROLES = 'ghcr.io/getmonoceros/monoceros-features/claude-code-roles:1';

const PLANS = '/home/node/.claude/plans';
const GUARD = '/home/node/.claude/monoceros-roles/guard.mjs';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'monoceros-cc-roles-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const claudeDir = () => path.join(dir, 'home', '.claude');
const agentsDir = () => path.join(claudeDir(), 'agents');
const skillsDir = () => path.join(claudeDir(), 'skills');

const read = (p: string) => readFile(p, 'utf8');
const agent = (name: string) => read(path.join(agentsDir(), `${name}.md`));
const skill = (name: string) => read(path.join(skillsDir(), name, 'SKILL.md'));

describe('writeClaudeCodeRoles', () => {
  it('is a no-op without the claude-code-roles feature', async () => {
    await writeClaudeCodeRoles(dir, { [CLAUDE]: {} });
    await expect(readdir(agentsDir())).rejects.toThrow();
  });

  // Dropping the feature from the yml has to take its files with it. `~/.claude`
  // is a persistent bind mount, so everything an earlier apply wrote stays there
  // until something deletes it: after a `remove-feature` plus `apply` all four
  // agents and all four skills were still in the container's home, and they had
  // to be deleted by hand.
  it('removes what it wrote when the feature leaves the yml', async () => {
    await writeClaudeCodeRoles(dir, { [CLAUDE]: {}, [ROLES]: {} });
    // The same tree holds skills and agents from elsewhere - `twg` and its
    // siblings arrive with `atlassian` - and those have to survive untouched.
    await mkdir(path.join(skillsDir(), 'twg'), { recursive: true });
    await writeFile(path.join(skillsDir(), 'twg', 'SKILL.md'), 'twg\n');
    await writeFile(path.join(agentsDir(), 'my-own.md'), 'mine\n');

    await writeClaudeCodeRoles(dir, { [CLAUDE]: {} });

    expect(await readdir(agentsDir())).toEqual(['my-own.md']);
    expect(await readdir(skillsDir())).toEqual(['twg']);
    await expect(
      readdir(path.join(claudeDir(), 'monoceros-roles')),
    ).rejects.toThrow();
  });

  it('writes the three agents, the three skills and the guard', async () => {
    await writeClaudeCodeRoles(dir, { [CLAUDE]: {}, [ROLES]: {} });
    expect((await readdir(agentsDir())).sort()).toEqual([
      'monoceros-implement.md',
      'monoceros-planner.md',
      'monoceros-review.md',
    ]);
    // Skills are directories, not flat files: that is the shape Claude Code
    // wants, and only that shape can carry supporting files later.
    expect((await readdir(skillsDir())).sort()).toEqual([
      'monoceros-plan',
      'monoceros-review',
      'monoceros-ship',
    ]);
    await expect(skill('monoceros-plan')).resolves.toContain(
      'name: monoceros-plan',
    );
    await expect(
      read(path.join(claudeDir(), 'monoceros-roles', 'guard.mjs')),
    ).resolves.toContain('PreToolUse');
  });

  // Regression from the first real run: `/monoceros-plan` ended with the user
  // saying "let's implement it", and the session could not reach
  // `/monoceros-ship` because the skill blocked model invocation. Only the
  // entry point stays blocked, so a planning dialogue is never started
  // unasked; the two steps after an approved plan have to be callable.
  it('lets the session carry on from an approved plan', async () => {
    await writeClaudeCodeRoles(dir, { [CLAUDE]: {}, [ROLES]: {} });
    expect(await skill('monoceros-plan')).toContain(
      'disable-model-invocation: true',
    );
    expect(await skill('monoceros-ship')).not.toContain(
      'disable-model-invocation',
    );
    expect(await skill('monoceros-review')).not.toContain(
      'disable-model-invocation',
    );
  });

  // Claude Code withholds AskUserQuestion from every subagent, so phase 0
  // cannot run inside one. The planner is told it cannot ask, and the plan
  // skill does the asking in the session instead. If either half goes missing
  // the workflow silently loses its ambiguity gate.
  it('keeps the questions in the session and out of the planner', async () => {
    await writeClaudeCodeRoles(dir, { [CLAUDE]: {}, [ROLES]: {} });
    expect(await agent('monoceros-planner')).toContain(
      'You cannot ask questions',
    );
    expect(await skill('monoceros-plan')).toContain('One question at a time');
  });

  // Phase 0 asks in the user's terms and derives the mechanism itself. The old
  // wording named one technical pair (web app or CLI) as the example of
  // ambiguity, and a real run showed a planner treating that as the question to
  // ask: it asked once about the tech stack, decided the scope on its own, and
  // built a fraction of what the user would have chosen.
  it('keeps phase 0 functional and lets it follow an answer', async () => {
    await writeClaudeCodeRoles(dir, { [CLAUDE]: {}, [ROLES]: {} });
    const plan = await skill('monoceros-plan');
    expect(plan).toContain("Ask in the user's words, never in yours");
    expect(plan).toContain('Follow the answer');
    expect(plan).toContain(
      'Stop when nothing is left that changes what gets built',
    );
    // The mechanism is derived, never asked about.
    expect(plan).toMatch(/Not\s+"which database\?" but/);
    // And no technical either/or is left standing as the model of a good question.
    expect(plan).not.toContain('Web app or CLI changes the shape');
    expect(plan).not.toContain('a web app or a CLI tool');
  });

  // A dev server answers `/` with the page shell whether the app loads or not,
  // so a status check there cannot fail. A real run shipped a white page behind
  // fifteen green tests: a `web/api.js` collided with a Vite proxy keyed on
  // `'/api'`, and nothing fetched the module the page imported. All three roles
  // carry the rule now, because each of them could have caught it.
  it('makes all three roles follow the page references, not just its status', async () => {
    await writeClaudeCodeRoles(dir, { [CLAUDE]: {}, [ROLES]: {} });
    const planner = await agent('monoceros-planner');
    const implement = await agent('monoceros-implement');
    const review = await agent('monoceros-review');
    expect(planner).toContain("follow the\n  page's references");
    expect(implement).toContain('A 200 on `/` proves nothing');
    expect(review).toContain('a 200 on `/` does not settle it');
    for (const body of [planner, implement, review]) {
      expect(body).toMatch(/content type/);
    }
  });

  // Every role wires the guard, because it is the only permission layer that
  // survives Auto Mode - where a subagent's `permissionMode` is ignored.
  it('wires the guard hook into all three agents', async () => {
    await writeClaudeCodeRoles(dir, { [CLAUDE]: {}, [ROLES]: {} });
    for (const [name, role] of [
      ['monoceros-planner', 'planner'],
      ['monoceros-implement', 'implement'],
      ['monoceros-review', 'review'],
    ] as const) {
      const body = await agent(name);
      expect(body).toContain(`command: 'node ${GUARD} ${role}'`);
      expect(body).toContain('matcher: ');
    }
  });

  // The reviewer is read-only twice over: no Write/Edit in its tool list, and
  // a hook that refuses one anyway. The tool list alone says nothing about
  // what Bash can do.
  it('gives the reviewer a read-only tool allowlist', async () => {
    await writeClaudeCodeRoles(dir, { [CLAUDE]: {}, [ROLES]: {} });
    const body = await agent('monoceros-review');
    expect(body).toContain('tools: Read, Grep, Glob, Bash, TodoWrite');
    expect(body).not.toContain('Write,');
  });

  // No subagent delegates: the session orchestrates, which keeps every role at
  // depth 1 and off the subagent nesting limit.
  it('withholds the Agent tool from the delegating roles', async () => {
    await writeClaudeCodeRoles(dir, { [CLAUDE]: {}, [ROLES]: {} });
    expect(await agent('monoceros-planner')).toContain(
      'disallowedTools: Agent',
    );
    expect(await agent('monoceros-implement')).toContain(
      'disallowedTools: Agent',
    );
  });

  it('writes plans under the persisted ~/.claude tree', async () => {
    await writeClaudeCodeRoles(dir, { [CLAUDE]: {}, [ROLES]: {} });
    expect(await agent('monoceros-planner')).toContain(
      `${PLANS}/<app>/<slug>.md`,
    );
    expect(await skill('monoceros-ship')).toContain(PLANS);
  });

  it('puts each role on its own model', async () => {
    await writeClaudeCodeRoles(dir, {
      [CLAUDE]: {},
      [ROLES]: {
        plannerModel: 'opus',
        implementModel: 'sonnet',
        reviewModel: 'claude-opus-5',
      },
    });
    expect(await agent('monoceros-planner')).toContain('\nmodel: opus\n');
    expect(await agent('monoceros-implement')).toContain('\nmodel: sonnet\n');
    expect(await agent('monoceros-review')).toContain(
      '\nmodel: claude-opus-5\n',
    );
  });

  it('warns but still writes when claude-code is missing', async () => {
    await writeClaudeCodeRoles(dir, { [ROLES]: {} });
    // A feature in the yml with nothing on disk is the worse failure.
    expect((await readdir(agentsDir())).length).toBe(3);
  });

  // Effort is a real frontmatter field on a Claude Code subagent, so it goes
  // next to the model. Unset has to drop the whole line: an empty `effort:`
  // is not the same as inheriting the session's, and would be a parse error.
  it('puts each role on its own effort level', async () => {
    await writeClaudeCodeRoles(dir, {
      [CLAUDE]: {},
      [ROLES]: {
        plannerEffort: 'xhigh',
        implementEffort: 'medium',
        reviewEffort: 'high',
      },
    });
    expect(await agent('monoceros-planner')).toContain('\neffort: xhigh\n');
    expect(await agent('monoceros-implement')).toContain('\neffort: medium\n');
    expect(await agent('monoceros-review')).toContain('\neffort: high\n');
  });

  it('drops the effort line when no level is set', async () => {
    await writeClaudeCodeRoles(dir, { [CLAUDE]: {}, [ROLES]: {} });
    for (const name of [
      'monoceros-planner',
      'monoceros-implement',
      'monoceros-review',
    ]) {
      expect(await agent(name)).not.toContain('effort:');
      expect(await agent(name)).not.toContain('{{EFFORT_LINE}}');
    }
  });

  describe('renderRoleTemplate', () => {
    it('drops the model line entirely when no model is set', () => {
      const out = renderRoleTemplate('a\n{{MODEL_LINE}}\nb\n', '');
      // Not an empty line: an empty `model:` is not the same as no `model:`,
      // and the latter is what "unset" has to mean.
      expect(out).toBe('a\nb\n');
    });

    it('fills the model line when one is set', () => {
      expect(renderRoleTemplate('{{MODEL_LINE}}\n', 'haiku')).toBe(
        'model: haiku\n',
      );
    });

    it('expands the plans directory and the guard path', () => {
      expect(renderRoleTemplate('{{PLANS_DIR}} {{GUARD}}', '')).toBe(
        `${PLANS} ${GUARD}`,
      );
    });

    // The tilde form is prose only. Every path a role is told to write is
    // absolute, because an agent expanding `~` itself is how a write ends up
    // outside what the guard allows.
    it('expands the tilde form without eating the absolute one', () => {
      expect(renderRoleTemplate('{{PLANS_DIR_TILDE}}', '')).toBe(
        '~/.claude/plans',
      );
    });
  });
});
