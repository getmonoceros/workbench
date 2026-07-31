import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  renderRoleTemplate,
  writeOpencodeRoles,
} from '../src/create/opencode-roles.js';

const OPENCODE = 'ghcr.io/getmonoceros/monoceros-features/opencode:1';
const ROLES = 'ghcr.io/getmonoceros/monoceros-features/opencode-roles:1';

const PLANS = '/home/node/.local/share/opencode/plans';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'monoceros-roles-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const agentsDir = () => path.join(dir, 'home', '.config', 'opencode', 'agents');
const commandsDir = () =>
  path.join(dir, 'home', '.config', 'opencode', 'commands');

const read = (p: string) => readFile(p, 'utf8');

describe('writeOpencodeRoles', () => {
  it('is a no-op without the opencode-roles feature', async () => {
    await writeOpencodeRoles(dir, { [OPENCODE]: { model: 'x/y' } });
    await expect(readdir(agentsDir())).rejects.toThrow();
  });

  it('writes the three agents and the three commands', async () => {
    await writeOpencodeRoles(dir, { [OPENCODE]: {}, [ROLES]: {} });
    expect((await readdir(agentsDir())).sort()).toEqual([
      'monoceros-implement.md',
      'monoceros-planner.md',
      'monoceros-review.md',
    ]);
    expect((await readdir(commandsDir())).sort()).toEqual([
      'monoceros-plan.md',
      'monoceros-review.md',
      'monoceros-ship.md',
    ]);
  });

  // The names carry a prefix on purpose: OpenCode's agents and commands are a
  // flat global namespace, a custom command silently overrides a built-in one,
  // and `/plan` or an `implement` agent is exactly what a user writes too.
  it('namespaces every agent and command it ships', async () => {
    await writeOpencodeRoles(dir, { [OPENCODE]: {}, [ROLES]: {} });
    for (const d of [agentsDir(), commandsDir()]) {
      for (const f of await readdir(d)) {
        expect(f.startsWith('monoceros-'), f).toBe(true);
      }
    }
    // …and the task permission names the prefixed agents, so the capability
    // matches the names even though the planner is told not to use it.
    const planner = await read(path.join(agentsDir(), 'monoceros-planner.md'));
    expect(planner).toContain(
      "task: { '*': deny, 'monoceros-implement': allow, 'monoceros-review': allow }",
    );
  });

  it('gives each role its own model from its own option', async () => {
    await writeOpencodeRoles(dir, {
      [OPENCODE]: { model: 'fallback/model' },
      [ROLES]: {
        plannerModel: 'a/planner',
        implementModel: 'b/implement',
        reviewModel: 'c/review',
      },
    });
    expect(
      await read(path.join(agentsDir(), 'monoceros-planner.md')),
    ).toContain('model: a/planner');
    expect(
      await read(path.join(agentsDir(), 'monoceros-implement.md')),
    ).toContain('model: b/implement');
    expect(await read(path.join(agentsDir(), 'monoceros-review.md'))).toContain(
      'model: c/review',
    );
  });

  it("falls back to the opencode feature's model for the roles left empty", async () => {
    await writeOpencodeRoles(dir, {
      [OPENCODE]: { model: 'fallback/model' },
      [ROLES]: { plannerModel: 'a/planner' },
    });
    expect(
      await read(path.join(agentsDir(), 'monoceros-planner.md')),
    ).toContain('model: a/planner');
    for (const role of ['monoceros-implement', 'monoceros-review']) {
      expect(await read(path.join(agentsDir(), `${role}.md`))).toContain(
        'model: fallback/model',
      );
    }
  });

  it('writes no model line at all when nothing is set anywhere', async () => {
    await writeOpencodeRoles(dir, { [OPENCODE]: {}, [ROLES]: {} });
    for (const f of await readdir(agentsDir())) {
      const body = await read(path.join(agentsDir(), f));
      // No `model:` key and no leftover placeholder: an agent without one runs
      // on the session's model, which is what "unset" has to mean.
      expect(body, f).not.toMatch(/^model:/m);
      expect(body, f).not.toContain('{{');
      // The frontmatter must still be well-formed after dropping the line.
      expect(body.startsWith('---\n')).toBe(true);
      expect(body.split('---').length).toBeGreaterThanOrEqual(3);
    }
  });

  it('renders the plans directory in both spellings, and leaves no placeholder', async () => {
    await writeOpencodeRoles(dir, { [OPENCODE]: {}, [ROLES]: {} });
    const planner = await read(path.join(agentsDir(), 'monoceros-planner.md'));
    // external_directory is asked with the canonical absolute path, so that
    // rule keeps the absolute spelling; the prose reads better with ~. The
    // edit/write pair needs both spellings and has its own test below.
    expect(planner).toContain(`external_directory: { '${PLANS}/*': allow }`);
    expect(planner).toContain('~/.local/share/opencode/plans/<app>/<slug>.md');
    for (const d of [agentsDir(), commandsDir()]) {
      for (const f of await readdir(d)) {
        expect(await read(path.join(d, f)), f).not.toContain('{{');
      }
    }
  });

  it('says the files are regenerated and how to keep an edit', async () => {
    await writeOpencodeRoles(dir, { [OPENCODE]: {}, [ROLES]: {} });
    for (const d of [agentsDir(), commandsDir()]) {
      for (const f of await readdir(d)) {
        const body = await read(path.join(d, f));
        expect(body, f).toContain('Generated by `monoceros apply`');
        expect(body, f).toContain('.opencode/');
      }
    }
  });

  // Phase 0. The failure it prevents was measured: a planner wrote a 229-line
  // plan for a web app when "Todo-App" could as well have meant a CLI tool, and
  // only stated the assumption afterwards. Batched questions get one vague
  // answer, so the protocol is one at a time with a recommended default - and
  // nothing that the repo or the environment can answer is asked at all.
  it('makes the planner grill the task before it writes a plan', async () => {
    await writeOpencodeRoles(dir, { [OPENCODE]: {}, [ROLES]: {} });
    const planner = await read(path.join(agentsDir(), 'monoceros-planner.md'));

    expect(planner).toContain('Phase 0');
    expect(planner).toContain('**One question at a time.**');
    expect(planner).toContain('recommended answer');
    expect(planner).toContain('**Never ask what you can read.**');
    expect(planner).toContain('At most five questions');
    // Bounded to what changes the plan, and skipped entirely when the task
    // already carries its own acceptance criteria - otherwise this becomes the
    // next round of pointless prompting.
    expect(planner).toContain('shape of the plan');
    expect(planner).toContain('Ask nothing at all when the task is already');
    // The answers have to survive the dialogue: they land in the plan.
    expect(planner).toMatch(/Assumptions.* section/s);
    // Phase 0 sits after loading and exploring, so it does not ask what the
    // code answers, and before the plan is written.
    expect(planner.indexOf('## 2. Explore')).toBeLessThan(
      planner.indexOf('## 3. Phase 0'),
    );
    expect(planner.indexOf('## 3. Phase 0')).toBeLessThan(
      planner.indexOf('## 4. Write the plan'),
    );
  });

  it('has the plan command ask for phase 0 explicitly', async () => {
    await writeOpencodeRoles(dir, { [OPENCODE]: {}, [ROLES]: {} });
    const cmd = await read(path.join(commandsDir(), 'monoceros-plan.md'));
    expect(cmd).toContain('phase 0');
    expect(cmd).toContain('one question at a time');
    expect(cmd).toContain('If it is already unambiguous');
  });

  // The path the builder had to type was 40 characters of boilerplate. The
  // commands now resolve a bare slug themselves, in shell, before the model
  // sees anything: opencode substitutes $ARGUMENTS first and runs the !`…`
  // blocks second, so this is deterministic rather than the model guessing.
  it('resolves a bare slug in the ship and review commands', async () => {
    await writeOpencodeRoles(dir, { [OPENCODE]: {}, [ROLES]: {} });
    for (const name of ['monoceros-ship', 'monoceros-review']) {
      const cmd = await read(path.join(commandsDir(), `${name}.md`));
      // The resolver runs as one shell block and must not contain a backtick,
      // or opencode's !`…` regex would end it early.
      const block = cmd.match(/!`([^`]+)`/);
      expect(block, name).not.toBeNull();
      const sh = block![1]!;
      expect(sh).toContain('$ARGUMENTS');
      // A real path wins, then the app folder, then a unique match anywhere.
      expect(sh).toContain('projects/');
      expect(sh).toContain('$root/$app/$p');
      expect(sh).toContain('find');
      // Every unhappy outcome is named, so the agent can refuse instead of
      // inventing a plan.
      expect(sh).toContain('NOT FOUND');
      expect(sh).toContain('AMBIGUOUS');
      expect(sh).toContain('NO ARGUMENT GIVEN');
      // …and the prompt tells it to refuse on exactly those.
      expect(cmd).toContain('NOT FOUND, AMBIGUOUS or NO ARGUMENT');
      expect(cmd).toMatch(/do not touch any\s+files/);
    }
  });

  it('scopes plans per app, in the planner and in the plan command', async () => {
    await writeOpencodeRoles(dir, { [OPENCODE]: {}, [ROLES]: {} });
    const planner = await read(path.join(agentsDir(), 'monoceros-planner.md'));
    expect(planner).toContain('~/.local/share/opencode/plans/<app>/<slug>.md');
    const cmd = await read(path.join(commandsDir(), 'monoceros-plan.md'));
    // The app comes from the working directory, resolved in shell…
    expect(cmd).toMatch(/!`pwd \| sed[^`]*projects[^`]*`/);
    // …and the planner is told what to do when there is no app in the cwd,
    // instead of writing into the root and losing the slug-only lookup.
    expect(cmd).toMatch(/If the\s+line above is empty/);
    expect(cmd).toContain('say which one you picked');
  });

  // The bug this closes locked the planner out of its own plans directory:
  // the edit tool asks with the path RELATIVE to the worktree, the plans dir
  // sits outside it, so the relative form starts with `../..` and an absolute
  // pattern never matches. Only `edit deny *` was left, and every write was
  // refused. Both spellings have to be covered - and the implementer's deny
  // has the same problem in reverse, or it could edit the plan it is measured
  // against.
  it('covers both path spellings in the plans permissions', async () => {
    await writeOpencodeRoles(dir, { [OPENCODE]: {}, [ROLES]: {} });
    const planner = await read(path.join(agentsDir(), 'monoceros-planner.md'));
    const impl = await read(path.join(agentsDir(), 'monoceros-implement.md'));
    for (const perm of ['edit', 'write']) {
      expect(planner, perm).toContain(
        `${perm}: { '*': deny, '${PLANS}/*': allow, '*/.local/share/opencode/plans/*': allow }`,
      );
      expect(impl, perm).toContain(
        `${perm}: { '*': allow, '${PLANS}/*': deny, '*/.local/share/opencode/plans/*': deny }`,
      );
    }
  });

  // Same wildcard semantics opencode uses (`*` becomes `.*`, spanning
  // slashes), so this pins the property rather than the string: the pattern
  // has to match what a tool actually asks with, and nothing else.
  it('the plans pattern matches both spellings and stays narrow', async () => {
    const toRe = (pattern: string) =>
      new RegExp(
        '^' +
          pattern
            .replace(/[.+^${}()|[\]\\]/g, (c) => '\\' + c)
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') +
          '$',
      );
    const pattern = '*/.local/share/opencode/plans/*';
    // What the tools ask with:
    expect(toRe(pattern).test(`${PLANS}/todo-app/x.md`)).toBe(true);
    expect(
      toRe(pattern).test(
        '../../../../home/node/.local/share/opencode/plans/todo-app/x.md',
      ),
    ).toBe(true);
    // What must stay outside it:
    expect(toRe(pattern).test('src/server.js')).toBe(false);
    expect(
      toRe(pattern).test(
        '../../../../home/node/.local/share/opencode/auth.json',
      ),
    ).toBe(false);
  });

  // The workbench briefing already says it ("Chat with the user in their
  // language", AGENTS.md), but a several-hundred-line English system prompt
  // outweighs a briefing chapter: the planner answered a German prompt in
  // English. And the other two roles cannot even tell - their prompt comes from
  // a command and is English, they never see the user's messages. So the plan
  // carries the language, like everything else the roles agree on.
  it('carries the user language in the plan, because only the planner sees it', async () => {
    await writeOpencodeRoles(dir, { [OPENCODE]: {}, [ROLES]: {} });
    const planner = await read(path.join(agentsDir(), 'monoceros-planner.md'));
    const impl = await read(path.join(agentsDir(), 'monoceros-implement.md'));
    const review = await read(path.join(agentsDir(), 'monoceros-review.md'));

    // The field is in the template the planner fills…
    expect(planner).toContain('**Reply to the user in:**');
    expect(planner).toMatch(/only role that ever sees their messages/);
    // …and the plan file itself stays English apart from that field.
    expect(planner).toMatch(/plan \*\*file\*\* stays English/);

    // …and the two roles read it, with a defined fallback.
    for (const [name, body] of [
      ['implement', impl],
      ['review', review],
    ] as const) {
      expect(body, name).toContain('**Reply to the user in**');
      expect(body, name).toMatch(/English when it is missing/);
    }
    // The reviewer must not translate what the planner matches on.
    expect(review).toContain('`PASS`');
    expect(review).toContain('`CHANGES_REQUIRED`');
    expect(review).toMatch(/stay literal/);
  });

  // `<app>/<slug>` resolves from any directory (the resolver tries
  // `$root/$p`), a bare slug only from inside the app - and it is ambiguous
  // when two apps have a plan of the same name.
  it('hands over the two-part plan reference, not a bare slug', async () => {
    await writeOpencodeRoles(dir, { [OPENCODE]: {}, [ROLES]: {} });
    const impl = await read(path.join(agentsDir(), 'monoceros-implement.md'));
    expect(impl).toContain('/monoceros-review todo-app/dark-mode-toggle');
    expect(impl).toMatch(/not the bare slug/);
    expect(impl).toMatch(/resolves from any directory/);
  });

  it('has the implementer restart the app and name the review step', async () => {
    await writeOpencodeRoles(dir, { [OPENCODE]: {}, [ROLES]: {} });
    const impl = await read(path.join(agentsDir(), 'monoceros-implement.md'));

    // Restart, through the tool that cannot hang, and only after the gate.
    expect(impl).toContain('Leave the app running the new code');
    expect(impl).toContain('monoceros-ctl stop <app>');
    expect(impl).toContain('monoceros-ctl start <app>');
    expect(impl).toMatch(/once the acceptance command is green/i);
    // No launch target is a report line, not a reason to improvise a server.
    expect(impl).toMatch(/do not start a server by\s+hand/);

    // The report gained the two parts the run was missing.
    expect(impl).toContain('5. **Running**');
    expect(impl).toContain('6. **Next**');
    expect(impl).toContain('/monoceros-review todo-app/dark-mode-toggle');
    // …and it hands over a URL rather than the fact that tests passed.
    expect(impl).toContain('localhost');
  });

  // The prompt used to contradict its own command: `/monoceros-plan` said "stop,
  // do not delegate" while sections 5 to 8 explained how to drive the chain with
  // `task(...)`. The user runs the steps - one command each - so the planner
  // hands over and stops.
  it('has the planner hand over instead of driving the chain', async () => {
    await writeOpencodeRoles(dir, { [OPENCODE]: {}, [ROLES]: {} });
    const planner = await read(path.join(agentsDir(), 'monoceros-planner.md'));

    expect(planner).toContain('## 5. Hand over and stop');
    // No instructions to call the other roles.
    expect(planner).not.toContain('subagent_type:');
    expect(planner).not.toContain('task_id');
    // It hands over both commands, in order, in the form that resolves anywhere.
    expect(planner).toContain('/monoceros-ship <app>/<slug>');
    expect(planner).toContain('/monoceros-review <app>/<slug>');
    // And the reason, so the model does not "help" by finishing the work.
    expect(planner).toMatch(
      /quietly turned\s+into a finished change is not reviewable/,
    );
    // A failure that comes back is information about the plan, not a repair job.
    expect(planner).toMatch(/adjust the plan/);

    // The command agrees with the prompt now.
    const cmd = await read(path.join(commandsDir(), 'monoceros-plan.md'));
    expect(cmd).toContain('I run the steps');
    expect(cmd).not.toContain('Do not delegate yet');
  });

  it('overwrites its own files on a second apply', async () => {
    await writeOpencodeRoles(dir, {
      [OPENCODE]: {},
      [ROLES]: { plannerModel: 'first/model' },
    });
    await writeOpencodeRoles(dir, {
      [OPENCODE]: {},
      [ROLES]: { plannerModel: 'second/model' },
    });
    const planner = await read(path.join(agentsDir(), 'monoceros-planner.md'));
    expect(planner).toContain('model: second/model');
    expect(planner).not.toContain('first/model');
  });

  it('still writes the roles when the opencode feature is missing', async () => {
    // Wrong, and worth a warning, but writing nothing would leave the builder
    // with a feature in the yml and no explanation on disk.
    await writeOpencodeRoles(dir, { [ROLES]: {} });
    expect((await readdir(agentsDir())).length).toBe(3);
  });
});

describe('renderRoleTemplate', () => {
  it('drops the line, not just the placeholder, when the model is empty', () => {
    const out = renderRoleTemplate(
      'mode: primary\n{{MODEL_LINE}}\nprompt: x\n',
      '',
    );
    expect(out).toBe('mode: primary\nprompt: x\n');
  });

  it('replaces every occurrence of the plans dir, not only the first', () => {
    const out = renderRoleTemplate(
      '{{PLANS_DIR}}/a {{PLANS_DIR}}/b {{PLANS_DIR_TILDE}}/c\n{{MODEL_LINE}}\n',
      'm/m',
    );
    expect(out).toContain(`${PLANS}/a`);
    expect(out).toContain(`${PLANS}/b`);
    expect(out).toContain('~/.local/share/opencode/plans/c');
    expect(out).toContain('model: m/m');
  });
});
