import { describe, expect, it } from 'vitest';
import {
  agentsMdInputFromCreateOptions,
  generateAgentsMd,
  LINE_COUNT_PLACEHOLDER,
  resolveLineCount,
} from '../src/briefing/agents-md.js';
import type { CreateOptions } from '../src/create/types.js';
import type { FeatureManifestSummary } from '../src/init/manifest.js';

describe('AGENTS.md generator', () => {
  it('renders title, intro, and "What Monoceros is" with the container name substituted', () => {
    const md = generateAgentsMd({
      containerName: 'demo',
      languages: ['node'],
      services: [],
      features: [],
      repos: [],
      ports: [],
    });
    expect(md).toContain('# Monoceros Container — Stack Briefing');
    expect(md).toContain('monoceros apply demo');
    expect(md).toContain('monoceros add-* demo');
    expect(md).toContain('## What Monoceros is');
  });

  // The reason for the whole shape: an agent that reads only the first
  // screen must land on the rules, not on background. So the rules block
  // comes before the inventory, and both come before the explanations.
  it('puts the rules block before the inventory and the background', () => {
    const md = generateAgentsMd({
      containerName: 'demo',
      languages: ['node'],
      services: [],
      features: [],
      repos: [],
      ports: [],
    });
    const rules = md.indexOf('## Rules');
    const inventory = md.indexOf('## What is here');
    const background = md.indexOf('## What Monoceros is');
    expect(rules).toBeGreaterThan(-1);
    expect(rules).toBeLessThan(inventory);
    expect(inventory).toBeLessThan(background);
    // Every rule the moved chapters carry survives here as a one-liner.
    expect(md).toContain('- Build under `/workspaces/demo/projects/`');
    expect(md).toContain(
      '- Register every project directory you create in `demo.code-workspace`',
    );
    expect(md).toContain(
      '- Write everything that goes into the repo in English',
    );
    expect(md).toContain('- Read service credentials, hosts and URLs from the');
    expect(md).toContain('- A server needs three things:');
    expect(md).toContain(
      '- Start and stop servers with `monoceros-ctl start|stop|logs <app>`',
    );
    // The short form carries the two traps as well: an agent that reads only
    // AGENTS.md must not learn the rule as a mere style preference. A real run
    // burned 598 of 617 tool-seconds on `node server.js &` and `pkill -f`.
    expect(md).toContain('never');
    expect(md).toContain('holds your stdout open until your tool call');
    expect(md).toContain('`pkill -f` kills the shell running it');
    expect(md).toContain('- Nothing you install from inside survives the next');
    expect(md).toContain("- `monoceros …` commands are the user's to run");
  });

  // MCP servers reach the container from the user's own Claude account too,
  // not only from `add-mcp-server`, so the rule cannot hang off the MCP
  // section: a container with an Atlassian connector and the `twg` CLI has no
  // MCP section at all and still has to prefer the CLI.
  it('states the CLI-over-MCP rule even when no MCP server is registered', () => {
    const md = generateAgentsMd({
      containerName: 'demo',
      languages: ['node'],
      services: [],
      features: [],
      repos: [],
      ports: [],
    });
    expect(md).not.toContain('### MCP servers');
    const rule = md.indexOf(
      '- When a task can be done through an installed CLI and through an MCP',
    );
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(md.indexOf('## What is here'));
    expect(md).toContain('take the CLI');
    expect(md).toContain(
      'The MCP server is the fallback for what the CLI cannot do.',
    );
  });

  it('states its own line count and the files it imports', () => {
    const md = generateAgentsMd({
      containerName: 'demo',
      languages: [],
      services: [],
      features: [],
      repos: [],
      ports: [],
    });
    // The count is a placeholder here: only the writer knows the final file
    // (markers + user notes), so it substitutes the real number.
    expect(md).toContain(
      `This file is ${LINE_COUNT_PLACEHOLDER} lines long and imports 3 more:`,
    );
    expect(md).toContain(
      '`.monoceros/conventions.md`, `.monoceros/servers.md`, `.monoceros/commands.md`.',
    );
    expect(md).toContain('Read it whole.');
  });

  it('counts deploy.md as an import and adds the pipeline rule when a service has one', () => {
    const md = generateAgentsMd({
      containerName: 'demo',
      languages: [],
      services: [
        {
          name: 'postgres',
          image: 'postgres:18',
          port: 5432,
          env: {},
          volumes: [],
        },
      ],
      features: [],
      repos: [],
      ports: [],
    });
    expect(md).toContain(
      `This file is ${LINE_COUNT_PLACEHOLDER} lines long and imports 4 more:`,
    );
    expect(md).toContain(
      '- Take a compose file for the pipeline from `.monoceros/deploy.md`',
    );
  });

  it('imports the two long chapters instead of carrying them', () => {
    const md = generateAgentsMd({
      containerName: 'demo',
      languages: [],
      services: [],
      features: [],
      repos: [],
      ports: [5173],
    });
    expect(md).toContain('@.monoceros/conventions.md');
    expect(md).toContain('@.monoceros/servers.md');
    // The chapters' own long form is gone from the briefing itself.
    expect(md).not.toContain('projects/<app>/.monoceros/launch.json`, then');
    expect(md).not.toContain('monoceros-ctl logs <app>');
    expect(md).not.toContain(
      '- **Write everything that goes into the repo in English**:',
    );
    expect(md).not.toContain('### Dev servers');
  });

  it('resolveLineCount replaces the placeholder with the file’s real line count', () => {
    const file = ['a', `lines: ${LINE_COUNT_PLACEHOLDER}`, 'c', ''].join('\n');
    // 3 lines, wc -l style: the trailing newline adds no fourth line.
    expect(resolveLineCount(file)).toBe('a\nlines: 3\nc\n');
  });

  it('lists languages with display names and skips section when empty', () => {
    const withLangs = generateAgentsMd({
      containerName: 'demo',
      languages: ['node', 'python', 'java:17'],
      services: [],
      features: [],
      repos: [],
      ports: [],
    });
    expect(withLangs).toContain('### Languages');
    expect(withLangs).toContain('- Node.js');
    expect(withLangs).toContain('- Python');
    expect(withLangs).toContain('- Java 17');

    const noLangs = generateAgentsMd({
      containerName: 'demo',
      languages: [],
      services: [],
      features: [],
      repos: [],
      ports: [],
    });
    expect(noLangs).not.toContain('### Languages');
  });

  it('distinguishes curated services from custom-image services and mentions credentials policy', () => {
    const md = generateAgentsMd({
      containerName: 'demo',
      languages: [],
      services: [
        {
          name: 'postgres',
          image: 'postgres:18',
          port: 5432,
          env: {},
          volumes: [],
          connectionEnv: {
            URL: 'postgresql://${host}:${port}/db',
            HOST: '${host}',
          },
        },
        {
          name: 'clickhouse',
          image: 'clickhouse/clickhouse-server:latest',
          port: 8123,
          env: {},
          volumes: [],
        },
      ],
      features: [],
      repos: [],
      ports: [],
    });
    expect(md).toContain('### Services (running on the Docker network)');
    expect(md).toContain('**postgres** — reachable at `postgres:5432`');
    expect(md).toContain(
      '**clickhouse** (custom image `clickhouse/clickhouse-server:latest`)',
    );
    // Curated services expose their connection via name-prefixed env vars.
    expect(md).toContain(
      'Connection details for the curated services above are set as',
    );
    expect(md).toContain('`POSTGRES_URL`');
    // Custom-image black-box clause appears only when a custom service exists.
    expect(md).toContain('black box reachable at');
  });

  it('omits the custom-image clause when all services are curated', () => {
    const md = generateAgentsMd({
      containerName: 'demo',
      languages: [],
      services: [
        {
          name: 'postgres',
          image: 'postgres:18',
          port: 5432,
          env: {},
          volumes: [],
        },
        { name: 'redis', image: 'redis:8', port: 6379, env: {}, volumes: [] },
      ],
      features: [],
      repos: [],
      ports: [],
    });
    expect(md).not.toContain('black box');
  });

  it("renders a curated service's descriptor briefing lines under the service", () => {
    const md = generateAgentsMd({
      containerName: 'demo',
      languages: [],
      services: [
        {
          name: 'keycloak',
          image: 'quay.io/keycloak/keycloak:26.6',
          port: 8080,
          env: {},
          volumes: [],
        },
      ],
      features: [],
      repos: [],
      ports: [],
    });
    // The per-service guidance is sourced from the descriptor's `briefing:`,
    // not hardcoded here - assert the realm-import guidance reaches the agent.
    expect(md).toContain('--import-realm');
    // The realm volume is handed to the agent as a copy-ready fenced YAML
    // block (single .json file → distinct target), not inline prose - so the
    // agent relays it verbatim instead of reshaping it into a directory mount.
    expect(md).toContain('```yaml');
    expect(md).toContain(
      'projects/<app>/keycloak/realm.json:/opt/keycloak/data/import/<app>.json:ro',
    );
    // A service with no descriptor briefing (redis) adds no extra lines.
    const redis = generateAgentsMd({
      containerName: 'demo',
      languages: [],
      services: [
        { name: 'redis', image: 'redis:8', port: 6379, env: {}, volumes: [] },
      ],
      features: [],
      repos: [],
      ports: [],
    });
    expect(redis).toContain('**redis** — reachable at `redis:6379`');
    expect(redis).not.toContain('--import-realm');
  });

  it('renders configured workspace binds under a service, grouped by project, with real paths', () => {
    const md = generateAgentsMd({
      containerName: 'demo',
      languages: [],
      services: [
        {
          name: 'keycloak',
          image: 'quay.io/keycloak/keycloak:26.6',
          port: 8080,
          env: {},
          volumes: [
            'projects/plantlove/keycloak/realm.json:/opt/keycloak/data/import/plantlove.json:ro',
            'projects/plantlove/keycloak/theme:/opt/keycloak/themes/plantlove',
            'projects/shop/keycloak/realm.json:/opt/keycloak/data/import/shop.json:ro',
            // A named volume (not a workspace bind) must not appear.
            'data:/opt/keycloak/data',
          ],
        },
      ],
      features: [],
      repos: [],
      ports: [],
    });
    expect(md).toContain(
      'Workspace mounts (edit these on the host, then re-apply):',
    );
    // Split by project: each project heads its own group.
    expect(md).toContain('- plantlove:');
    expect(md).toContain('- shop:');
    // Real paths, with the container target and the read-only marker.
    expect(md).toContain(
      '- `projects/plantlove/keycloak/realm.json` → `/opt/keycloak/data/import/plantlove.json` (read-only)',
    );
    expect(md).toContain(
      '- `projects/plantlove/keycloak/theme` → `/opt/keycloak/themes/plantlove`',
    );
    // The read-write theme mount carries no read-only marker.
    expect(md).not.toContain('/opt/keycloak/themes/plantlove` (read-only)');
    // Named volumes are host-managed and filtered out.
    expect(md).not.toContain('`data`');
  });

  it('omits the workspace-mounts block when a service has no project binds', () => {
    const md = generateAgentsMd({
      containerName: 'demo',
      languages: [],
      services: [
        {
          name: 'postgres',
          image: 'postgres:18',
          port: 5432,
          env: {},
          volumes: ['data:/var/lib/postgresql/data'],
        },
      ],
      features: [],
      repos: [],
      ports: [],
    });
    expect(md).not.toContain('Workspace mounts');
  });

  it('renders one bullet per feature line (single line per feature is the simple case)', () => {
    const md = generateAgentsMd({
      containerName: 'demo',
      languages: [],
      services: [],
      features: [
        { ref: 'ghcr.io/example/claude-code:1', lines: ['Claude Code'] },
        {
          ref: 'ghcr.io/example/atlassian:1',
          lines: [
            'Atlassian Rovo Dev (`acli rovodev`)',
            'Atlassian Teamwork Graph (`twg`)',
          ],
        },
      ],
      repos: [],
      ports: [],
    });
    expect(md).toContain('### Installed tools');
    expect(md).toContain('- Claude Code');
    expect(md).toContain('- Atlassian Rovo Dev (`acli rovodev`)');
    expect(md).toContain('- Atlassian Teamwork Graph (`twg`)');
  });

  it('renders repos and ports when present', () => {
    const md = generateAgentsMd({
      containerName: 'demo',
      languages: [],
      services: [],
      features: [],
      repos: [
        {
          url: 'https://github.com/conciso/logoscraper',
          path: 'logoscraper',
        },
      ],
      ports: [3000, 5173],
    });
    expect(md).toContain('### Cloned repos');
    expect(md).toContain(
      '- `projects/logoscraper/` ← https://github.com/conciso/logoscraper',
    );
    expect(md).toContain('### Reachable from outside the container');
    expect(md).toContain('3000 (default route) → http://demo.localhost');
    expect(md).toContain('5173 → http://demo-5173.localhost');
    // Tells the agent it can open the running app on the host browser.
    expect(md).toContain('xdg-open http://demo.localhost');
  });

  it('keeps .localhost URLs suffix-free at the default host port 80', () => {
    const md = generateAgentsMd({
      containerName: 'demo',
      languages: [],
      services: [],
      features: [],
      repos: [],
      ports: [3000, 5173],
      hostPort: 80,
    });
    // No `:80` clutter in the common case.
    expect(md).toContain('http://demo.localhost');
    expect(md).not.toContain('demo.localhost:80');
  });

  it('appends the host-port suffix to every .localhost URL when hostPort != 80', () => {
    const md = generateAgentsMd({
      containerName: 'demo',
      languages: [],
      services: [],
      features: [],
      repos: [],
      ports: [3000, 5173],
      hostPort: 8080,
    });
    // Default + secondary routes and xdg-open all carry the :8080 suffix —
    // otherwise the agent hits a dead :80. (The HMR hint and the 502 note
    // moved to servers.md and are covered there.)
    expect(md).toContain('3000 (default route) → http://demo.localhost:8080');
    expect(md).toContain('5173 → http://demo-5173.localhost:8080');
    expect(md).toContain('xdg-open http://demo.localhost:8080');
    // And never a bare port-less default route.
    expect(md).not.toContain('(default route) → http://demo.localhost\n');
  });

  it('always emits the @import to the commands reference at the end', () => {
    const md = generateAgentsMd({
      containerName: 'demo',
      languages: [],
      services: [],
      features: [],
      repos: [],
      ports: [],
    });
    expect(md).toContain('## Command reference');
    expect(md.trimEnd().endsWith('@.monoceros/commands.md')).toBe(true);
  });

  describe('agentsMdInputFromCreateOptions', () => {
    it('defaults hostPort to 80 and carries an explicit hostPort through', () => {
      const opts: CreateOptions = {
        name: 'demo',
        languages: [],
        services: [],
      };
      expect(agentsMdInputFromCreateOptions(opts, new Map()).hostPort).toBe(80);
      expect(
        agentsMdInputFromCreateOptions(opts, new Map(), undefined, 8080)
          .hostPort,
      ).toBe(8080);
    });

    it('falls back to the components-catalog displayName when no manifest briefing is available, and to the ref tail otherwise', () => {
      const opts: CreateOptions = {
        name: 'demo',
        languages: [],
        services: [],
        features: {
          'ghcr.io/getmonoceros/monoceros-features/claude-code:1': {},
          'ghcr.io/devcontainers/features/docker-in-docker:2': {},
        },
      };
      const map = new Map<string, string>([
        [
          'ghcr.io/getmonoceros/monoceros-features/claude-code:1',
          'Claude Code',
        ],
      ]);
      const input = agentsMdInputFromCreateOptions(opts, map);
      expect(input.features).toEqual([
        {
          ref: 'ghcr.io/getmonoceros/monoceros-features/claude-code:1',
          lines: ['Claude Code'],
        },
        {
          ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
          lines: ['docker-in-docker'],
        },
      ]);
    });

    it('uses manifest briefing lines and filters by truthy whenOption against merged user + default options', () => {
      const manifest: FeatureManifestSummary = {
        name: 'Atlassian',
        description: '',
        documentationURL: undefined,
        docsSlug: 'x',
        optionHints: [],
        optionDescriptions: {},
        optionNames: ['rovodev', 'twg'],
        optionTypes: { rovodev: 'boolean', twg: 'boolean' },
        optionDefaults: { rovodev: true, twg: true },
        usageNotes: [],
        briefing: {
          lines: [
            { text: 'Rovo Dev', whenOption: 'rovodev' },
            { text: 'twg', whenOption: 'twg' },
          ],
        },
      };
      const loader = (ref: string) =>
        ref === 'ghcr.io/getmonoceros/monoceros-features/atlassian:1'
          ? manifest
          : undefined;

      // Both defaults apply — user supplied no overrides.
      let opts: CreateOptions = {
        name: 'demo',
        languages: [],
        services: [],
        features: { 'ghcr.io/getmonoceros/monoceros-features/atlassian:1': {} },
      };
      let input = agentsMdInputFromCreateOptions(opts, new Map(), loader);
      expect(input.features[0]!.lines).toEqual(['Rovo Dev', 'twg']);

      // User disables twg — only Rovo Dev line remains.
      opts = {
        name: 'demo',
        languages: [],
        services: [],
        features: {
          'ghcr.io/getmonoceros/monoceros-features/atlassian:1': { twg: false },
        },
      };
      input = agentsMdInputFromCreateOptions(opts, new Map(), loader);
      expect(input.features[0]!.lines).toEqual(['Rovo Dev']);

      // User disables both — feature is silently omitted (no lines).
      opts = {
        name: 'demo',
        languages: [],
        services: [],
        features: {
          'ghcr.io/getmonoceros/monoceros-features/atlassian:1': {
            rovodev: false,
            twg: false,
          },
        },
      };
      input = agentsMdInputFromCreateOptions(opts, new Map(), loader);
      expect(input.features).toEqual([]);
    });

    it('treats non-empty string options as truthy for whenOption', () => {
      const manifest: FeatureManifestSummary = {
        name: '',
        description: '',
        documentationURL: undefined,
        docsSlug: 'x',
        optionHints: [],
        optionDescriptions: {},
        optionNames: ['apiKey'],
        optionTypes: { apiKey: 'string' },
        optionDefaults: { apiKey: '' },
        usageNotes: [],
        briefing: {
          lines: [
            { text: 'always-on baseline' },
            { text: 'API-key mode active', whenOption: 'apiKey' },
          ],
        },
      };
      const loader = () => manifest;

      let opts: CreateOptions = {
        name: 'demo',
        languages: [],
        services: [],
        features: { 'ghcr.io/x/y:1': {} },
      };
      let input = agentsMdInputFromCreateOptions(opts, new Map(), loader);
      expect(input.features[0]!.lines).toEqual(['always-on baseline']);

      opts = {
        name: 'demo',
        languages: [],
        services: [],
        features: { 'ghcr.io/x/y:1': { apiKey: 'sk-ant-...' } },
      };
      input = agentsMdInputFromCreateOptions(opts, new Map(), loader);
      expect(input.features[0]!.lines).toEqual([
        'always-on baseline',
        'API-key mode active',
      ]);
    });
  });
});

describe('AGENTS.md: what is reachable from outside', () => {
  it('lists a reachable service with its host address and env var', () => {
    const md = generateAgentsMd({
      containerName: 'acme',
      languages: ['node'],
      services: [
        {
          name: 'caddy',
          image: 'caddy:2',
          port: 81,
          httpPort: 81,
          env: {},
          volumes: [],
        },
        {
          name: 'postgres',
          image: 'postgres:18',
          port: 5432,
          env: {},
          volumes: [],
        },
      ],
      features: [],
      repos: [],
      ports: [5173],
    });
    expect(md).toContain('### Reachable from outside the container');
    expect(md).toContain('http://acme-caddy.localhost');
    expect(md).toContain('$CADDY_PUBLIC_URL');
    // a database has no outside address, so it must not appear here
    expect(md).not.toContain('acme-postgres.localhost');
    // the per-request truth is named, since these names are host-only
    expect(md).toContain('X-Forwarded-Host');
    // and the workspace's own name is in the environment, not just in prose
    expect(md).toContain('$WORKSPACE_HOST');
  });
});
