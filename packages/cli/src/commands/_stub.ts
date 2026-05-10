import { consola } from 'consola';

export function notImplemented(commandName: string): never {
  consola.warn(
    `\`monoceros ${commandName}\` is not yet implemented. Tracked in docs/backlog.md (M1).`,
  );
  process.exit(2);
}
