import type {
  CreateOptions,
  RepoEntry,
  ResolvedService,
  FeatureOptions,
} from '../create/types.js';
import {
  isCuratedService,
  serviceConnectionEnv,
  curatedServiceBriefing,
} from '../create/catalog.js';
import type { FeatureManifestSummary } from '../init/manifest.js';

/**
 * Generates the body of `AGENTS.md` — the Monoceros-owned block that
 * sits between the marker comments. The caller wraps it with markers
 * (and the user-notes section) via `wrapWithMarkers` from markers.ts.
 *
 * The briefing tells the AI tool inside the container:
 *
 *   - what stack is actually here (languages, services, features,
 *     repos, ports);
 *   - how the Monoceros model works (declarative, isolated, host
 *     extension);
 *   - how to ask the user for credentials when needed (no credentials
 *     are written into this file by design);
 *   - how to suggest `monoceros …` commands to the user so they're
 *     copy-paste-ready.
 *
 * The full command reference (signatures + flags) is delegated to a
 * sibling file `.monoceros/commands.md` via an `@`-import at the end
 * of the briefing.
 */

export interface AgentsMdInput {
  containerName: string;
  languages: readonly string[];
  services: readonly ResolvedService[];
  /** Feature ref → display name from the components catalog. */
  features: readonly FeatureDisplay[];
  repos: readonly RepoEntry[];
  ports: readonly number[];
  /**
   * Host port the Traefik proxy binds (`routing.hostPort`, default 80).
   * Anything other than 80 surfaces in the `.localhost` URLs as a
   * `:<port>` suffix — without it the agent would be told the wrong URL
   * and hit a dead `:80`. Optional so direct callers/tests default to 80.
   */
  hostPort?: number;
}

export interface FeatureDisplay {
  /** Full feature ref, e.g. `ghcr.io/getmonoceros/monoceros-features/claude-code:1`. */
  ref: string;
  /**
   * One or more bullet-style briefing lines for this feature. Multiple
   * lines appear when a feature installs several sub-tools whose
   * presence depends on option values (e.g. atlassian's `rovodev` and
   * `twg`). For features without a manifest-declared briefing block,
   * this is a single-element array with the component-catalog
   * displayName (or a derived fallback for third-party refs).
   */
  lines: string[];
}

