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
        },
        {
          name: 'rustfs',
          image: 'rustfs/rustfs:latest',
          port: 9000,
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
    expect(md).toContain('**rustfs** (custom image `rustfs/rustfs:latest`)');
    // Curated services expose their connection via env vars (postgres here).
    expect(md).toContain(
      'Connection details for the curated services above are already set as',
    );
    expect(md).toContain('`DATABASE_URL`');
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
