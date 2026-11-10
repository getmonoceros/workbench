import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { render } from '../src/create/agent-roles.js';

/**
 * The guard is the permission layer for the roles in Claude Code and Copilot:
 * neither can say "may write the plan file and nothing else" in an agent, and
 * Claude Code ignores a subagent's `permissionMode` in Auto Mode, the
 * claude-code feature's own default. So it is exercised as a real process
 * against real hook JSON, not asserted on as a string.
 */

const ROLES_DIR = '/workspaces/acme/.monoceros/agent-roles';
const PLANS = `${ROLES_DIR}/plans`;

let dir: string;
let guard: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'monoceros-guard-'));
  guard = path.join(dir, 'guard.mjs');
  const src = fileURLToPath(
    new URL('../templates/agent-roles/guard.mjs', import.meta.url),
  );
  await writeFile(
    guard,
    render(await readFile(src, 'utf8'), {
      ROLES_DIR,
      PLANS_DIR: PLANS,
      GUARD: `${ROLES_DIR}/guard.mjs`,
    }),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], input: string): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = execFile('node', [guard, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr!.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin!.end(input);
  });
}

/** Feed the guard one Claude Code PreToolUse event; the decision, or null. */
async function decide(
  role: string,
  event: Record<string, unknown>,
): Promise<string | null> {
  const { stdout } = await run([role], JSON.stringify(event));
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

describe('agent-roles guard', () => {
  describe('planner', () => {
    it('may write its own plan', async () => {
      expect(await decide('planner', write(`${PLANS}/app/x.md`))).toBe(null);
    });

    it('may not write source, or the guard next to the plans', async () => {
      expect(
        await decide('planner', write('/workspaces/acme/projects/app/x.js')),
      ).toBe('deny');
      expect(await decide('planner', write(`${ROLES_DIR}/guard.mjs`))).toBe(
        'deny',
      );
    });

    // The write rule is the real guard; the bash denylist exists so a redirect
    // or a `sed -i` cannot route straight around it.
    it('may not route around the write rule with a shell redirect', async () => {
      for (const c of [
        'echo x > server.js',
        'sed -i s/a/b/ server.js',
        'cat foo | tee server.js',
        'node x.js 2> log.txt',
      ]) {
        expect(await decide('planner', bash(c)), c).toBe('deny');
      }
    });

    // Regression from the first real run: the redirect rule also matched
    // `2>&1` and `2>/dev/null` and denied sixteen of the planner's probes in a
    // row. Redirecting stderr writes nothing.
    it('may redirect stderr, which writes nothing', async () => {
      for (const c of [
        `ls -la ${PLANS} 2>&1`,
        'npm view express version 2>&1 | tail -3',
        'cat /home/node/.gitconfig 2>/dev/null',
        'monoceros-ctl --help 2>&1 | head -40',
      ]) {
        expect(await decide('planner', bash(c)), c).toBe(null);
      }
    });

    // Regression from a review run: the arrow in a curl format string looked
    // like a redirect. A `>` inside a quoted argument is an argument.
    it('may carry a > inside a quoted argument', async () => {
      for (const c of [
        `curl -s -X DELETE http://localhost:3000/api/todos/abc -w ' -> %{http_code}\\n'`,
        `node -e "console.log(1 > 0)"`,
      ]) {
        expect(await decide('planner', bash(c)), c).toBe(null);
        expect(await decide('reviewer', bash(c)), c).toBe(null);
      }
    });

    it('still sees a redirect next to a quoted argument', async () => {
      for (const c of [
        `curl -s http://x -w ' -> %{http_code}' > out.txt`,
        `node x.js &> log.txt`,
        `node x.js &>> log.txt`,
      ]) {
        expect(await decide('planner', bash(c)), c).toBe('deny');
      }
    });

    // Regression from a review run: saving the acceptance output to the
    // scratchpad was refused as a write. /tmp is outside the workspace.
    it('may redirect into /tmp, and only into /tmp', async () => {
      for (const role of ['planner', 'reviewer']) {
        for (const c of [
          'npm test > /tmp/claude-1000/scratchpad/run.txt 2>&1',
          'npm test >>/tmp/run.txt',
        ]) {
          expect(await decide(role, bash(c)), `${role}: ${c}`).toBe(null);
        }
        for (const c of ['npm test > /tmpfile', 'npm test > tmp/run.txt']) {
          expect(await decide(role, bash(c)), `${role}: ${c}`).toBe('deny');
        }
      }
    });

    it('may still read and probe', async () => {
      expect(await decide('planner', bash('grep -rn foo src'))).toBe(null);
      expect(await decide('planner', bash('gh issue view 87'))).toBe(null);
    });
  });

  describe('developer', () => {
    it('may write source', async () => {
      expect(
        await decide('developer', write('/workspaces/acme/projects/app/x.js')),
      ).toBe(null);
    });

    it('may not edit the plan it is measured against', async () => {
      expect(await decide('developer', write(`${PLANS}/app/x.md`))).toBe(
        'deny',
      );
      expect(await decide('developer', write(`${PLANS}/app/../app/x.md`))).toBe(
        'deny',
      );
    });

    // The acceptance script sits next to the plan and is just as fixed; the
    // reviewer only runs it.
    it('may not edit the acceptance script, which the reviewer may run', async () => {
      const script = `${PLANS}/app/x.acceptance.sh`;
      expect(await decide('developer', write(script))).toBe('deny');
      expect(await decide('developer', bash(`sed -i s/1/0/ ${script}`))).toBe(
        'deny',
      );
      expect(await decide('reviewer', bash(`bash ${script}`))).toBe(null);
      expect(await decide('planner', write(script))).toBe(null);
    });

    // The guard sits next to the plans, in the workspace the developer may
    // otherwise write anywhere in. One edit would switch it off.
    it('may not edit the guard', async () => {
      expect(await decide('developer', write(`${ROLES_DIR}/guard.mjs`))).toBe(
        'deny',
      );
    });

    // Regression from a real run: the developer wrote every file through the
    // shell (`cat > … <<'EOF'`, a python replace), where only the Write/Edit
    // rule held the plans. Reading the plan through the shell stays fine.
    it('may not edit the plan through the shell either', async () => {
      for (const c of [
        `cat > ${PLANS}/app/x.md <<'EOF'\nnew plan\nEOF`,
        `python3 - <<'EOF'\np='${PLANS}/app/x.md'\nopen(p,'w').write('x')\nEOF`,
        `sed -i s/a/b/ ../../.monoceros/agent-roles/plans/app/x.md`,
        `rm ${ROLES_DIR}/guard.mjs`,
      ]) {
        expect(await decide('developer', bash(c)), c).toBe('deny');
      }
      for (const c of [
        `sed -n 1,60p ${PLANS}/app/x.md`,
        `cat ${PLANS}/app/x.md 2>&1 | head -40`,
        `cat > api/src/x.js <<'EOF'\nexport {};\nEOF`,
      ]) {
        expect(await decide('developer', bash(c)), c).toBe(null);
      }
    });

    it('may commit but never push or publish', async () => {
      expect(await decide('developer', bash('git commit -m "x"'))).toBe(null);
      for (const c of [
        'git push origin main',
        'npm publish',
        'gh pr create --fill',
      ]) {
        expect(await decide('developer', bash(c)), c).toBe('deny');
      }
    });
  });

  describe('reviewer', () => {
    it('may not write anything at all', async () => {
      expect(
        await decide('reviewer', write('/workspaces/acme/projects/app/x.js')),
      ).toBe('deny');
      expect(await decide('reviewer', write(`${PLANS}/app/x.md`))).toBe('deny');
    });

    it('may not move the thing it is judging', async () => {
      expect(await decide('reviewer', bash('git commit -m "fix"'))).toBe(
        'deny',
      );
      expect(await decide('reviewer', bash('git checkout -- .'))).toBe('deny');
    });

    it('may run the tests and read the diff', async () => {
      for (const c of ['pnpm test', 'git diff origin/main', 'git status']) {
        expect(await decide('reviewer', bash(c)), c).toBe(null);
      }
    });
  });

  // Copilot sends the same PascalCase event with its own tool spellings, reads
  // a flat decision, and denies on exit code 2.
  describe('copilot', () => {
    const copilot = (role: string, event: Record<string, unknown>) =>
      run([role, 'copilot'], JSON.stringify(event));

    it('denies with a flat decision and exit code 2', async () => {
      const out = await copilot('reviewer', {
        tool_name: 'Edit',
        tool_input: { path: '/workspaces/acme/projects/app/x.js' },
      });
      expect(out.code).toBe(2);
      expect(JSON.parse(out.stdout)).toMatchObject({
        permissionDecision: 'deny',
      });
      expect(out.stderr).toContain('read-only');
    });

    it('reads the path from Copilot tool arguments, also as a JSON string', async () => {
      const allowed = await copilot('planner', {
        tool_name: 'create',
        tool_input: JSON.stringify({ path: `${PLANS}/app/x.md` }),
      });
      expect(allowed.code).toBe(0);
      expect(allowed.stdout).toBe('');
      const denied = await copilot('planner', {
        tool_name: 'create',
        tool_input: JSON.stringify({ path: '/workspaces/acme/projects/x.js' }),
      });
      expect(denied.code).toBe(2);
    });

    it('checks every file a patch touches', async () => {
      const patch = [
        '*** Begin Patch',
        `*** Update File: ${PLANS}/app/x.md`,
        '*** Update File: /workspaces/acme/projects/app/x.js',
        '*** End Patch',
      ].join('\n');
      const out = await copilot('planner', {
        tool_name: 'apply_patch',
        tool_input: { input: patch },
      });
      expect(out.code).toBe(2);
    });

    // Regression from a real run with gpt-6-astra: Copilot passed the patch as
    // bare text, the guard dropped it as unparseable JSON, found no file, and
    // refused the planner its own plan file twice.
    it('reads a patch handed over as bare text', async () => {
      const patch = (file: string) =>
        `*** Begin Patch\n*** Add File: ${file}\n+# plan\n*** End Patch`;
      const allowed = await copilot('planner', {
        tool_name: 'apply_patch',
        tool_input: patch(`${PLANS}/demo-app/x.md`),
      });
      expect(allowed.code).toBe(0);
      expect(allowed.stdout).toBe('');
      const denied = await copilot('planner', {
        tool_name: 'apply_patch',
        tool_input: patch('/workspaces/acme/projects/demo-app/x.js'),
      });
      expect(denied.code).toBe(2);
    });

    it('checks where a patch moves a file to', async () => {
      const out = await copilot('developer', {
        tool_name: 'apply_patch',
        tool_input: [
          '*** Begin Patch',
          '*** Update File: /workspaces/acme/projects/app/x.md',
          `*** Move to: ${PLANS}/app/x.md`,
          '*** End Patch',
        ].join('\n'),
      });
      expect(out.code).toBe(2);
    });

    it('applies the shell rules to its shell tool', async () => {
      const out = await copilot('developer', {
        tool_name: 'bash',
        tool_input: { command: 'git push' },
      });
      expect(out.code).toBe(2);
    });
  });

  // OpenCode's plugin hands the guard the tool call with OpenCode's own
  // spellings and reads the same flat decision and exit code as Copilot.
  describe('opencode', () => {
    const opencode = (role: string, tool: string, args: unknown) =>
      run(
        [role, 'opencode'],
        JSON.stringify({ tool_name: tool, tool_input: args }),
      );

    it('reads filePath from write and edit', async () => {
      const allowed = await opencode('planner', 'write', {
        filePath: `${PLANS}/app/x.md`,
        content: '# plan',
      });
      expect(allowed.code).toBe(0);
      const denied = await opencode('planner', 'edit', {
        filePath: '/workspaces/acme/projects/app/x.js',
        oldString: 'a',
        newString: 'b',
      });
      expect(denied.code).toBe(2);
      expect(JSON.parse(denied.stdout)).toMatchObject({
        permissionDecision: 'deny',
      });
    });

    it('reads the files of an apply_patch from patchText', async () => {
      const out = await opencode('developer', 'apply_patch', {
        patchText: `*** Begin Patch\n*** Update File: ${PLANS}/app/x.md\n*** End Patch`,
      });
      expect(out.code).toBe(2);
    });
  });

  // A heredoc body is input to the command reading it, so a `>` in it is no
  // redirect - unless that command is a shell.
  describe('heredocs', () => {
    // Regression from a Copilot review run: the reviewer's check of the page's
    // resources was refused over the `>` in `[^>]`, and never ran.
    it('lets the reviewer feed a script to node', async () => {
      const script = [
        "node --input-type=module <<'JS'",
        "const html = await (await fetch('http://localhost:5173')).text();",
        'const refs = [...html.matchAll(/<(?:script|link)\\b[^>]*\\b(?:src|href)="([^"]+)"/g)];',
        'if (refs.length > 0) console.log(refs.length);',
        'JS',
      ].join('\n');
      expect(await decide('reviewer', bash(script))).toBe(null);
    });

    it('still sees a redirect around a heredoc or inside one fed to a shell', async () => {
      for (const c of [
        "cat > report.txt <<'EOF'\nx\nEOF",
        "cat <<'EOF' > report.txt\nx\nEOF",
        "bash <<'EOF'\necho x > report.txt\nEOF",
        'sh <<EOF\necho x >> report.txt\nEOF',
      ]) {
        expect(await decide('reviewer', bash(c)), c).toBe('deny');
      }
    });

    it('keeps the planner off heredocs entirely', async () => {
      expect(
        await decide('planner', bash("node <<'JS'\nconsole.log(1)\nJS")),
      ).toBe('deny');
    });
  });

  // A guard that blocks everything looks exactly like a broken agent, so
  // anything it does not understand defers rather than denies.
  describe('defers rather than denying', () => {
    it('on an unknown role', async () => {
      expect(await decide('nonsense', write('/anything'))).toBe(null);
    });

    it('on unparseable input', async () => {
      expect((await run(['reviewer'], 'not json')).code).toBe(0);
    });

    it('on a tool it has no rule for', async () => {
      expect(
        await decide('reviewer', { tool_name: 'Read', tool_input: {} }),
      ).toBe(null);
    });
  });
});