export function generateAgentsMd(input: AgentsMdInput): string {
  const lines: string[] = [];

  // `.localhost` URLs carry the proxy host port only when it isn't the
  // default 80 — so `routing.hostPort: 8080` yields `…localhost:8080`,
  // and the common case stays a clean port-less URL.
  const hostPort = input.hostPort ?? 80;
  const portSuffix = hostPort === 80 ? '' : `:${hostPort}`;

  lines.push('# Monoceros Container — Stack Briefing');
  lines.push('');
  lines.push(
    'You are working inside a Monoceros dev container. This file',
    'describes what is actually available in this container and how the',
    'environment is shaped, so you do not try to install things from',
    'inside or invent capabilities that do not exist.',
  );
  lines.push('');

  lines.push('## What Monoceros is');
  lines.push('');
  lines.push(
    'Monoceros is a workbench that materializes Linux dev containers from',
    'a declarative yml configuration on the host. The yml lists languages,',
    'services, AI tools (Devcontainer Features), cloned repos, and exposed',
    `ports. \`monoceros apply ${input.containerName}\` on the host rebuilds`,
    'this container from that yml.',
  );
  lines.push('');
  lines.push('Implications you need to understand:');
  lines.push('');
  lines.push(
    '- **The yml is the source of truth.** What is installed here matches',
    '  the yml plus the catalog defaults. If something is not listed below,',
    '  it is not available — and cannot be made available from inside.',
    '- **Changes from inside the container do not persist** across a',
    '  rebuild. `apt-get install`, `npm install -g`, system-level edits,',
    '  globally installed binaries — all gone after the next',
    `  \`monoceros apply ${input.containerName}\`. What survives a rebuild:`,
    '  the workspace (`projects/`), the data directories of services, and',
    '  a small set of home subdirectories that tools use to keep their',
    '  auth state.',
    '- **Extension happens on the host.** When a language, service, or',
    `  tool is missing, the user runs \`monoceros add-* ${input.containerName} …\``,
    `  on their host and then \`monoceros apply ${input.containerName}\`.`,
    '  You do not have access to the host and cannot run these commands',
    '  yourself.',
    "- **The container is isolated.** You cannot reach other containers'",
    '  environment variables, the host filesystem, or the Docker daemon',
    '  from inside. Services are reachable on the Docker network by',
    '  service name (e.g. `postgres:5432`); anything else is out of',
    '  reach.',
  );
  lines.push('');

  lines.push('## What is here');
  lines.push('');

  if (input.languages.length > 0) {
    lines.push('### Languages');
    lines.push('');
    for (const lang of input.languages) {
      lines.push(`- ${formatLanguage(lang)}`);
    }
    lines.push('');
  }

  if (input.services.length > 0) {
    lines.push('### Services (running on the Docker network)');
    lines.push('');
    for (const svc of input.services) {
      lines.push(formatServiceLine(svc));
      // Per-service guidance comes straight from the descriptor's `briefing:`
      // (the single source), rendered as indented lines under the service.
      for (const brief of curatedServiceBriefing(svc.name)) {
        for (const sub of brief.split('\n')) {
          lines.push(sub ? `  ${sub}` : '');
        }
      }
      // Surface the workspace files actually mounted into this service (a
      // realm export, a theme) with their real paths, so the agent edits
      // them where they live instead of guessing from the `<app>` template.
      for (const mountLine of formatServiceMounts(svc)) {
        lines.push(mountLine);
      }
    }
    lines.push('');

    const connEnv = serviceConnectionEnv(input.services);
    const connUrlKeys = Object.keys(connEnv).filter((k) => k.endsWith('_URL'));
    if (connUrlKeys.length > 0) {
      lines.push(
        'Connection details for the curated services above are set as',
        'environment variables in this container — one set per service, prefixed',
        'with the (uppercased) service name. Read them from the environment; do',
        'not ask the user for credentials and do not hardcode them. The URLs:',
      );
      lines.push('');
      for (const k of connUrlKeys) {
        lines.push(`- \`${k}\``);
      }
      lines.push('');
      lines.push(
        'Each service also exposes `<SERVICE>_HOST`, `<SERVICE>_PORT` and, for SQL',
        'databases, `<SERVICE>_USER` / `<SERVICE>_PASSWORD` / `<SERVICE>_DB`. These',
        'are dev-only defaults for the local container, fine to read directly.',
      );
      lines.push('');
      lines.push(
        'There is deliberately **no** bare `DATABASE_URL` (multiple databases',
        'would collide on it). If a framework or tool defaults to `DATABASE_URL`,',
        "set it in the project's `.env` to the right service URL, e.g.",
        '`DATABASE_URL=$POSTGRES_URL`.',
      );
    }

    const hasCustom = input.services.some((s) => !isCuratedService(s.name));
    if (hasCustom) {
      lines.push('');
      lines.push(
        "For custom-image services, Monoceros does not know the service's",
        'configuration or credentials (env vars, ports beyond the primary one,',
        'required volumes). Treat such a service as a black box reachable at',
        'the listed address; if you need to connect, ask the user in the',
        'current chat. Do not commit credentials into the repo — they belong',
        "in the user's `.env` on the host.",
      );
    }
    lines.push('');
  }

  if (input.features.length > 0) {
    lines.push('### Installed tools');
    lines.push('');
    for (const feat of input.features) {
      for (const text of feat.lines) {
        lines.push(`- ${text}`);
      }
    }
    lines.push('');
  }

  if (input.repos.length > 0) {
    lines.push('### Cloned repos');
    lines.push('');
    for (const repo of input.repos) {
      lines.push(`- \`projects/${repo.path}/\` ← ${repo.url}`);
    }
    lines.push('');
  }

  if (input.ports.length > 0) {
    lines.push('### Exposed ports');
    lines.push('');
    for (let i = 0; i < input.ports.length; i++) {
      const port = input.ports[i]!;
      if (i === 0) {
        lines.push(
          `- ${port} (default route) → http://${input.containerName}.localhost${portSuffix}`,
        );
      } else {
        lines.push(
          `- ${port} → http://${input.containerName}-${port}.localhost${portSuffix}`,
        );
      }
    }
    lines.push('');
    lines.push(
      'To show the user a running app, open it in their host browser with',
      `\`xdg-open http://${input.containerName}.localhost${portSuffix}\` — Monoceros relays`,
      'browser-opens from the container to the host machine. Also tell the user',
      'the URL, so they can open it themselves if no bridge is active.',
    );
    lines.push('');
    lines.push('### Dev servers (so the proxy and LAN can reach them)');
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
  }

  lines.push('## How to extend this container');
  lines.push('');
  lines.push(
    'When you need a language, service, or tool that is not listed above,',
    'ask the user to run the matching command on the host. Present the',
    'command on its own line in a fenced code block, no prose on the same',
    'line — the user must be able to copy and paste verbatim:',
  );
  lines.push('');
  lines.push('```');
  lines.push(`monoceros add-language ${input.containerName} <lang>`);
  lines.push(`monoceros add-service ${input.containerName} <service>`);
  lines.push(`monoceros add-feature ${input.containerName} <feature>`);
  lines.push(`monoceros add-port ${input.containerName} <port>`);
  lines.push(`monoceros add-repo ${input.containerName} <repo-url>`);
  lines.push(`monoceros apply ${input.containerName}`);
  lines.push('```');
  lines.push('');
  lines.push(
    'For `add-feature`, prefer the short catalog name (`claude`, `opencode`,',
    '`atlassian/twg`) over the full OCI reference. After the apply, the',
    `user re-enters the container with \`monoceros shell ${input.containerName}\``,
    'and the new capability is available.',
  );
  lines.push('');

  lines.push('## Conventions and pitfalls');
  lines.push('');
  lines.push(
    `- **Build everything under \`/workspaces/${input.containerName}/projects/\`.**`,
    '  That is the project workspace — create new apps and scaffolding there',
    '  (e.g. `projects/<app>/`), and `cd` into it before generating files. Do',
    `  **not** put project files at the workspace root \`/workspaces/${input.containerName}\`:`,
    '  it holds Monoceros-managed directories (`.devcontainer/`, `home/`,',
    '  `data/`, `logs/`), not your code. Cloned repos already live at',
    '  `projects/<repo>/` and are git repositories — commit normally.',
    `- **Register new projects in \`${input.containerName}.code-workspace\`.** When`,
    '  you scaffold a new project directly under `projects/` (not a clone of a',
    '  repo already listed above), add it to the VS Code multi-root workspace so',
    `  it shows up in the Explorer. Open \`/workspaces/${input.containerName}/${input.containerName}.code-workspace\``,
    '  and append an entry to the `folders` array, for example',
    '  `{ "path": "projects/<app>", "name": "<app>" }`.',
    '  Add **exactly one** folder entry per directory directly under `projects/`:',
    '  the top-level project directory itself, even when it contains several',
    '  sub-projects (e.g. a `backend/` and a `frontend/`, or a multi-module',
    '  layout). Do **not** register those sub-directories as separate roots — one',
    '  root per top-level project keeps the Explorer readable as more projects',
    '  land in the container. Cloned repos are added there automatically by the',
    '  apply; projects you create yourself are not, so without this step VS Code',
    '  (opened on the host from the workspace file) would not list them.',
    '  Hand-added folder entries survive `monoceros apply`: the apply merges into',
    '  the file, it does not overwrite your edits.',
    '- You run as the `node` user. `sudo` is available but its effects do',
    '  not persist across rebuilds.',
    '- A bare `EXPOSE` directive has no effect on host reachability. Ports',
    '  the user wants to hit from their browser require',
    `  \`monoceros add-port ${input.containerName} <port>\` on the host.`,
    '- If you suggest writing a `.env` file inside a project for local',
    '  values, that is fine — it stays in the workspace. Do not write',
    '  credentials into source-controlled files.',
    `- \`monoceros tunnel ${input.containerName} <service>\` on the host opens a TCP`,
    "  tunnel from the user's host to a service in this container. Useful",
    '  to suggest when the user wants to connect a GUI client (psql,',
    '  DataGrip) to one of the services.',
  );
  lines.push('');

  // Always emitted, even with no ports declared: an agent building a server
  // needs to know the launch-config mechanism exists (and that ports come from
  // the host first). Gating this behind ports left port-less workbenches with
  // no hint at all, so the agent had nothing to find.
  const examplePort =
    input.ports.length > 0 ? String(input.ports[0]) : '<port>';
  const secondPort = input.ports.length > 1 ? String(input.ports[1]) : '<port>';

  lines.push('## Running a long-running server');
  lines.push('');
  lines.push(
    'When you build something that serves on a port (a web app, an API),',
    'it must keep running after this session ends. A plain `npm start` (or',
    'any foreground start) dies the moment the user exits you or closes the',
    input.ports.length > 0
      ? `terminal, and then \`${input.containerName}.localhost${portSuffix}\` returns 502 Bad Gateway.`
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
    lines.push(`monoceros add-port ${input.containerName} <port>`);
    lines.push(`monoceros apply ${input.containerName}`);
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
    `    { "name": "api", "command": "<the API's start command>", "port": ${examplePort}, "default": true },`,
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
    `\`monoceros start ${input.containerName} <app>\` / \`monoceros stop ${input.containerName} <app>\`,`,
    `and follow output with \`monoceros logs ${input.containerName} <app>\`.`,
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
    `on the host (\`monoceros add-port ${input.containerName} <port>\`) and re-apply.`,
  );
  lines.push('');

  lines.push('## Command reference');
  lines.push('');
  lines.push(
    'For the exact signature, flags, and accepted values of every',
    '`monoceros` subcommand, see the imported reference:',
  );
  lines.push('');
  lines.push('@.monoceros/commands.md');
  lines.push('');

  return lines.join('\n');
}

