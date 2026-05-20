import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runInit } from '../init/index.js';

export const initCommand = defineCommand({
  meta: {
    name: 'init',
    group: 'lifecycle',
    description:
      'Create a fresh container-config yml at .local/container-configs/<name>.yml. Without --with, the file is a documented default with every component commented out. With --with=<names>, the named components are composed into an active, immediately-applyable yml. Then run `monoceros apply <name>`.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Config name. The yml lands at <MONOCEROS_HOME>/container-configs/<name>.yml and becomes the source-of-truth for `monoceros apply <name>`.',
      required: true,
    },
    with: {
      type: 'string',
      description:
        "Comma-separated list of component names to compose, e.g. 'node,postgres,github,claude'. Sub-components use a slash, e.g. 'atlassian/twg'. When omitted, init writes a documented default with every catalog component commented out.",
      required: false,
    },
  },
  async run({ args, rawArgs }) {
    try {
      const withList = collectWithList(args.with, rawArgs);
      await runInit({
        name: args.name,
        ...(withList ? { with: withList } : {}),
      });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

/**
 * Reconstruct the --with list from `args.with` plus any rawArgs
 * tokens that the shell tokenization split off.
 *
 * Background: a user writing
 *     monoceros init dummy --with=a, b, c
 * gets shell-tokenized into argv entries:
 *     ['init', 'dummy', '--with=a,', 'b,', 'c']
 * citty assigns `args.with = "a,"` and the rest float as extra
 * positionals that the `name` arg won't accept. To avoid forcing
 * the user to quote or remove the spaces, we look at rawArgs to
 * find the original --with token and pull in any subsequent non-
 * flag tokens until we hit something that looks like a flag or
 * run out. The collected pieces are joined back with commas and
 * re-split — same parser as before, but now seeing the full list.
 */
function collectWithList(
  withArg: string | undefined,
  rawArgs: string[],
): string[] | undefined {
  if (typeof withArg !== 'string' || withArg.trim().length === 0) {
    return undefined;
  }
  let combined = withArg.trim();
  // Find where --with starts in rawArgs, then keep eating non-flag
  // tokens. Both forms are supported by citty:
  //   --with=value  (combined in one token)
  //   --with value  (two tokens)
  const startIdx = rawArgs.findIndex(
    (t) => t === '--with' || t.startsWith('--with='),
  );
  if (startIdx >= 0) {
    // Skip the with token itself, plus its detached value when
    // `--with` was used in the two-token form.
    let scanFrom = startIdx + 1;
    if (rawArgs[startIdx] === '--with') scanFrom += 1;
    for (let i = scanFrom; i < rawArgs.length; i += 1) {
      const t = rawArgs[i]!;
      if (t.startsWith('--') || t === '-h' || t === '--help') break;
      // Re-join with a comma — the user separated with commas plus
      // (now-eaten) whitespace; comma alone is what our parser wants.
      const sep = combined.endsWith(',') ? '' : ',';
      combined += sep + t;
    }
  }
  const pieces = combined
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return pieces.length > 0 ? pieces : undefined;
}
