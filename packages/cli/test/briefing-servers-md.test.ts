import { describe, expect, it } from 'vitest';
import { generateServersMd } from '../src/briefing/servers-md.js';

describe('.monoceros/servers.md generator', () => {
  it('always briefs the launch config, with an add-port step when no ports exist', () => {
    const noPorts = generateServersMd({ containerName: 'demo', ports: [] });
    // Emitted even with zero ports: otherwise a port-less workbench leaves the
    // agent with no hint the launch-config mechanism exists at all.
    expect(noPorts).toContain('# Running a long-running server');
    expect(noPorts).toContain('projects/<app>/.monoceros/launch.json');
    // It resolves the chicken-and-egg: have the user add a port first.
    expect(noPorts).toContain('This container exposes **no ports yet**');
    expect(noPorts).toContain('monoceros add-port demo <port>');
    // The example carries a placeholder port, not an invented real one.
    expect(noPorts).toContain('"port": <port>');

    const withPorts = generateServersMd({
      containerName: 'demo',
      ports: [5173],
    });
    expect(withPorts).toContain('"port": 5173');
    expect(withPorts).not.toContain('This container exposes **no ports yet**');
  });

  it('shows a multi-server default set and tells the agent to keep later servers in it', () => {
    const md = generateServersMd({
      containerName: 'demo',
      ports: [3000, 5173],
    });
    // The example is a TWO-target default set (api + web), both default, so
    // the multi-default case reads as the norm, not the exception.
    expect(md).toContain(
      '{ "name": "api", "command": "<the API\'s start command>", "port": 3000, "default": true },',
    );
    expect(md).toContain(
      '{ "name": "web", "command": "<the web start command>", "port": 5173, "default": true }',
    );
    // A second exposed port fills the web target; with only one port the
    // web target falls back to the placeholder.
    const onePort = generateServersMd({ containerName: 'demo', ports: [3000] });
    expect(onePort).toContain('"name": "web"');
    expect(onePort).toContain('"port": <port>, "default": true');
    // The incremental case: a server added later must be re-evaluated for
    // the default set, not left out because one default already exists.
    expect(md).toContain('When you add a server in a later session');
    expect(md).toContain(
      'does not mean later servers should\nstay non-default',
    );
  });

  it('carries the dev-server proxy rules that used to hide in the port inventory', () => {
    const md = generateServersMd({
      containerName: 'demo',
      ports: [5173],
    });
    expect(md).toContain(
      '## Dev servers (so the proxy and LAN can reach them)',
    );
    expect(md).toContain('- it **listens on `0.0.0.0`**');
    expect(md).toContain('server.allowedHosts');
    expect(md).toContain('monoceros-ctl start <app>');
  });

  it('carries the host-port suffix into the 502 note and the HMR hint', () => {
    const md = generateServersMd({
      containerName: 'demo',
      ports: [3000],
      hostPort: 8080,
    });
    expect(md).toContain('`demo.localhost:8080` returns 502 Bad Gateway');
    expect(md).toContain('`<name>.localhost:8080`');

    const default80 = generateServersMd({
      containerName: 'demo',
      ports: [3000],
    });
    expect(default80).toContain('`demo.localhost` returns 502 Bad Gateway');
    expect(default80).not.toContain('demo.localhost:80');
  });
});
