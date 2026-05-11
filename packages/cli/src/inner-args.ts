/**
 * Splits the user-args at the first `--` marker.
 *
 * `monoceros run -- monoceros-plugin --help` should hand `--help` to
 * `monoceros-plugin` inside the container, not trigger citty's eager
 * `--help` parser on the outer `monoceros run`. Citty parses `--help`
 * and `--version` before our subcommand handlers run, so the only
 * reliable fix is to strip everything after `--` from `process.argv`
 * before `runMain()` ever sees it.
 *
 * `splitInnerArgs` is the pure helper.
 * `consumeInnerArgsFromProcessArgv` is the side-effecting glue called
 * from `bin.ts`. `getInnerArgs()` is read by `runCommand`.
 */

let innerArgs: readonly string[] = [];

export function splitInnerArgs(userArgs: readonly string[]): {
  outerArgs: string[];
  innerArgs: string[];
} {
  const dashIdx = userArgs.indexOf('--');
  if (dashIdx === -1) {
    return { outerArgs: [...userArgs], innerArgs: [] };
  }
  return {
    outerArgs: userArgs.slice(0, dashIdx),
    innerArgs: userArgs.slice(dashIdx + 1),
  };
}

export function consumeInnerArgsFromProcessArgv(): void {
  // process.argv[0] = node, [1] = script path, [2..] = user args
  const userArgs = process.argv.slice(2);
  const split = splitInnerArgs(userArgs);
  process.argv = [...process.argv.slice(0, 2), ...split.outerArgs];
  innerArgs = split.innerArgs;
}

export function getInnerArgs(): readonly string[] {
  return innerArgs;
}

/** Test seam: lets unit tests set inner args without touching process.argv. */
export function setInnerArgsForTesting(args: readonly string[]): void {
  innerArgs = args;
}