function formatLanguage(lang: string): string {
  // The yml's `languages:` block uses bare names (`node`) or
  // `name:version` (`java:17`). Render the version when present —
  // Claude only needs major precision, which is what the yml carries.
  const colonIdx = lang.indexOf(':');
  const name = colonIdx >= 0 ? lang.slice(0, colonIdx) : lang;
  const version = colonIdx >= 0 ? lang.slice(colonIdx + 1) : '';
  const pretty = LANGUAGE_DISPLAY[name] ?? capitalize(name);
  return version ? `${pretty} ${version}` : pretty;
}

const LANGUAGE_DISPLAY: Record<string, string> = {
  node: 'Node.js',
  python: 'Python',
  java: 'Java',
  go: 'Go',
  rust: 'Rust',
  dotnet: '.NET',
};

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatServiceLine(svc: ResolvedService): string {
  const port = svc.port;
  const reach = port ? `${svc.name}:${port}` : svc.name;
  if (isCuratedService(svc.name)) {
    return `- **${svc.name}** — reachable at \`${reach}\``;
  }
  return `- **${svc.name}** (custom image \`${svc.image}\`) — reachable at \`${reach}\``;
}

/**
 * Render the workspace bind-mounts a service actually has configured,
 * grouped by the project they come from. Only host-relative sources
 * under `projects/` are shown — those are the files the agent can edit
 * from inside the container (a Keycloak realm export, a theme). Named
 * volumes (`data:…`) and IDE-state volumes are host-managed and not the
 * agent's concern, so they drop out via `projectOf`. Returns indented
 * lines that nest under the service bullet, or an empty array when the
 * service has no workspace binds.
 */
