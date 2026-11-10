#!/usr/bin/env node
// Monoceros agent-roles: the permission layer for the three roles.
//
// Written into <workspace>/.monoceros/agent-roles/ by `monoceros apply` and
// wired into each role as a PreToolUse hook:
//
//     node {{GUARD}} <role> [<agent>]
//
// <role> is planner, developer or reviewer. <agent> is claude-code (the
// default), copilot or opencode, and only decides how a denial is written
// back: Claude Code reads `hookSpecificOutput`, Copilot reads a flat
// `permissionDecision` and also denies on exit code 2. OpenCode has no hook
// command; its plugin (agent-roles-guard.js, written next to its agents) runs
// this script the same way and turns exit code 2 into a refused tool call.
//
// Why a script and not frontmatter: neither Claude Code nor Copilot can say
// "may write the plan file and nothing else" in an agent definition. Their
// tool lists remove a tool wholesale. And Claude Code's `permissionMode` is
// ignored when the session runs in Auto Mode - the claude-code feature's own
// default. A PreToolUse deny is honoured in every mode, so this is the only
// layer that holds whatever the builder set.
//
// Reads the hook JSON on stdin, writes a decision on stdout. Anything it does
// not recognise defers to the normal permission flow.

import { resolve } from 'node:path';

/** The feature's directory in the workspace: the plans and this script. */
const ROLES_DIR = '{{ROLES_DIR}}';
const PLANS_DIR = '{{PLANS_DIR}}';

/** Shell verbs that leave this machine, denied for every role. */
const EGRESS = [
  /\bgit\s+push\b/,
  /\bgh\s+pr\s+create\b/,
  /\bgh\s+release\b/,
  /\b(npm|pnpm|yarn)\s+publish\b/,
  /\bdocker\s+push\b/,
];

/**
 * Quoted runs, replaced by a space before the redirect rule looks at a
 * command. A `>` inside an argument is an argument.
 *
 * The trade: `bash -c 'echo x > f'` gets through. That is deliberate. This
 * guard stops a role from routing around a write it was just refused, not a
 * role that has decided to hide one.
 */
const QUOTED = /'[^']*'|"[^"]*"/g;

/**
 * A redirect that writes a file, once the quoted parts are out of the way.
 * Four things it has to get right, each of them from a real run:
 *
 *   - `2>&1` and `2>/dev/null` write nothing. The first version denied sixteen
 *     of the planner's probes over them (`ls -la … 2>&1`, `npm view express
 *     2>&1 | tail -3`).
 *   - A `>` inside a quoted argument is not a redirect: a review run had
 *     `curl … -w ' -> %{http_code}'` refused, and `node -e "…1 > 0…"` fails
 *     the same way. Hence QUOTED above, plus the `-`/`=` lookbehind for an
 *     arrow that stands unquoted.
 *   - `&>file` and `&>>file` do write, so the `&` in front must not excuse
 *     them.
 *   - A redirect into `/tmp/` writes outside the workspace, where the
 *     agents keep their scratchpads. A reviewer had `npm test > /tmp/…/run.txt`
 *     refused while saving the acceptance output; it changes nothing it judges.
 *     The `(?!>)` keeps `>>/tmp/…` from matching on its first `>` alone.
 */
const REDIRECT = /(?<![-=])>>?(?!>)\s*(?!&)(?!\/dev\/null\b)(?!\/tmp\/)\S/;

/**
 * A heredoc: the `<<TAG` line, its body, and the closing `TAG` line. The body
 * is input to the command, not shell, so a `>` in it is no redirect: a review
 * run had `node <<'JS' … JS` refused over the `>` in a regular expression, and
 * with it the one check that fetches the page's resources. Except when the
 * command reading the body is a shell, where the body is shell again.
 */
const HEREDOC =
  /(?<!<)<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;
const SHELLS = /^(?:\S*\/)?(?:bash|sh|zsh|dash)\b/;

/** `command` with the body of every heredoc that is not fed to a shell taken out. */
function withoutHeredocBodies(command) {
  return command.replace(HEREDOC, (match, _quote, tag, rest, offset) => {
    const lineStart = command.lastIndexOf('\n', offset) + 1;
    const head = command.slice(lineStart, offset).split(/[;&|]/).pop().trim();
    return SHELLS.test(head) ? match : `<<${tag}${rest}`;
  });
}

/** True when `command` writes a file through a redirect. */
const writesViaRedirect = (command) =>
  REDIRECT.test(withoutHeredocBodies(command).replace(QUOTED, ' '));

/**
 * Mutating verbs denied for the planner. The planner's real guard is the
 * write rule below; this list exists because a shell redirect, a heredoc or
 * `sed -i` would otherwise route straight around it. Same reasoning as the
 * OpenCode denylist, which this mirrors.
 */
const MUTATING = [
  writesViaRedirect,
  /<</,
  /\btee\b/,
  /\b(rm|mv|cp|truncate|chmod|chown|sudo)\s/,
  /\bsed\s+-i/,
  /\bgit\s+(add|commit|checkout|reset|restore|rm)\b/,
  /\b(npm|pnpm|yarn)\s+(install|add|i)\b/,
  /\bpip\s+install\b/,
];

/** Does one entry of a bash rule list (a regex or a predicate) match? */
const matches = (rule, command) =>
  typeof rule === 'function' ? rule(command) : rule.test(command);

