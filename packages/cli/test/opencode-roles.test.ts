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
    // …and the delegation targets match the prefixed agent names, or the
    // planner would call subagents that do not exist.
    const planner = await read(path.join(agentsDir(), 'monoceros-planner.md'));
    expect(planner).toContain('subagent_type: "monoceros-implement"');
    expect(planner).toContain('subagent_type: "monoceros-review"');
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
    // Permissions need the absolute path (it is outside the workspace, so
    // external_directory is checked against it); the prose reads better with ~.
    expect(planner).toContain(`edit: { '*': deny, '${PLANS}/*': allow }`);
    expect(planner).toContain(`external_directory: { '${PLANS}/*': allow }`);
    expect(planner).toContain('~/.local/share/opencode/plans/<slug>.md');
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
