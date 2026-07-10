import { describe, expect, it } from 'vitest';
import {
  CADDY_IMAGE,
  renderCaddyfile,
  buildCaddyDockerArgs,
} from '../src/share/caddy.js';

describe('renderCaddyfile', () => {
  it('emits a TLS + reverse_proxy block per port with the leaf cert', () => {
    const cf = renderCaddyfile(
      [
        { port: 5173, targetHost: 'ws' },
        { port: 8080, targetHost: 'ws' },
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
      ports: [5173, 8080],
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
    // the image is the last arg, and both mounts come before it
    expect(args[args.length - 1]).toBe(CADDY_IMAGE);
    expect(args.lastIndexOf('-v')).toBeLessThan(args.indexOf(CADDY_IMAGE));
  });
});