function formatServiceMounts(svc: ResolvedService): string[] {
  const byProject = new Map<string, string[]>();
  for (const spec of svc.volumes) {
    const mount = parseBindMount(spec);
    if (!mount) continue;
    const project = projectOf(mount.source);
    if (!project) continue;
    const readOnly = mount.mode === 'ro' ? ' (read-only)' : '';
    const bucket = byProject.get(project) ?? [];
    bucket.push(`    - \`${mount.source}\` → \`${mount.target}\`${readOnly}`);
    byProject.set(project, bucket);
  }
  if (byProject.size === 0) return [];
  const out = ['  Workspace mounts (edit these on the host, then re-apply):'];
  for (const [project, entries] of byProject) {
    out.push(`  - ${project}:`);
    out.push(...entries);
  }
  return out;
}

/**
 * Parse a compose-style bind spec `source:target[:mode]` into its parts.
 * The source is a workspace-relative POSIX path (no colon); the target
 * is an absolute container path; an optional trailing token without a
 * slash is the access mode (`ro`/`rw`/…). Named volumes like `data:/x`
 * still parse here — `projectOf` is what filters them out.
 */
function parseBindMount(
  spec: string,
): { source: string; target: string; mode?: string } | null {
  const parts = spec.split(':');
  if (parts.length < 2) return null;
  const source = parts[0]!;
  let mode: string | undefined;
  const last = parts[parts.length - 1]!;
  if (parts.length >= 3 && !last.includes('/')) {
    mode = parts.pop();
  }
  return { source, target: parts.slice(1).join(':'), mode };
}

