import { consola } from 'consola';

export function notImplemented(commandName: string): never {
  consola.warn(`\`monoceros ${commandName}\` is not yet implemented.`);
  process.exit(2);
}
