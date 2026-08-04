import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderRoleTemplate } from '../src/create/claude-code-roles.js';

/**
 * The guard is the whole permission layer for the three roles: Claude Code has
 * no per-tool glob rules, and a subagent's `permissionMode` is ignored
 * outright when the session runs in Auto Mode, which is the claude-code
 * feature's own default. So it is exercised as a real process against real
 * hook JSON, not asserted on as a string.
 */

const PLANS = '/home/node/.claude/plans';

let dir: string;
let guard: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'monoceros-guard-'));
  guard = path.join(dir, 'guard.mjs');
  const src = path.join(
    fileURLToPath(
      new URL('../templates/claude-code-roles/guard.mjs', import.meta.url),
    ),
  );
  await writeFile(guard, renderRoleTemplate(await readFile(src, 'utf8'), ''));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Feed the guard one PreToolUse event; returns the decision, or null. */
async function decide(
  role: string,
  event: Record<string, unknown>,
): Promise<string | null> {
  const child = execFile('node', [guard, role]);
  child.stdin!.end(JSON.stringify(event));
  const { stdout } = await new Promise<{ stdout: string }>(
    (resolve, reject) => {
      let out = '';
      child.stdout!.on('data', (c: Buffer) => (out += c.toString()));
      child.on('error', reject);
      child.on('close', () => resolve({ stdout: out }));
    },
  );
  if (!stdout.trim()) return null; // no output = defer to the normal flow
  return (
    JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } }
  ).hookSpecificOutput.permissionDecision;
}

const write = (file: string) => ({
  tool_name: 'Write',
  tool_input: { file_path: file },
});
const bash = (command: string) => ({
  tool_name: 'Bash',
  tool_input: { command },
});

describe('claude-code-roles guard', () => {
  describe('planner', () => {
    it('may write its own plan', async () => {
      expect(await decide('planner', write(`${PLANS}/app/x.md`))).toBe(null);
    });

    it('may not write source', async () => {
      expect(
        await decide('planner', write('/workspace/projects/app/server.js')),
      ).toBe('deny');
    });

    // The write rule is the real guard; the bash denylist exists so a redirect
    // or a `sed -i` cannot route straight around it.
    it('may not route around the write rule with a shell redirect', async () => {
      expect(await decide('planner', bash('echo x > server.js'))).toBe('deny');
      expect(await decide('planner', bash('sed -i s/a/b/ server.js'))).toBe(
        'deny',
      );
      expect(await decide('planner', bash('cat foo | tee server.js'))).toBe(
        'deny',
      );
      // A redirect that names a file is still a write, whichever fd it uses.
      expect(await decide('planner', bash('node x.js 2> log.txt'))).toBe(
        'deny',
      );
    });

    // Regression from the first real run: a `>>?\s*\S` redirect rule also
    // matched `2>&1` and `2>/dev/null` and denied sixteen of the planner's
    // probes in a row. Redirecting stderr writes nothing, and a planner that
    // cannot run `ls … 2>&1` spends its round fighting its own guard.
    it('may redirect stderr, which writes nothing', async () => {
      for (const c of [
        'ls -la /home/node/.claude/plans 2>&1',
        'npm view express version 2>&1 | tail -3',
        'node --test /workspaces/app 2>&1 | tail -12',
        'cat /home/node/.gitconfig 2>/dev/null',
        'monoceros-ctl --help 2>&1 | head -40',
        'git -C /workspaces/app rev-parse --git-dir 2>&1',
      ]) {
        expect(await decide('planner', bash(c)), c).toBe(null);
      }
    });

    // Regression from a review run: the reviewer had a read-only probe refused
    // because the arrow in its curl format string looked like a redirect. A
    // `>` inside a quoted argument is an argument.
    it('may carry a > inside a quoted argument', async () => {
      for (const c of [
        `curl -s -X DELETE http://localhost:3000/api/todos/abc -w ' -> %{http_code}\\n'`,
        `node -e "console.log(1 > 0)"`,
        `psql "$POSTGRES_URL" -c 'select 1 where 2 > 1'`,
      ]) {
        expect(await decide('planner', bash(c)), c).toBe(null);
        expect(await decide('review', bash(c)), c).toBe(null);
      }
    });

    // Fixing the arrow must not open the redirect it was hiding behind, and
    // `&>` writes just as much as `>` does.
    it('still sees a redirect next to a quoted argument', async () => {
      for (const c of [
        `curl -s http://x -w ' -> %{http_code}' > out.txt`,
        `node -e "console.log(1)" > out.txt`,
        `node x.js &> log.txt`,
        `node x.js &>> log.txt`,
      ]) {
        expect(await decide('planner', bash(c)), c).toBe('deny');
      }
    });

    it('may still read and probe', async () => {
      expect(await decide('planner', bash('grep -rn foo src'))).toBe(null);
      expect(await decide('planner', bash('command -v monoceros-ctl'))).toBe(
        null,
      );
      expect(
        await decide('planner', bash('gh issue view 87 --json title')),
      ).toBe(null);
    });
  });

  describe('implement', () => {
    it('may write source', async () => {
      expect(
        await decide('implement', write('/workspace/projects/app/server.js')),
      ).toBe(null);
    });

    it('may not edit the plan it is measured against', async () => {
      expect(await decide('implement', write(`${PLANS}/app/x.md`))).toBe(
        'deny',
      );
    });

    // A path that walks back into the plans directory resolves to the same
    // place, so the check has to be on the resolved path, not the string.
    it('may not reach the plan through a relative path', async () => {
      expect(await decide('implement', write(`${PLANS}/app/../app/x.md`))).toBe(
        'deny',
      );
    });

    it('may commit but never push or publish', async () => {
      expect(await decide('implement', bash('git commit -m "x"'))).toBe(null);
      expect(await decide('implement', bash('git push origin main'))).toBe(
        'deny',
      );
      expect(await decide('implement', bash('npm publish'))).toBe('deny');
      expect(await decide('implement', bash('gh pr create --fill'))).toBe(
        'deny',
      );
    });

    it('may run its acceptance command', async () => {
      expect(
        await decide('implement', bash('pnpm vitest run test/foo.test.ts')),
      ).toBe(null);
    });
  });

  describe('review', () => {
    it('may not write anything at all', async () => {
      expect(
        await decide('review', write('/workspace/projects/app/server.js')),
      ).toBe('deny');
      expect(await decide('review', write(`${PLANS}/app/x.md`))).toBe('deny');
    });

    it('may not move the thing it is judging', async () => {
      expect(await decide('review', bash('git commit -m "fix"'))).toBe('deny');
      expect(await decide('review', bash('git checkout -- .'))).toBe('deny');
    });

    it('may run the acceptance command and read the diff', async () => {
      expect(await decide('review', bash('pnpm test'))).toBe(null);
      expect(await decide('review', bash('git diff'))).toBe(null);
      expect(await decide('review', bash('git status --porcelain'))).toBe(null);
    });
  });

  // A guard that blocks everything looks exactly like a broken agent, so
  // anything it does not understand defers rather than denies.
  describe('defers rather than denying', () => {
    it('on an unknown role', async () => {
      expect(await decide('nonsense', write('/anything'))).toBe(null);
    });

    it('on unparseable input', async () => {
      const child = execFile('node', [guard, 'review']);
      child.stdin!.end('not json');
      const code = await new Promise<number>((resolve) =>
        child.on('close', (c) => resolve(c ?? 1)),
      );
      expect(code).toBe(0);
    });

    it('on a tool it has no rule for', async () => {
      expect(
        await decide('review', { tool_name: 'Read', tool_input: {} }),
      ).toBe(null);
    });
  });
});
