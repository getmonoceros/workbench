import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentsPresent,
  toClaudeMcpConfig,
  toOpencodeMcpConfig,
  toRovodevMcpConfig,
  writeMcpRegistrations,
} from '../src/create/mcp-registration.js';
import type { ResolvedMcpServer } from '../src/catalog/mcp.js';

const CLAUDE_REF = 'ghcr.io/getmonoceros/monoceros-features/claude-code:1';
const OPENCODE_REF = 'ghcr.io/getmonoceros/monoceros-features/opencode:1';
const ATLASSIAN_REF = 'ghcr.io/getmonoceros/monoceros-features/atlassian:1';
const CLAUDE = { [CLAUDE_REF]: {} };
const OPENCODE = { [OPENCODE_REF]: {} };
const BOTH = { ...CLAUDE, ...OPENCODE };
const ROVODEV = { [ATLASSIAN_REF]: { rovodev: true } };

const remote = (name: string, key = 'k'): ResolvedMcpServer => ({
  name,
  transport: 'http',
  url: `https://example.test/${name}`,
  headers: { API_KEY: key },
  fromCatalog: true,
});

const stdio = (name: string): ResolvedMcpServer => ({
  name,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', `${name}-mcp`],
  fromCatalog: false,
});

describe('toClaudeMcpConfig', () => {
  it('omits `type` for stdio, so it matches what providers publish', () => {
    expect(toClaudeMcpConfig(stdio('notion'))).toEqual({
      command: 'npx',
      args: ['-y', 'notion-mcp'],
    });
  });

  it('sets `type` for a remote transport and keeps the headers', () => {
    expect(toClaudeMcpConfig(remote('context7', 'ctx7sk-1'))).toEqual({
      type: 'http',
      url: 'https://example.test/context7',
      headers: { API_KEY: 'ctx7sk-1' },
    });
  });

  it('drops empty args/env rather than writing noise', () => {
    expect(
      toClaudeMcpConfig({
        name: 'bare',
        transport: 'stdio',
        command: 'server',
        args: [],
        env: {},
        fromCatalog: false,
      }),
    ).toEqual({ command: 'server' });
  });
});

describe('agentsPresent', () => {
  it('detects each agent by its monoceros ref, whatever the tag', () => {
    expect(agentsPresent(CLAUDE).map((a) => a.id)).toEqual(['claudeCode']);
    expect(agentsPresent(OPENCODE).map((a) => a.id)).toEqual(['opencode']);
    expect(agentsPresent(BOTH).map((a) => a.id)).toEqual([
      'claudeCode',
      'opencode',
    ]);
    expect(
      agentsPresent({
        'ghcr.io/getmonoceros/monoceros-features/claude-code:1.2.0': {},
      }).map((a) => a.id),
    ).toEqual(['claudeCode']);
    // A third-party ref that merely ends in the same leaf is not our feature.
    expect(
      agentsPresent({ 'ghcr.io/other/features/claude-code:1': {} }),
    ).toEqual([]);
    expect(agentsPresent(undefined)).toEqual([]);
  });

  it('counts Rovo Dev only when the atlassian feature actually installs it', () => {
    expect(agentsPresent(ROVODEV).map((a) => a.id)).toEqual(['rovodev']);
    // twg-only or forge-only: the feature is there, acli is not.
    expect(
      agentsPresent({ [ATLASSIAN_REF]: { rovodev: false, twg: true } }),
    ).toEqual([]);
    expect(agentsPresent({ [ATLASSIAN_REF]: { rovodev: 'false' } })).toEqual(
      [],
    );
    // Absent option means the descriptor default, which is on.
    expect(agentsPresent({ [ATLASSIAN_REF]: {} }).map((a) => a.id)).toEqual([
      'rovodev',
    ]);
  });
});

describe('toRovodevMcpConfig', () => {
  it('names the transport, the way rovodev mcp.json does', () => {
    expect(toRovodevMcpConfig(remote('context7', 'k1'))).toEqual({
      transport: 'http',
      url: 'https://example.test/context7',
      headers: { API_KEY: 'k1' },
    });
    expect(
      toRovodevMcpConfig({
        name: 'notion',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'notion-mcp'],
        env: { NOTION_TOKEN: 'ntn_1' },
        fromCatalog: false,
      }),
    ).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'notion-mcp'],
      env: { NOTION_TOKEN: 'ntn_1' },
    });
  });

  it('never sets enable_instructions, which would put server prose in the prompt', () => {
    const config = toRovodevMcpConfig(remote('context7')) as unknown as Record<
      string,
      unknown
    >;
    expect('enable_instructions' in config).toBe(false);
  });
});

