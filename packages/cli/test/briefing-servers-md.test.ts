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
      '{ "name": "api", "command": "<the API\'s start command>", "port": 3000, "readyTimeout": 120, "default": true },',
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

  it('teaches readyTimeout in the example, with the rule right below it', () => {
    const md = generateServersMd({
      containerName: 'demo',
      ports: [3000, 5173],
    });
    // In the EXAMPLE, not only in prose: an agent copies the example, so a
    // field that appears nowhere in it is a field that never gets written.
    expect(md).toContain('"readyTimeout": 120');
    // Explained where the example is, above the start/stop commands - the
    // agent writes the file before it reads how to start it.
    const explained = md.indexOf('`readyTimeout` is how many seconds');
    const startCommands = md.indexOf('monoceros-ctl start <app>');
    expect(explained).toBeGreaterThan(-1);
    expect(explained).toBeLessThan(startCommands);
    // A number to reach for, and when to leave the field out entirely.
    expect(md).toContain('120 is a sound starting point');
    expect(md).toContain('Leave the field out for anything that serves right');
    // Only the building target carries it; the web target stays clean.
    expect(md).toContain(
      '{ "name": "web", "command": "<the web start command>", "port": 5173, "default": true }',
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

  // A real agent run lost 598 of its 617 tool-seconds to five calls: three
  // `node server.js &` starts and two `pkill -f server.js` stops, each killed
  // by the 120s tool timeout. The briefing named monoceros-ctl but justified
  // it only with "survives your session", so working around it looked free.
  it('names the two traps that make a shell-started server cost minutes', () => {
    const md = generateServersMd({ containerName: 'demo', ports: [3000] });

    // The rule has to be findable before the launch-config JSON, because that
    // is where an agent in a hurry stops reading.
    const rulePos = md.indexOf('never from your own');
    const jsonPos = md.indexOf('"targets"');
    expect(rulePos).toBeGreaterThan(-1);
    expect(rulePos).toBeLessThan(jsonPos);

    // Trap 1: the backgrounded start holds the agent's own streams open.
    expect(md).toContain('node server.js &');
    expect(md).toMatch(/keeps YOUR stdout and\s+stderr open/);
    expect(md).toContain('timeout');

    // Trap 2: pkill -f matches the command line of the shell running it.
    expect(md).toContain('pkill -f');
    expect(md).toMatch(/kills that shell/);

    // And why monoceros-ctl is immune, so the rule reads as a solution
    // rather than a prohibition.
    expect(md).toMatch(/detaches the\s+server/);
    expect(md).toContain('redirects its output to a log file');
    expect(md).toContain('signals the recorded process group');
  });

  it('tells the agent it can verify its own work without a background process', () => {
    const md = generateServersMd({ containerName: 'demo', ports: [3000] });
    expect(md).toMatch(/start the server, `curl` it/);
    expect(md).toContain('You never');
    expect(md).toContain('monoceros-ctl logs <app>');
  });

  // `logs` followed the file unconditionally, so `monoceros-ctl logs <app> |
  // tail -3` from an agent's shell tool blocked until the 120s timeout - the
  // same trap the chapter above warns about, in the command it recommends.
  // The runtime now follows only into a terminal; the briefing has to say so,
  // or the next agent avoids the command instead of using it.
  it('says logs ends by itself when its output is not a terminal', () => {
    const md = generateServersMd({ containerName: 'demo', ports: [3000] });
    expect(md).toMatch(
      /follows the file on a\s+terminal and dumps it when the output is piped/,
    );
    expect(md).toContain('--no-follow');
    expect(md).toContain('--follow');
  });
});
