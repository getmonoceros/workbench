import type {
  CreateOptions,
  RepoEntry,
  ResolvedService,
  FeatureOptions,
} from '../create/types.js';
import { isCuratedService, serviceConnectionEnv } from '../create/catalog.js';
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
    }
    lines.push('');

    const connEnv = serviceConnectionEnv(input.services);
    if (Object.keys(connEnv).length > 0) {
      lines.push(
        'Connection details for the curated services above are already set as',
        'environment variables in this container. Read them from the',
        'environment — do not ask the user for credentials, and do not',
        'hardcode them:',
      );
      lines.push('');
      if (connEnv.DATABASE_URL !== undefined) {
        lines.push(
          '- `DATABASE_URL` — the SQL database. Engine-specific variables are',
          '  set too (`PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` for',
          '  Postgres, `MYSQL_*` for MySQL).',
        );
      }
      if (connEnv.REDIS_URL !== undefined) {
        lines.push('- `REDIS_URL` — Redis.');
      }
      lines.push('');
      lines.push(
        'These are dev-only defaults for the local container, fine to use',
        'directly. Prefer reading the variable (e.g. `process.env.DATABASE_URL`)',
        'over copying its value into code.',
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
          `- ${port} (default route) → http://${input.containerName}.localhost`,
        );
      } else {
        lines.push(
          `- ${port} → http://${input.containerName}-${port}.localhost`,
        );
      }
    }
    lines.push('');
    lines.push(
      'To show the user a running app, open it in their host browser with',
      `\`xdg-open http://${input.containerName}.localhost\` — Monoceros relays`,
      'browser-opens from the container to the host machine. Also tell the user',
      'the URL, so they can open it themselves if no bridge is active.',
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

  if (input.ports.length > 0) {
    lines.push('## Running a long-running server');
    lines.push('');
    lines.push(
      'When you build something that serves on a port (a web app, an API),',
      'start it as a **detached** background process so it keeps running after',
      'this session ends. A plain `npm start` (or any foreground start) dies',
      'the moment the user exits you or closes the terminal — and then',
      `\`${input.containerName}.localhost\` returns 502 Bad Gateway.`,
    );
    lines.push('');
    lines.push(
      "Launch it in a new session with `setsid`, using the project's own",
      'start command, and record the process-group PID + log under the',
      "container's logs directory:",
    );
    lines.push('');
    lines.push('```');
    lines.push(
      `setsid sh -c 'echo $$ >/workspaces/${input.containerName}/logs/<app>.pid; \\`,
    );
    lines.push(
      `  exec <the project's start command> >/workspaces/${input.containerName}/logs/<app>.log 2>&1' </dev/null &`,
    );
    lines.push('```');
    lines.push('');
    lines.push(
      'Use whatever start command the project actually uses (`npm start`,',
      '`./mvnw spring-boot:run`, `python app.py`, `go run .`, …) — do not force',
      'a language-specific one. `<app>` is a short name you choose.',
    );
    lines.push('');
    lines.push('To stop it, kill the whole process group (also stops children');
    lines.push('like node under npm or java under maven):');
    lines.push('');
    lines.push('```');
    lines.push(
      `kill -TERM -$(cat /workspaces/${input.containerName}/logs/<app>.pid)`,
    );
    lines.push('```');
    lines.push('');
    lines.push(
      `The user can follow the output with \`monoceros logs ${input.containerName} <app>\``,
      'on the host. The server must listen on `0.0.0.0` (not `127.0.0.1`) on',
      'the exposed port, or Traefik cannot reach it.',
    );
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
