import { describe, expect, it } from 'vitest';
import {
  agentsMdInputFromCreateOptions,
  generateAgentsMd,
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
    // The agent must build under projects/, not at the workspace root.
    expect(md).toContain('Build everything under `/workspaces/demo/projects/`');
    // Self-scaffolded projects must be registered in the workspace file so
    // VS Code opened from the host lists them (clones get added by apply).
    expect(md).toContain('Register new projects in `demo.code-workspace`');
    expect(md).toContain('/workspaces/demo/demo.code-workspace');
    expect(md).toContain('{ "path": "projects/<app>", "name": "<app>" }');
    // One root per top-level dir under projects/, not per sub-project,
    // so the Explorer stays readable as more projects land.
    expect(md).toContain(
      'Add **exactly one** folder entry per directory directly under `projects/`',
    );
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
    expect(md).toContain('### Exposed ports');
    expect(md).toContain('3000 (default route) → http://demo.localhost');
    expect(md).toContain('5173 → http://demo-5173.localhost');
    // Tells the agent it can open the running app on the host browser.
    expect(md).toContain('xdg-open http://demo.localhost');
  });

  it('always briefs the launch config, with an add-port step when no ports exist', () => {
    const noPorts = generateAgentsMd({
      containerName: 'demo',
      languages: ['node'],
      services: [],
      features: [],
      repos: [],
      ports: [],
    });
    // Emitted even with zero ports: otherwise a port-less workbench leaves the
    // agent with no hint the launch-config mechanism exists at all.
    expect(noPorts).toContain('## Running a long-running server');
    expect(noPorts).toContain('projects/<app>/.monoceros/launch.json');
    // It resolves the chicken-and-egg: have the user add a port first.
    expect(noPorts).toContain('This container exposes **no ports yet**');
    expect(noPorts).toContain('monoceros add-port demo <port>');
    // The example carries a placeholder port, not an invented real one.
    expect(noPorts).toContain('"port": <port>');

    const withPorts = generateAgentsMd({
      containerName: 'demo',
      languages: ['node'],
      services: [],
      features: [],
      repos: [],
      ports: [5173],
    });
    expect(withPorts).toContain('## Running a long-running server');
    expect(withPorts).toContain('"port": 5173');
    expect(withPorts).not.toContain('This container exposes **no ports yet**');
  });

  it('shows a multi-server default set and tells the agent to keep later servers in it', () => {
    const md = generateAgentsMd({
      containerName: 'demo',
      languages: ['node'],
      services: [],
      features: [],
      repos: [],
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
    const onePort = generateAgentsMd({
      containerName: 'demo',
      languages: ['node'],
      services: [],
      features: [],
      repos: [],
      ports: [3000],
    });
    expect(onePort).toContain('"name": "web"');
    expect(onePort).toContain('"port": <port>, "default": true');
    // The incremental case: a server added later must be re-evaluated for
    // the default set, not left out because one default already exists.
    expect(md).toContain('When you add a server in a later session');
    expect(md).toContain(
      'does not mean later servers should\nstay non-default',
    );
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
    // Default + secondary routes, xdg-open, HMR hint, and the 502 note all
    // carry the :8080 suffix — otherwise the agent hits a dead :80.
    expect(md).toContain('3000 (default route) → http://demo.localhost:8080');
    expect(md).toContain('5173 → http://demo-5173.localhost:8080');
    expect(md).toContain('xdg-open http://demo.localhost:8080');
    expect(md).toContain('`<name>.localhost:8080`');
    expect(md).toContain('`demo.localhost:8080` returns 502 Bad Gateway');
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
