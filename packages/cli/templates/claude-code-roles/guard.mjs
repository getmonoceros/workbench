#!/usr/bin/env node
// Monoceros claude-code-roles: the permission layer for the three roles.
//
// Written into ~/.claude/monoceros-roles/ by `monoceros apply` and wired
// into each agent as a PreToolUse hook:
//
//     hooks:
//       PreToolUse:
//         - matcher: 'Write|Edit|NotebookEdit|Bash'
//           hooks:
//             - type: command
//               command: 'node {{GUARD}} <role>'
//
// Why a script and not frontmatter: OpenCode takes glob rules per tool
// (`edit: { '*': deny, '<plans>/*': allow }`), Claude Code does not. Its
// `tools`/`disallowedTools` remove a tool wholesale, which cannot express
// "may write the plan file and nothing else". And `permissionMode` is not
// dependable here: when the session runs in Auto Mode - the claude-code
// feature's own default - a subagent's `permissionMode` is ignored
// entirely. A PreToolUse `deny` is honoured in every mode, so this is the
// only layer that holds whatever the builder set.
//
// Reads the hook JSON on stdin, writes a decision on stdout. Anything it
// does not recognise defers to the normal permission flow.

import { resolve } from 'node:path';

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
 * Mutating verbs denied for the planner. The planner's real guard is the
 * write rule below; this list exists because a shell redirect, a heredoc or
 * `sed -i` would otherwise route straight around it. Same reasoning as the
 * OpenCode denylist, which this mirrors.
 */
const MUTATING = [
  />>?\s*\S/,
  /<</,
  /\btee\b/,
  /\b(rm|mv|cp|truncate|chmod|chown|sudo)\s/,
  /\bsed\s+-i/,
  /\bgit\s+(add|commit|checkout|reset|restore|rm)\b/,
  /\b(npm|pnpm|yarn)\s+(install|add|i)\b/,
  /\bpip\s+install\b/,
];

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
        : `The planner may only write under ${PLANS_DIR}. Do not edit source: put the change into the plan and let the implementer make it.`,
    bash: [...EGRESS, ...MUTATING],
    bashReason:
      'The planner does not mutate anything. If a write was refused, report which one instead of routing around it with a shell command.',
  },
  implement: {
    // May change everything but the plan it is measured against.
    writes: (file) =>
      inside(file, PLANS_DIR)
        ? `The plan is what your work is measured against and is not yours to edit. If it is wrong, stop and report that instead.`
        : null,
    bash: EGRESS,
    bashReason:
      'What leaves this machine is the user’s decision. Commit if you like, never push or publish.',
  },
  review: {
    // Read-only. The tool allowlist in the agent already withholds Write and
    // Edit; this is the second lock, because a `tools:` list says nothing
    // about what Bash can do.
    writes: () =>
      'The reviewer is read-only. Report the finding instead of fixing it.',
    bash: [...EGRESS, ...WRITING_GIT, />>?\s*\S/, /\bsed\s+-i/, /\btee\b/],
    bashReason:
      'The reviewer must not change the thing it is judging. Run the acceptance command, read the diff, and report.',
  },
};

/** Is `file` the directory `dir` or something under it? */
function inside(file, dir) {
  if (!file) return false;
  const abs = resolve(file);
  return abs === dir || abs.startsWith(`${dir}/`);
}

function deny(reason) {
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

const tool = event?.tool_name;
const input = event?.tool_input ?? {};

if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
  const reason = rules.writes(input.file_path ?? input.notebook_path);
  if (reason) deny(reason);
} else if (tool === 'Bash') {
  const command = String(input.command ?? '');
  if (rules.bash.some((re) => re.test(command))) deny(rules.bashReason);
}

process.exit(0);
