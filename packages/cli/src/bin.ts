#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { runMain } from 'citty';
import { consumeInnerArgsFromProcessArgv } from './inner-args.js';
import { main } from './main.js';

// When invoked via `pnpm cli ...` the inner pnpm --filter step changes
// process.cwd() to packages/cli/, losing the user's actual shell cwd.
// pnpm exposes the original cwd via INIT_CWD, but only for the outer
// script — the root-level `cli` script forwards it explicitly:
//
//   "cli": "INIT_CWD=$INIT_CWD pnpm --filter @monoceros/cli start"
//
// So when INIT_CWD is set and points at a real directory, treat it as
// the user's cwd: chdir there so process.cwd() (and every relative path
// downstream) sees the right location. No-op when INIT_CWD is unset
// (direct binary invocation) or equal to the current cwd.
const initCwd = process.env.INIT_CWD;
if (initCwd && initCwd !== process.cwd() && existsSync(initCwd)) {
  try {
    process.chdir(initCwd);
  } catch {
    // Stale INIT_CWD (deleted directory, …) — fall through with the
    // current cwd. The user's command will likely error with a clear
    // path-not-found message anyway.
  }
}

// Pull everything after `--` out of argv before citty starts parsing.
// Otherwise citty's eager --help/--version handling shadows the inner
// command (e.g. `monoceros run -- foo --help` would show monoceros run's
// own help, not foo's).
consumeInnerArgsFromProcessArgv();

runMain(main);
