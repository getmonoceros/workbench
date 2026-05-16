import path from 'node:path';
import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runApplyFromCwd, runApplyFromYml } from '../apply/index.js';
import { CLI_VERSION } from '../version.js';
import { dispatch } from './_dispatch.js';

/**
 * `monoceros apply [<name>] [<path>]`
 *
 *   - With a `<name>` argument: Phase-3 path. Read
 *     `.local/container-configs/<name>.yml`, materialize the scaffold
 *     at `<path>` (default cwd), write state.json, then container-up.
 *
 *   - Without arguments: walk up from cwd to find a Monoceros dev-
 *     container root, then re-apply against the yml referenced by its
 *     `.monoceros/state.json` (Phase-3 solution) or fall back to the
 *     legacy stack.json-based apply (until Task 7 migrates).
 */
export const applyCommand = defineCommand({
  meta: {
    name: 'apply',
    description:
      'Materialize a yml config into a dev-container (when given a config name) or re-apply the current dev-container against its config (when run with no args). Close any VS Code Remote Containers session for the target first — the extension auto-recreates and races with apply.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Config name to apply. Resolves to .local/container-configs/<name>.yml. Omit to re-apply the current directory against its state.json (or fall back to its stack.json).',
      required: false,
    },
    target: {
      type: 'positional',
      description:
        'Directory to materialize the scaffold into (default: cwd). Ignored when <name> is omitted.',
      required: false,
    },
    project: {
      type: 'string',
      description:
        'Override the auto-detected solution root for the no-args path. Ignored when <name> is given.',
    },
  },
  run({ args }) {
    return dispatch(async () => {
      const name = typeof args.name === 'string' ? args.name : undefined;

      if (name) {
        const target =
          typeof args.target === 'string' ? args.target : process.cwd();
        const result = await runApplyFromYml({
          name,
          targetDir: path.resolve(target),
          cliVersion: CLI_VERSION,
        });
        return result.containerExitCode;
      }

      if (typeof args.target === 'string') {
        consola.warn(
          '`monoceros apply <path>` needs a config name before the path. Run `monoceros apply <name> <path>` or drop the path argument.',
        );
        return 2;
      }

      return runApplyFromCwd({
        cliVersion: CLI_VERSION,
        ...(typeof args.project === 'string' ? { project: args.project } : {}),
      });
    });
  },
});
