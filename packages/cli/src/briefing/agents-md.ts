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
import type { ResolvedMcpServer } from '../catalog/mcp.js';
import { hasDeployBriefing } from './deploy-md.js';
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
 * **Order matters more than completeness.** A live test showed an agent
 * reading the file with `head -100`, which used to be exactly the
 * background and the inventory: the first 100 lines carried no rule at
 * all. So the shape is now rules → inventory → explanation, and the two
 * long chapters live in imported files (`.monoceros/conventions.md`,
 * `.monoceros/servers.md`) with their rules kept here as one-liners. A
 * truncated read loses background, not behaviour. The header states the
 * file's line count and its imports, so a partial read has a visible
 * contradiction in front of it.
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
  /**
   * MCP servers registered for the agents in this container (ADR 0045).
   * Named in the briefing because a server the agent does not know about is
   * one it re-derives by hand every session. Optional so direct callers and
   * tests can leave it out, same as `hostPort`.
   */
  mcp?: readonly ResolvedMcpServer[];
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

/**
 * Stands in for the file's own line count in the generated header. The
 * number can only be known once the block is wrapped in markers and
 * merged into whatever the user keeps outside them, so
 * `resolveLineCount` substitutes it on the final file content. It sits
 * inside a line, never on one of its own, so replacing it cannot change
 * the count it reports.
 */
export const LINE_COUNT_PLACEHOLDER = '%%MONOCEROS_LINE_COUNT%%';

/**
 * Replace `LINE_COUNT_PLACEHOLDER` with the number of lines the given
 * file content actually has (counted like `wc -l`, i.e. a trailing
 * newline does not add an empty line). Call this on the complete file
 * text, after markers and user notes are in place — otherwise the
 * briefing states a number the agent cannot verify.
 */
export function resolveLineCount(content: string): string {
  const count = content.replace(/\n$/, '').split('\n').length;
  return content.replaceAll(LINE_COUNT_PLACEHOLDER, String(count));
}

