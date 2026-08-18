import { existsSync } from 'node:fs';
import { containerConfigPath } from '../config/paths.js';
import { readConfig } from '../config/io.js';

/**
 * Which of a workbench's services may be reached from outside the container.
 *
 * The catalog decides, per component, with `httpPort` (see descriptor.ts): the
 * one HTTP port worth exposing. Curated entries bake it into the yml at expand,
 * so the builder sees the line and can delete it to keep an instance to itself,
 * and a hand-written service can add it. A service without the field never
 * appears here, which is the answer for every backing store: the share
 * terminator is an HTTP proxy, so a database behind it would return garbage.
 * Raw TCP stays with `monoceros tunnel`.
 */

export interface ShareableService {
  /** Compose service name, which is also its hostname in the workbench network. */
  name: string;
  /** In-container HTTP port to proxy to. */
  port: number;
}

export interface ShareableServicesOptions {
  monocerosHome?: string;
}

/**
 * Services of `<name>` that declare an `httpPort`, in yml order. Empty when
 * nothing is shareable, and empty when there is no yml at all: a missing
 * workbench is the target resolver's error to raise (it runs first and says so
 * with the `monoceros init` hint), so repeating it here would only add a second
 * voice for the same condition.
 */
export async function shareableServices(
  name: string,
  opts: ShareableServicesOptions = {},
): Promise<ShareableService[]> {
  const ymlPath = containerConfigPath(name, opts.monocerosHome);
  if (!existsSync(ymlPath)) return [];
  const parsed = await readConfig(ymlPath);
  return parsed.config.services
    .filter(
      (svc): svc is typeof svc & { httpPort: number } =>
        typeof svc.httpPort === 'number',
    )
    .map((svc) => ({ name: svc.name, port: svc.httpPort }));
}
