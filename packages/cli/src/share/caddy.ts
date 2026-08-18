/**
 * The TLS terminator for `monoceros share` (ADR 0033).
 *
 * `share` forwards app ports to the LAN over HTTPS. socat (which `tunnel`
 * uses) can terminate TLS but is a byte-level TCP forward - it cannot inject
 * HTTP headers. A backend behind a TLS-terminating forward therefore never
 * learns the request was https, so anything that stamps absolute URLs from the
 * request scheme (an OIDC issuer, a redirect, a Secure cookie) gets it wrong.
 * Keycloak reached over `share` is the concrete case: it stamps an `http://`
 * issuer, which the https browser then rejects.
 *
 * So the share terminator is Caddy, an HTTP-aware reverse proxy: it terminates
 * TLS with our machine-local leaf cert and sets `X-Forwarded-Proto` /
 * `X-Forwarded-Host` on the way to the container. `tunnel` keeps socat for
 * raw-TCP forwards.
 */

/** Caddy release we pin against. Bump deliberately, not floating. */
export const CADDY_IMAGE = 'caddy:2.11.4';

export interface CaddySite {
  /**
   * Port Caddy listens on inside its own container, and the host port it is
   * published under (they are kept equal, see `buildCaddyDockerArgs`).
   */
  listenPort: number;
  /** Docker-network hostname of the upstream: `workspace` or a service name. */
  targetHost: string;
  /**
   * Port on the upstream. Differs from `listenPort` when the host port was
   * remapped, and whenever a service's HTTP port collides with an app port.
   */
  targetPort: number;
}

/**
 * Render a Caddyfile that terminates TLS on each shared port and reverse-
 * proxies to the workspace container. `auto_https off` keeps Caddy from trying
 * to provision its own certs (we supply the leaf); `admin off` drops the admin
 * API we never use. Caddy's `reverse_proxy` sets `X-Forwarded-Proto/Host/For`
 * automatically and preserves the incoming `Host` header.
 *
 * `protocols h1 h2` pins HTTP/1.1 + HTTP/2 and disables HTTP/3. Caddy enables
 * HTTP/3 (QUIC) by default and advertises it via `Alt-Svc`; iOS/WebKit then
 * switches a token-endpoint `POST` to HTTP/3 and, when it has to replay the
 * request body, fails with `NSURLErrorRequestBodyStreamExhausted` - which
 * breaks the OIDC token exchange. HTTP/3 buys nothing on a LAN dev forward.
 */
export function renderCaddyfile(
  sites: CaddySite[],
  certFile: string,
  keyFile: string,
): string {
  const blocks = sites.map(
    (s) =>
      `:${s.listenPort} {\n` +
      `\ttls /certs/${certFile} /certs/${keyFile}\n` +
      `\treverse_proxy http://${s.targetHost}:${s.targetPort}\n` +
      `}`,
  );
  return [
    '{',
    '\tauto_https off',
    '\tadmin off',
    // `share` is a foreground user command, not a server; Caddy's default
    // info-level JSON (maxprocs, GOMEMLIMIT, "server running", autosave, …)
    // is pure noise there. Keep only genuine errors.
    '\tlog {',
    '\t\tlevel ERROR',
    '\t}',
    '\tservers {',
    '\t\tprotocols h1 h2',
    '\t}',
    '}',
    ...blocks,
    '',
  ].join('\n');
}

/**
 * One published port for the terminator: the LAN-facing host port, which is
 * also the port Caddy listens on inside its own container. Keeping the two
 * equal costs nothing (the sidecar's network namespace is private) and buys
 * the case that matters: when an app port and a service's HTTP port are the
 * same number, one of them moves to a free host port and its listener moves
 * with it, so two upstreams never fight over one listener. The upstream port
 * lives on the site (`CaddySite.targetPort`), not here. See ADR 0033.
 */
export interface CaddyPortMapping {
  host: number;
}

export interface BuildCaddyDockerArgsInput {
  /** Bind address on the host (`0.0.0.0` for LAN exposure). */
  localAddress: string;
  /**
   * Container name, `monoceros-share-<workbench>-<app>`. Without it docker
   * invents one (`suspicious_ramanujan`), and the port-collision message of the
   * NEXT share then names something the builder cannot place - while the holder
   * is in fact their own share running in another terminal. See
   * `formatShareCollision`.
   */
  containerName: string;
  ports: CaddyPortMapping[];
  network: string;
  /** Host dir holding the leaf cert + key, mounted read-only at /certs. */
  certDir: string;
  /** Host path of the rendered Caddyfile, mounted read-only. */
  caddyfilePath: string;
}

/**
 * `docker run` args for the Caddy terminator: one container publishing every
 * shared port, the cert dir and the Caddyfile mounted read-only. The pinned
 * Caddy image's default command runs `/etc/caddy/Caddyfile`, so no command
 * override is needed.
 */
export function buildCaddyDockerArgs(
  input: BuildCaddyDockerArgsInput,
): string[] {
  const args = [
    'run',
    '--rm',
    '-i',
    '--name',
    input.containerName,
    `--network=${input.network}`,
  ];
  for (const { host } of input.ports) {
    args.push('-p', `${input.localAddress}:${host}:${host}`);
  }
  args.push(
    '-v',
    `${input.certDir}:/certs:ro`,
    '-v',
    `${input.caddyfilePath}:/etc/caddy/Caddyfile:ro`,
    CADDY_IMAGE,
  );
  return args;
}
