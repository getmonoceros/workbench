/**
 * The services of a workbench that may be reached from outside their container,
 * i.e. the ones carrying an `httpPort` (see catalog/descriptor.ts for why that
 * is a port and not a flag).
 *
 * Two consumers read the same answer from here: `monoceros share`, which puts
 * them on the LAN over HTTPS, and the Traefik proxy, which gives them a
 * permanent `<workbench>-<service>.localhost` route. Keeping it one function
 * keeps the two from drifting - a service that is shareable but unrouted, or the
 * other way round, would be a bug nobody could explain.
 */

export interface HttpService {
  /** Compose service name, which is also its hostname in the workbench network. */
  name: string;
  /** In-container HTTP port to reach it on. */
  port: number;
}

/**
 * Exposed services in yml order. Empty when the workbench has none.
 *
 * Takes the two fields it actually reads rather than a whole service type, so
 * both shapes of the same thing can pass: the yml's `ServiceObject` and the
 * scaffold's `ResolvedService`.
 */
export function httpServices(
  services: readonly { name: string; httpPort?: number }[],
): HttpService[] {
  return services
    .filter(
      (svc): svc is { name: string; httpPort: number } =>
        typeof svc.httpPort === 'number',
    )
    .map((svc) => ({ name: svc.name, port: svc.httpPort }));
}

/**
 * DNS alias an exposed service takes on the `monoceros-proxy` network, and the
 * host name its route matches (`<alias>.localhost`).
 *
 * Prefixed with the workbench name because that network is machine-wide: two
 * workbenches that both run keycloak would otherwise claim the same `keycloak`
 * alias on it, and Traefik would route to whichever answered first.
 */
export function serviceProxyAlias(
  containerName: string,
  serviceName: string,
): string {
  return `${containerName}-${serviceName}`;
}