/**
 * A shell command that mutates and names the feature's directory. The
 * developer may write anywhere else, so without this its shell is only held
 * to EGRESS. A real run wrote every file with `cat > … <<'EOF'` and changed
 * the rest with a python string replace, and the same move into the plans
 * would have walked past the write rule. The path is matched without the
 * workspace, so a relative `../../.monoceros/agent-roles/plans/…` counts too;
 * a command that only reads the plan names it without mutating and passes.
 */
const mutatesRolesDir = (command) =>
  /\.monoceros\/agent-roles\b/.test(command) &&
  MUTATING.some((rule) => matches(rule, command));

/** Writing git verbs denied for the reviewer, which judges but never moves. */
const WRITING_GIT = [/\bgit\s+(add|commit|checkout|reset|restore|rm|push)\b/];

const RULES = {
  planner: {
    // Writes the plan and nothing else. Source code is out of bounds: the
    // plan is the contract, and a planner that edits code has stopped being
    // one.
    writes: (file) =>
      inside(file, PLANS_DIR)
        ? null
        : `The planner may only write under ${PLANS_DIR}. Do not edit source: put the change into the plan and let the developer make it.`,
    bash: [...EGRESS, ...MUTATING],
    bashReason:
      'The planner does not mutate anything. If a write was refused, report which one instead of routing around it with a shell command.',
  },
  developer: {
    // May change everything but what it is measured against: the plans, and
    // this script next to them, which would otherwise be one edit away from
    // switching itself off.
    writes: (file) =>
      inside(file, ROLES_DIR)
        ? `The plan is what your work is measured against and is not yours to edit, and neither is anything else under ${ROLES_DIR}. If the plan is wrong, stop and report that instead.`
        : null,
    // The same rule for the shell, with the same answer as a refused write.
    shellWrites: mutatesRolesDir,
    bash: EGRESS,
    bashReason:
      'What leaves this machine is the user’s decision. Commit if you like, never push or publish.',
  },
  reviewer: {
    // Read-only. The tool list in the agent already withholds writing; this
    // is the second lock, because a tool list says nothing about what the
    // shell can do.
    writes: () =>
      'The reviewer is read-only. Report the finding instead of fixing it.',
    bash: [
      ...EGRESS,
      ...WRITING_GIT,
      writesViaRedirect,
      /\bsed\s+-i/,
      /\btee\b/,
    ],
    bashReason:
      'The reviewer must not change the thing it is judging. Run the acceptance command, read the diff, and report.',
  },
};

/** Tool names that write a file, as Claude Code, Copilot and OpenCode spell them. */
const WRITE_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'create',
  'edit',
  'write',
  'str_replace_editor',
  'apply_patch',
]);
/** Tool names that run a shell command. */
const SHELL_TOOLS = new Set(['Bash', 'bash', 'powershell']);

/** Is `file` the directory `dir` or something under it? */
function inside(file, dir) {
  if (!file) return false;
  const abs = resolve(file);
  return abs === dir || abs.startsWith(`${dir}/`);
}

/**
 * The files a write tool call touches. One path for an ordinary edit; for a
 * patch, every file its headers name. An empty list means we could not tell,
 * which is treated like a write to an unknown place. OpenCode spells the path
 * `filePath` and the patch `patchText`, with paths relative to the project,
 * which is why its plugin runs this script from the project directory.
 */
function writtenFiles(input) {
  const single =
    input.file_path ?? input.path ?? input.notebook_path ?? input.filePath;
  if (typeof single === 'string') return [single];
  const patch = input.patch ?? input.input ?? input.patchText;
  if (typeof patch === 'string') {
    return [
      ...patch.matchAll(
        /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm,
      ),
    ].map((m) => m[1].trim());
  }
  return [];
}

function deny(reason, agent) {
  if (agent === 'copilot' || agent === 'opencode') {
    // Copilot merges stdout JSON into the decision and denies on exit 2, so
    // both carry the same answer. The OpenCode plugin reads the same two.
    process.stdout.write(
      JSON.stringify({
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      }),
    );
    process.stderr.write(reason);
    process.exit(2);
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

const role = process.argv[2];
const agent = process.argv[3] ?? 'claude-code';
const rules = RULES[role];
// An unknown role means a stale or hand-edited hook line. Defer rather than
// deny: a guard that blocks everything looks exactly like a broken agent.
if (!rules) process.exit(0);

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let event;
try {
  event = JSON.parse(raw);
} catch {
  process.exit(0); // unparseable input is not a permission decision
}

const tool = event?.tool_name ?? event?.toolName;
let input = event?.tool_input ?? event?.toolArgs ?? {};
if (typeof input === 'string') {
  // Copilot hands tool arguments over as a JSON string when it cannot parse
  // them itself, and `apply_patch` (what GPT models write with) as the bare
  // patch text. Dropping that text left no file to check, and the planner was
  // refused its own plan file.
  try {
    input = JSON.parse(input);
  } catch {
    input = { input };
  }
}

if (WRITE_TOOLS.has(tool)) {
  const files = writtenFiles(input);
  const reasons = (files.length > 0 ? files : [undefined])
    .map((file) => rules.writes(file))
    .filter(Boolean);
  if (reasons.length > 0) deny(reasons[0], agent);
} else if (SHELL_TOOLS.has(tool)) {
  const command = String(input.command ?? '');
  if (rules.shellWrites?.(command)) deny(rules.writes(ROLES_DIR), agent);
  if (rules.bash.some((rule) => matches(rule, command))) {
    deny(rules.bashReason, agent);
  }
}

process.exit(0);