/**
 * The project a workspace-relative bind source belongs to:
 * `projects/<project>/…` → `<project>`. Returns null for sources not
 * rooted under `projects/` (named volumes, absolute host paths), so only
 * workspace files the agent can edit are surfaced.
 */
function projectOf(source: string): string | null {
  const segments = source.split('/');
  if (segments[0] !== 'projects' || segments.length < 2) return null;
  return segments[1] ?? null;
}

/**
 * Adapt a `CreateOptions` block into an `AgentsMdInput`.
 *
 * Per-feature lines are resolved in order of preference:
 *
 *   1. **Manifest-declared briefing** (`x-monoceros.briefing.lines`)
 *      — emits one line per declared entry whose `whenOption` (if any)
 *      resolves to a truthy value. Truthiness is checked against the
 *      merged options block (user-supplied options layered over
 *      manifest defaults). This is what surfaces sub-tools like
 *      `atlassian`'s `rovodev` / `twg` only when the corresponding
 *      option is on.
 *
 *   2. **Component-catalog displayName** — fallback for features that
 *      don't declare a briefing block. Single line.
 *
 *   3. **Derived ref tail** — fallback for refs neither in the
 *      manifest-loader nor the component catalog (third-party
 *      devcontainer features).
 *
 * Features whose manifest declares a briefing but where no option
 * matches (e.g. `atlassian` with both `rovodev` and `twg` disabled)
 * produce zero lines and the feature is silently omitted — the briefing
 * shouldn't claim a tool that isn't actually there.
 */
export function agentsMdInputFromCreateOptions(
  opts: CreateOptions,
  featureDisplayMap: ReadonlyMap<string, string>,
  manifestLoader?: (ref: string) => FeatureManifestSummary | undefined,
  hostPort = 80,
): AgentsMdInput {
  const features: FeatureDisplay[] = [];
  for (const [ref, userOptions] of Object.entries(opts.features ?? {})) {
    const manifest = manifestLoader?.(ref);
    const lines = resolveFeatureLines(
      ref,
      userOptions ?? {},
      manifest,
      featureDisplayMap,
    );
    if (lines.length > 0) {
      features.push({ ref, lines });
    }
  }
  return {
    containerName: opts.name,
    languages: opts.languages,
    services: opts.services,
    features,
    repos: opts.repos ?? [],
    ports: opts.ports ?? [],
    hostPort,
  };
}

function resolveFeatureLines(
  ref: string,
  userOptions: FeatureOptions,
  manifest: FeatureManifestSummary | undefined,
  featureDisplayMap: ReadonlyMap<string, string>,
): string[] {
  if (manifest?.briefing) {
    const resolved = mergeOptions(manifest.optionDefaults, userOptions);
    const out: string[] = [];
    for (const line of manifest.briefing.lines) {
      if (line.whenOption === undefined) {
        out.push(line.text);
        continue;
      }
      if (isTruthy(resolved[line.whenOption])) {
        out.push(line.text);
      }
    }
    return out;
  }
  const display = featureDisplayMap.get(ref) ?? fallbackFeatureName(ref);
  return [display];
}

function mergeOptions(
  defaults: Record<string, string | boolean>,
  userOptions: FeatureOptions,
): Record<string, string | number | boolean> {
  return { ...defaults, ...userOptions };
}

function isTruthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  return false;
}

/**
 * Turn an unknown feature ref (e.g.
 * `ghcr.io/devcontainers/features/docker-in-docker:2`) into something
 * a human can read: the last path segment minus the version tag.
 */
function fallbackFeatureName(ref: string): string {
  const lastSlash = ref.lastIndexOf('/');
  const tail = lastSlash >= 0 ? ref.slice(lastSlash + 1) : ref;
  const colon = tail.indexOf(':');
  return colon >= 0 ? tail.slice(0, colon) : tail;
}
