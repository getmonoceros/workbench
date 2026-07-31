import type { AgentsMdInput } from './agents-md.js';

/**
 * Generates `.monoceros/servers.md` — the "Running a long-running
 * server" chapter, imported by AGENTS.md instead of sitting in it.
 *
 * It was the longest chapter of the briefing (72 lines) plus the
 * dev-server proxy rules that hid inside the port inventory. Nearly
 * every app in a workbench serves a port, so this is core material, not
 * a special case: the briefing keeps the rules as one-liners and this
 * file carries the launch-config shape, the `monoceros-ctl` commands and
 * the proxy requirements.
 */
export function generateServersMd(
  input: Pick<AgentsMdInput, 'containerName' | 'ports' | 'hostPort'>,
): string {
  const name = input.containerName;
  const hostPort = input.hostPort ?? 80;
  const portSuffix = hostPort === 80 ? '' : `:${hostPort}`;
  const examplePort =
    input.ports.length > 0 ? String(input.ports[0]) : '<port>';
  const secondPort = input.ports.length > 1 ? String(input.ports[1]) : '<port>';

  const lines: string[] = [];

  lines.push('# Running a long-running server');
  lines.push('');
  lines.push(
    'Nearly every app in a workbench serves a port, so treat this as the',
    'normal case. The long form of the server rules in `AGENTS.md`.',
  );
  lines.push('');
  lines.push(
    '**Start and stop every server with `monoceros-ctl`, never from your own',
    'shell.** This is not a style rule, it is the difference between a',
    'command that returns in a second and one that blocks you for minutes:',
  );
  lines.push('');
  lines.push(
    '- `node server.js &` (or any background start) keeps YOUR stdout and',
    '  stderr open for as long as the server lives, so your shell tool waits',
    '  for streams that never close and gives up on its timeout - two lost',
    '  minutes per attempt, even though the server came up instantly.',
    '- `pkill -f <pattern>` matches full command lines, including the one of',
    '  the shell that is running your `pkill`. `pkill -f server.js` inside',
    '  `sh -c "... server.js ..."` kills that shell, your tool call loses its',
    '  process, and you wait out the timeout again.',
  );
  lines.push('');
  lines.push(
    '`monoceros-ctl` has neither problem by construction: `start` detaches the',
    'server with its own session and redirects its output to a log file, so',
    'your streams stay free and the call returns as soon as the port listens.',
    '`stop` signals the recorded process group, so there is no pattern to',
    'match and nothing of yours to hit. `logs` shows the output without',
    'holding anything open.',
  );
  lines.push('');
  lines.push(
    'That covers checking your own work too: start the server, `curl` it,',
    'read `monoceros-ctl logs <app>` if the answer surprises you. You never',
    'need a background process of your own. `logs` follows the file on a',
    'terminal and dumps it when the output is piped or captured, so it ends by',
    'itself for you; `--no-follow` forces the dump, `--follow` the opposite.',
  );
  lines.push('');

  lines.push('## Keep it running');
  lines.push('');
  lines.push(
    'When you build something that serves on a port (a web app, an API),',
    'it must keep running after this session ends. A plain `npm start` (or',
    'any foreground start) dies the moment the user exits you or closes the',
    input.ports.length > 0
      ? `terminal, and then \`${name}.localhost${portSuffix}\` returns 502 Bad Gateway.`
      : 'terminal, and the app stops responding.',
  );
  lines.push('');
  if (input.ports.length === 0) {
    lines.push(
      'This container exposes **no ports yet**, so a server has nothing to be',
      'reached on. Before serving one, ask the user to add a port on the host',
      'and re-apply - you cannot do this from inside:',
    );
    lines.push('');
    lines.push('```');
    lines.push(`monoceros add-port ${name} <port>`);
    lines.push(`monoceros apply ${name}`);
    lines.push('```');
    lines.push('');
  }
  lines.push(
    "Declare the server in the app's own launch config at",
    '`projects/<app>/.monoceros/launch.json`, then start it with',
    '`monoceros-ctl`. Add or update an entry whenever you set up a',
    'long-running server. The file travels with the app, so the human can',
    'restart it later without knowing your start command:',
  );
  lines.push('');
  lines.push('```json');
  lines.push('{');
  lines.push('  "targets": [');
  lines.push(
    `    { "name": "api", "command": "<the API's start command>", "port": ${examplePort}, "readyTimeout": 120, "default": true },`,
  );
  lines.push(
    `    { "name": "web", "command": "<the web start command>", "port": ${secondPort}, "default": true }`,
  );
  lines.push('  ]');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push(
    'Use whatever start command the project actually uses (`npm run dev`,',
    '`./mvnw spring-boot:run`, `python manage.py runserver`, `go run .`, …).',
    'Do not force a language-specific one. `<app>` is the path under',
    '`projects/`; `port` must be a port exposed on the container.',
  );
  lines.push('');
  lines.push(
    '`readyTimeout` is how many seconds the server may take to start',
    'listening. Set it whenever the start command BUILDS before it serves - a',
    'Go, Maven, Gradle or Rust build, or a script that compiles first - because',
    'the default is 20 seconds and a cold build outruns that. The server is then',
    'reported failed while it is still perfectly fine, and the targets after it',
    'in the default set are skipped. 120 is a sound starting point for a',
    'compiled server, 300 for a large project building from an empty cache.',
    'Leave the field out for anything that serves right away (`npm run dev`, a',
    'Python dev server) - the 20 seconds are plenty there.',
  );
  lines.push('');
  lines.push('Start it, stop it, tail its log:');
  lines.push('');
  lines.push('```');
  lines.push('monoceros-ctl start <app>');
  lines.push('monoceros-ctl stop <app>');
  lines.push('monoceros-ctl logs <app>');
  lines.push('```');
  lines.push('');
  lines.push(
    '`start` launches it detached (it survives your session) and, when a',
    '`port` is set, waits until it actually listens before returning. The',
    'human can do the same from the host with',
    `\`monoceros start ${name} <app>\` / \`monoceros stop ${name} <app>\`,`,
    `and follow output with \`monoceros logs ${name} <app>\`.`,
  );
  lines.push('');
  lines.push(
    'An app can declare several servers (e.g. an API and a web frontend).',
    'Mark every server that should come up together with `"default": true`;',
    '`monoceros-ctl start <app>` (no `--target`) then starts the whole default',
    'set in the order the entries appear in the file, waiting for each',
    "server's `port` to listen before starting the next - so order an entry",
    'before anything that depends on it. If one fails to come up, the rest are',
    'not started. Pass `--target <name>` to start or stop a single one.',
  );
  lines.push('');
  lines.push(
    'When you add a server in a later session, revisit the existing',
    '`launch.json` instead of assuming its current `default` set is complete.',
    'If the new server belongs to the app that should come up together (a',
    'backend the frontend calls, a worker the app relies on), give it',
    '`"default": true` too and place its entry before whatever depends on it.',
    'A single pre-existing default entry does not mean later servers should',
    'stay non-default - most servers that make up the running app belong in',
    'the default set.',
  );
  lines.push('');
  lines.push(
    'The server must listen on `0.0.0.0` (not `127.0.0.1`) on the exposed',
    'port, or Traefik cannot reach it. You only have the ports already',
    'declared on the container; if you need another, ask the human to add it',
    `on the host (\`monoceros add-port ${name} <port>\`) and re-apply.`,
  );
  lines.push('');

  lines.push('## Dev servers (so the proxy and LAN can reach them)');
  lines.push('');
  lines.push(
    'A dev server you start must be reachable through the Monoceros proxy',
    '(and, when the user shares it to their phone/LAN, over the network).',
    'Configure it so:',
  );
  lines.push('');
  lines.push(
    '- it **listens on `0.0.0.0`**, not `127.0.0.1` (otherwise the proxy',
    '  cannot reach it);',
    '- it **accepts the proxy/LAN hostnames** — Vite `server.allowedHosts`,',
    '  Angular `--allowed-hosts`, CRA `DANGEROUSLY_DISABLE_HOST_CHECK`;',
    '- it does **not pin the HMR/live-reload socket** to a fixed host or port',
    '  — let it follow the page URL (e.g. for Vite, do not set',
    `  \`server.hmr.clientPort\`), so HMR works on \`<name>.localhost${portSuffix}\` and over`,
    '  the LAN alike;',
    '- the **backend is reached via the dev-server proxy** under a relative',
    '  path (Vite `server.proxy`, Angular `proxy.conf.json`, CRA',
    '  `setupProxy.js`) so the browser only ever talks to one origin.',
  );
  lines.push('');
  lines.push(
    'These are dev-server-only settings (a production build ignores them), so',
    'they are safe to keep.',
  );
  lines.push('');

  return lines.join('\n');
}
