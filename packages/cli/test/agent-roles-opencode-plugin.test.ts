import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { render } from '../src/create/agent-roles.js';

/**
 * The OpenCode plugin that runs guard.mjs, loaded the way OpenCode loads it
 * and driven through its two hooks against the real guard. A live run in a
 * workbench confirmed what the hooks receive: `chat.params` names the agent of
 * a subagent session before its first tool call, and an error thrown from
 * `tool.execute.before` refuses the call with its message shown to the model.
 */

const ROLES_DIR = '/workspaces/acme/.monoceros/agent-roles';
const PLANS = `${ROLES_DIR}/plans`;
const SOURCE = '/workspaces/acme/projects/app/x.js';

type Hooks = {
  'chat.params': (input: { sessionID: string; agent: string }) => Promise<void>;
  'tool.execute.before': (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ) => Promise<void>;
};
type Plugin = (ctx: { directory: string }) => Promise<Hooks>;

let dir: string;

/** Render the plugin against `guard` and import it. */
async function load(guard: string, name: string): Promise<Plugin> {
  const src = fileURLToPath(
    new URL('../templates/agent-roles/opencode-plugin.js', import.meta.url),
  );
  const file = path.join(dir, `${name}.mjs`);
  await writeFile(file, render(await readFile(src, 'utf8'), { GUARD: guard }));
  const mod = (await import(pathToFileURL(file).href)) as {
    AgentRolesGuard: Plugin;
  };
  return mod.AgentRolesGuard;
}

let hooks: Hooks;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'monoceros-oc-plugin-'));
  const guard = path.join(dir, 'guard.mjs');
  const src = fileURLToPath(
    new URL('../templates/agent-roles/guard.mjs', import.meta.url),
  );
  await writeFile(
    guard,
    render(await readFile(src, 'utf8'), {
      ROLES_DIR,
      PLANS_DIR: PLANS,
      GUARD: guard,
    }),
  );
  hooks = await (await load(guard, 'plugin'))({ directory: dir });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const call = (sessionID: string, tool: string, args: unknown) =>
  hooks['tool.execute.before']({ tool, sessionID, callID: 'c1' }, { args });

describe('agent-roles OpenCode plugin', () => {
  it("refuses a role's call with the guard's reason", async () => {
    await hooks['chat.params']({
      sessionID: 'review',
      agent: 'agent-roles-reviewer',
    });
    await expect(
      call('review', 'write', { filePath: SOURCE, content: 'x' }),
    ).rejects.toThrow(/read-only/);
    await expect(
      call('review', 'bash', { command: 'git diff' }),
    ).resolves.toBeUndefined();
  });

  it('lets the planner write its plan and nothing else', async () => {
    await hooks['chat.params']({
      sessionID: 'plan',
      agent: 'agent-roles-planner',
    });
    await expect(
      call('plan', 'write', { filePath: `${PLANS}/app/x.md`, content: '#' }),
    ).resolves.toBeUndefined();
    await expect(
      call('plan', 'edit', {
        filePath: SOURCE,
        oldString: 'a',
        newString: 'b',
      }),
    ).rejects.toThrow(/planner may only write/);
  });

  // The title agent answers first in every session, then the real one.
  it('leaves every other agent alone, and follows the latest one', async () => {
    await hooks['chat.params']({ sessionID: 'main', agent: 'title' });
    await hooks['chat.params']({ sessionID: 'main', agent: 'build' });
    await expect(
      call('main', 'write', { filePath: SOURCE, content: 'x' }),
    ).resolves.toBeUndefined();
    await expect(
      call('unknown-session', 'write', { filePath: SOURCE, content: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('defers when the guard is missing', async () => {
    const plugin = await load(path.join(dir, 'missing.mjs'), 'no-guard');
    const h = await plugin({ directory: dir });
    await h['chat.params']({ sessionID: 's', agent: 'agent-roles-reviewer' });
    await expect(
      h['tool.execute.before'](
        { tool: 'write', sessionID: 's', callID: 'c' },
        { args: { filePath: SOURCE } },
      ),
    ).resolves.toBeUndefined();
  });
});