describe('toOpencodeMcpConfig', () => {
  it('folds command and args into one array, and env into `environment`', () => {
    expect(
      toOpencodeMcpConfig({
        name: 'notion',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'notion-mcp'],
        env: { NOTION_TOKEN: 'ntn_1' },
        fromCatalog: false,
      }),
    ).toEqual({
      type: 'local',
      command: ['npx', '-y', 'notion-mcp'],
      environment: { NOTION_TOKEN: 'ntn_1' },
      enabled: true,
    });
  });

  it('maps both remote transports to `remote`, since OpenCode has no sse type', () => {
    expect(toOpencodeMcpConfig(remote('context7', 'k1'))).toEqual({
      type: 'remote',
      url: 'https://example.test/context7',
      headers: { API_KEY: 'k1' },
      enabled: true,
    });
    expect(
      toOpencodeMcpConfig({
        name: 'sse-thing',
        transport: 'sse',
        url: 'https://example.test/sse',
        fromCatalog: true,
      }),
    ).toEqual({
      type: 'remote',
      url: 'https://example.test/sse',
      enabled: true,
    });
  });
});

describe('writeMcpRegistrations', () => {
  let dir: string;
  const configFile = (): string => path.join(dir, 'home', '.claude.json');
  const opencodeFile = (): string =>
    path.join(dir, 'home', '.config', 'opencode', 'opencode.json');
  const recordFile = (): string =>
    path.join(dir, '.monoceros', 'mcp-registrations.json');
  interface ClaudeConfigFile {
    mcpServers?: Record<string, unknown>;
    projects?: unknown;
    numStartups?: number;
  }
  const readConfig = async (): Promise<ClaudeConfigFile> =>
    JSON.parse(await fsp.readFile(configFile(), 'utf8')) as ClaudeConfigFile;
  const serverNames = async (): Promise<string[]> =>
    Object.keys((await readConfig()).mcpServers ?? {});

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'monoceros-mcp-'));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const seedConfig = async (config: unknown): Promise<void> => {
    await fsp.mkdir(path.join(dir, 'home'), { recursive: true });
    await fsp.writeFile(configFile(), JSON.stringify(config, null, 2));
  };

  it('registers the servers and records what it owns', async () => {
    await writeMcpRegistrations(dir, CLAUDE, [remote('context7')], 'acme');
    expect(await serverNames()).toEqual(['context7']);
    expect(JSON.parse(await fsp.readFile(recordFile(), 'utf8'))).toEqual({
      schemaVersion: 1,
      claudeCode: ['context7'],
    });
  });

  it('leaves every other key in the file alone', async () => {
    await seedConfig({
      projects: { '/workspaces/acme': { hasTrustDialogAccepted: true } },
      numStartups: 7,
    });
    await writeMcpRegistrations(dir, CLAUDE, [remote('context7')], 'acme');
    const config = await readConfig();
    expect(config.projects).toEqual({
      '/workspaces/acme': { hasTrustDialogAccepted: true },
    });
    expect(config.numStartups).toBe(7);
  });

  it('is idempotent across repeated applies', async () => {
    await writeMcpRegistrations(dir, CLAUDE, [remote('context7')], 'acme');
    const first = await fsp.readFile(configFile(), 'utf8');
    await writeMcpRegistrations(dir, CLAUDE, [remote('context7')], 'acme');
    expect(await fsp.readFile(configFile(), 'utf8')).toBe(first);
  });

  it('drops a server it registered once the yml no longer lists it', async () => {
    await writeMcpRegistrations(
      dir,
      CLAUDE,
      [remote('context7'), stdio('notion')],
      'acme',
    );
    await writeMcpRegistrations(dir, CLAUDE, [remote('context7')], 'acme');
    expect(await serverNames()).toEqual(['context7']);
  });

  it('keeps a hand-added server when a connector is removed', async () => {
    await writeMcpRegistrations(dir, CLAUDE, [remote('context7')], 'acme');
    // Simulate `claude mcp add` inside the container.
    const config = await readConfig();
    await seedConfig({
      ...config,
      mcpServers: {
        ...config.mcpServers,
        mine: { command: 'node', args: ['s.js'] },
      },
    });
    await writeMcpRegistrations(dir, CLAUDE, [], 'acme');
    expect(await serverNames()).toEqual(['mine']);
  });

  it('halts when a yml entry collides with a hand-added server', async () => {
    await seedConfig({
      mcpServers: { context7: { command: 'node', args: ['mine.js'] } },
    });
    await expect(
      writeMcpRegistrations(dir, CLAUDE, [remote('context7')], 'acme'),
    ).rejects.toThrow(/already registered in Claude Code by hand/);
    // The builder's own definition is untouched by the failed apply.
    const config = await readConfig();
    expect(config.mcpServers).toEqual({
      context7: { command: 'node', args: ['mine.js'] },
    });
  });

  it('names both exits in the collision error', async () => {
    await seedConfig({ mcpServers: { context7: { command: 'node' } } });
    await expect(
      writeMcpRegistrations(dir, CLAUDE, [remote('context7')], 'acme'),
    ).rejects.toThrow(
      /monoceros remove-mcp-server acme context7[\s\S]*claude mcp remove context7/,
    );
  });

  it('writes nothing at all without agents and without connectors', async () => {
    await writeMcpRegistrations(dir, undefined, [], 'acme');
    await expect(fsp.stat(configFile())).rejects.toThrow();
    await expect(fsp.stat(recordFile())).rejects.toThrow();
  });

  it('cleans up its registrations when the agent itself is removed', async () => {
    await writeMcpRegistrations(dir, CLAUDE, [remote('context7')], 'acme');
    // claude-code dropped from the yml: the servers have no agent left, so the
    // entries we own have to go rather than linger in a file that survives.
    await writeMcpRegistrations(dir, undefined, [remote('context7')], 'acme');
    const config = await readConfig();
    expect(config.mcpServers).toBeUndefined();
  });

  it('registers with every agent in the container, not just the first', async () => {
    await writeMcpRegistrations(dir, BOTH, [remote('context7')], 'acme');
    expect(await serverNames()).toEqual(['context7']);
    const opencode = JSON.parse(await fsp.readFile(opencodeFile(), 'utf8')) as {
      mcp: Record<string, { type: string; enabled: boolean }>;
    };
    expect(opencode.mcp.context7).toEqual({
      type: 'remote',
      url: 'https://example.test/context7',
      headers: { API_KEY: 'k' },
      enabled: true,
    });
    expect(JSON.parse(await fsp.readFile(recordFile(), 'utf8'))).toEqual({
      schemaVersion: 1,
      claudeCode: ['context7'],
      opencode: ['context7'],
    });
  });

  it('leaves an absent agent alone', async () => {
    await writeMcpRegistrations(dir, OPENCODE, [remote('context7')], 'acme');
    await expect(fsp.stat(configFile())).rejects.toThrow();
    expect(
      (
        JSON.parse(await fsp.readFile(recordFile(), 'utf8')) as {
          claudeCode?: string[];
        }
      ).claudeCode,
    ).toBeUndefined();
  });

  it('keeps the rest of opencode.json, which the feature writer owns', async () => {
    await fsp.mkdir(path.dirname(opencodeFile()), { recursive: true });
    await fsp.writeFile(
      opencodeFile(),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        model: 'anthropic/claude-sonnet-4-6',
        instructions: ['/workspaces/acme/AGENTS.md'],
      }),
    );
    await writeMcpRegistrations(dir, OPENCODE, [remote('context7')], 'acme');
    const config = JSON.parse(await fsp.readFile(opencodeFile(), 'utf8')) as {
      model: string;
      instructions: string[];
      mcp: Record<string, unknown>;
    };
    expect(config.model).toBe('anthropic/claude-sonnet-4-6');
    expect(config.instructions).toEqual(['/workspaces/acme/AGENTS.md']);
    expect(Object.keys(config.mcp)).toEqual(['context7']);
  });

  it('cleans up in an agent whose feature left the yml', async () => {
    await writeMcpRegistrations(dir, BOTH, [remote('context7')], 'acme');
    // opencode dropped from the yml, claude stays.
    await writeMcpRegistrations(dir, CLAUDE, [remote('context7')], 'acme');
    const opencode = JSON.parse(await fsp.readFile(opencodeFile(), 'utf8')) as {
      mcp?: Record<string, unknown>;
    };
    expect(opencode.mcp).toBeUndefined();
    expect(await serverNames()).toEqual(['context7']);
  });

  it('registers with Rovo Dev in its own mcp.json', async () => {
    await writeMcpRegistrations(dir, ROVODEV, [remote('context7')], 'acme');
    const config = JSON.parse(
      await fsp.readFile(
        path.join(dir, 'home', '.rovodev', 'mcp.json'),
        'utf8',
      ),
    ) as { mcpServers: Record<string, { transport: string }> };
    expect(config.mcpServers.context7?.transport).toBe('http');
    expect(
      (
        JSON.parse(await fsp.readFile(recordFile(), 'utf8')) as {
          rovodev?: string[];
        }
      ).rovodev,
    ).toEqual(['context7']);
  });

  it('names the agent in a collision error', async () => {
    await fsp.mkdir(path.dirname(opencodeFile()), { recursive: true });
    await fsp.writeFile(
      opencodeFile(),
      JSON.stringify({ mcp: { context7: { type: 'local' } } }),
    );
    await expect(
      writeMcpRegistrations(dir, OPENCODE, [remote('context7')], 'acme'),
    ).rejects.toThrow(/already registered in OpenCode by hand/);
  });

  it('removes the mcpServers key entirely when nothing is left', async () => {
    await seedConfig({ numStartups: 1 });
    await writeMcpRegistrations(dir, CLAUDE, [remote('context7')], 'acme');
    await writeMcpRegistrations(dir, CLAUDE, [], 'acme');
    const config = await readConfig();
    expect('mcpServers' in config).toBe(false);
    expect(config.numStartups).toBe(1);
  });
});
