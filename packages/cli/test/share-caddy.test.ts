import { describe, expect, it } from 'vitest';
import {
  CADDY_IMAGE,
  renderCaddyfile,
  buildCaddyDockerArgs,
} from '../src/share/caddy.js';

describe('renderCaddyfile with a service upstream', () => {
  it('proxies each listener to its own host and port', () => {
    const cf = renderCaddyfile(
      [
        // an app port, and a service whose port collided with it and moved
        { listenPort: 8080, targetHost: 'workspace', targetPort: 8080 },
        { listenPort: 18080, targetHost: 'keycloak', targetPort: 8080 },
        { listenPort: 8025, targetHost: 'mailpit', targetPort: 8025 },
      ],
      'leaf.pem',
      'leaf-key.pem',
    );
    expect(cf).toContain(':8080 {');
    expect(cf).toContain('reverse_proxy http://workspace:8080');
    // the moved listener keeps the upstream's own port
    expect(cf).toContain(':18080 {');
    expect(cf).toContain('reverse_proxy http://keycloak:8080');
    expect(cf).toContain('reverse_proxy http://mailpit:8025');
  });
});

describe('renderCaddyfile', () => {
  it('emits a TLS + reverse_proxy block per port with the leaf cert', () => {
    const cf = renderCaddyfile(
      [
        { listenPort: 5173, targetHost: 'ws', targetPort: 5173 },
        { listenPort: 8080, targetHost: 'ws', targetPort: 8080 },
      ],
      'leaf.pem',
      'leaf-key.pem',
    );
    expect(cf).toContain('auto_https off');
    expect(cf).toContain('admin off');
    // HTTP/3 disabled: iOS/WebKit replays token POSTs over h3 and breaks
    expect(cf).toContain('protocols h1 h2');
    // Caddy silenced to errors only - no info-level JSON noise in a foreground
    // user command.
    expect(cf).toContain('level ERROR');
    expect(cf).toContain(':5173 {');
    expect(cf).toContain(':8080 {');
    expect(cf).toContain('tls /certs/leaf.pem /certs/leaf-key.pem');
    expect(cf).toContain('reverse_proxy http://ws:5173');
    expect(cf).toContain('reverse_proxy http://ws:8080');
  });
});

describe('buildCaddyDockerArgs', () => {
  it('publishes every port, mounts certs + Caddyfile read-only, runs pinned Caddy', () => {
    const args = buildCaddyDockerArgs({
      localAddress: '0.0.0.0',
      containerName: 'monoceros-share-acme-web',
      ports: [{ host: 5173 }, { host: 8080 }],
      network: 'net',
      certDir: '/home/certs',
      caddyfilePath: '/home/share/acme__web.Caddyfile',
    });
    expect(args).toContain('--network=net');
    expect(args).toContain('0.0.0.0:5173:5173');
    expect(args).toContain('0.0.0.0:8080:8080');
    expect(args).toContain('/home/certs:/certs:ro');
    expect(args).toContain(
      '/home/share/acme__web.Caddyfile:/etc/caddy/Caddyfile:ro',
    );
    // named, so the next share's collision message can say whose it is
    expect(args.join(' ')).toContain('--name monoceros-share-acme-web');
    // the image is the last arg, and both mounts come before it
    expect(args[args.length - 1]).toBe(CADDY_IMAGE);
    expect(args.lastIndexOf('-v')).toBeLessThan(args.indexOf(CADDY_IMAGE));
  });

  it('publishes a remapped port on itself, so the listener moves with it', () => {
    const args = buildCaddyDockerArgs({
      localAddress: '0.0.0.0',
      containerName: 'monoceros-share-acme-web',
      ports: [{ host: 15173 }],
      network: 'net',
      certDir: '/home/certs',
      caddyfilePath: '/home/share/acme__web.Caddyfile',
    });
    // Caddy listens on the host port inside its own namespace; the upstream
    // port lives in the Caddyfile, which is what lets two upstreams that want
    // the same number coexist.
    expect(args).toContain('0.0.0.0:15173:15173');
  });
});