export function generateAgentsMd(input: AgentsMdInput): string {
  const lines: string[] = [];

  // `.localhost` URLs carry the proxy host port only when it isn't the
  // default 80 — so `routing.hostPort: 8080` yields `…localhost:8080`,
  // and the common case stays a clean port-less URL.
  const hostPort = input.hostPort ?? 80;
  const portSuffix = hostPort === 80 ? '' : `:${hostPort}`;

  const deploy = hasDeployBriefing(input.services);
  const imports = [
    '.monoceros/conventions.md',
    '.monoceros/servers.md',
    ...(deploy ? ['.monoceros/deploy.md'] : []),
    '.monoceros/commands.md',
  ];

  lines.push('# Monoceros Container — Stack Briefing');
  lines.push('');
  lines.push(
    'You are working inside a Monoceros dev container. This file',
    'describes what is actually available in this container and how the',
    'environment is shaped, so you do not try to install things from',
    'inside or invent capabilities that do not exist.',
  );
  lines.push('');
  lines.push(
    `This file is ${LINE_COUNT_PLACEHOLDER} lines long and imports ${imports.length} more:`,
    `${imports.map((i) => `\`${i}\``).join(', ')}.`,
    'Read it whole. If you have seen fewer lines than that, or have not',
    'read the imports, you do not have the briefing yet — read the rest',
    'before you write anything. Do not summarize it back to yourself from',
    'the first screen.',
  );
  lines.push('');

  lines.push('## Rules');
  lines.push('');
  lines.push(
    'These are the rules of this container. The sections below only add',
    'detail; none of them relaxes a rule here.',
  );
  lines.push('');
  lines.push(
    `- Build under \`/workspaces/${input.containerName}/projects/\`, one directory per project.`,
    '  Never at the workspace root, which is Monoceros-managed.',
    `- Register every project directory you create in \`${input.containerName}.code-workspace\``,
    '  (`folders`), exactly one entry per directory directly under `projects/`.',
    '  Otherwise it never shows up in the editor.',
    '- Write everything that goes into the repo in English (code, comments,',
    '  docs, commit messages). Chat with the user in their language.',
    '- Read service credentials, hosts and URLs from the environment',
    '  (`<SERVICE>_URL`, `<SERVICE>_USER`, …). Never write service',
    '  configuration from memory, never hardcode it, never ask for it.',
    '- A server needs three things: a port exposed on the container, an entry',
    '  in `projects/<app>/.monoceros/launch.json`, and a process that listens',
    '  on `0.0.0.0` (not `127.0.0.1`).',
    '- Start and stop servers with `monoceros-ctl start|stop|logs <app>`, never',
    '  from your own shell. A foreground start dies with this session, a',
    '  backgrounded one (`… &`) holds your stdout open until your tool call',
    '  times out, and `pkill -f` kills the shell running it. `monoceros-ctl`',
    '  has none of those problems and waits until the port listens.',
    '- When a task can be done through an installed CLI and through an MCP',
    '  server, take the CLI. You can filter its output before it reaches your',
    '  context window; an MCP response arrives whole, including everything you',
    '  did not need. The MCP server is the fallback for what the CLI cannot do.',
    ...(deploy
      ? [
          '- Take a compose file for the pipeline from `.monoceros/deploy.md`, block',
          "  by block. Not from this container's `.devcontainer/compose.yaml`, not",
          '  from memory.',
        ]
      : []),
    '- Nothing you install from inside survives the next',
    `  \`monoceros apply ${input.containerName}\`. A missing language, service, tool or`,
    '  port is added on the host, by the user.',
    `- \`monoceros …\` commands are the user's to run, on the host. Print one per`,
    '  line in a fenced code block and wait; you cannot run them yourself.',
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

  const mcpServers = input.mcp ?? [];
  if (mcpServers.length > 0) {
    lines.push('### MCP servers');
    lines.push('');
    lines.push(
      'Registered for you already, so use them instead of rediscovering what',
      'they cover - after you have checked that no installed CLI covers the',
      'same task, per the rule above:',
    );
    lines.push('');
    for (const server of mcpServers) {
      const desc = server.description ? ` - ${server.description}` : '';
      lines.push(`- \`${server.name}\`${desc}`);
      // Per-connector guidance from the descriptor's `briefing:`, indented
      // under its server — the same shape the services section uses.
      for (const brief of server.briefing ?? []) {
        for (const sub of brief.split('\n')) {
          lines.push(sub ? `  ${sub}` : '');
        }
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
  }

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
    '  the yml plus the catalog defaults. If something is not listed above,',
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
  lines.push(`monoceros add-mcp-server ${input.containerName} <connector>`);
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
    'The rules above in full - where to build, what the workspace root is,',
    'how to register a project, what does not survive a rebuild:',
  );
  lines.push('');
  lines.push('@.monoceros/conventions.md');
  lines.push('');

  lines.push('## Running a long-running server');
  lines.push('');
  lines.push(
    'Nearly every app in a workbench serves a port, so this is the normal',
    'case, not a special one. The launch config, the `monoceros-ctl`',
    'commands, and what the proxy needs from a dev server:',
  );
  lines.push('');
  lines.push('@.monoceros/servers.md');
  lines.push('');

  if (deploy) {
    lines.push('## Taking the services to a pipeline');
    lines.push('');
    lines.push(
      'The services above are the ones CI has to bring up too, but not in',
      'the shape they have in here. When the project needs a compose file',
      'for its pipeline, build it from the per-service blocks in the',
      "imported parts list — do not derive it from this container's",
      '`.devcontainer/compose.yaml`, which is dev-shaped, and do not write',
      'the service configuration from memory:',
    );
    lines.push('');
    lines.push('@.monoceros/deploy.md');
    lines.push('');
  }

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
    mcp: opts.mcpServers ?? [],
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
