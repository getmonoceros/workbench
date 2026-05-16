#!/usr/bin/env node
import { runMain } from 'citty';
import { consumeInnerArgsFromProcessArgv } from './inner-args.js';
import { main } from './main.js';

// Pull everything after `--` out of argv before citty starts parsing.
// Otherwise citty's eager --help/--version handling shadows the inner
// command (e.g. `monoceros run -- foo --help` would show monoceros run's
// own help, not foo's).
consumeInnerArgsFromProcessArgv();

runMain(main);
