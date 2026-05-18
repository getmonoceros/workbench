#!/usr/bin/env node
import { runMain } from 'citty';
import { maybeRenderHelp } from './help.js';
import { consumeInnerArgsFromProcessArgv } from './inner-args.js';
import { main } from './main.js';

// Pull everything after `--` out of argv before citty starts parsing.
// Otherwise citty's eager --help/--version handling shadows the inner
// command (e.g. `monoceros run -- foo --help` would show monoceros run's
// own help, not foo's).
consumeInnerArgsFromProcessArgv();

async function entry(): Promise<void> {
  // We render `--help` ourselves so the USAGE line shows positional
  // arguments *before* `[OPTIONS]`, matching the
  // `monoceros <command> <containername> [<args> …]` convention. Citty's
  // built-in renderer puts `[OPTIONS]` first which is the opposite. When
  // help was rendered, exit before handing off to citty so its own help
  // doesn't double up.
  if (await maybeRenderHelp(process.argv.slice(2), main)) {
    return;
  }
  await runMain(main);
}

entry().catch((err: unknown) => {
  // runMain handles its own errors; this catch is a safety net for the
  // help path.
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});
