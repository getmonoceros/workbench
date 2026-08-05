import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkMcpServers } from '../src/check/mcp.js';
import { validateConfig } from '../src/config/schema.js';

const CLAUDE_REF = 'ghcr.io/getmonoceros/monoceros-features/claude-code:1';
const OPENCODE_REF = 'ghcr.io/getmonoceros/monoceros-features/opencode:1';

/**
 * Offline throughout (`probe: false`): these cover the link between the yml and
 * the agent's config file, which is where a real workbench goes wrong. The live
 * probe is verified against a running container, not here.
 */
describe('checkMcpServers', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'monoceros-check-mcp-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const config = (names: string[]) =>
    validateConfig({
      schemaVersion: 1,
      name: 'acme',
      mcpServers: names.map((name) => ({ name })),
    });

  const writeClaudeConfig = async (servers: object): Promise<void> => {
    await mkdir(path.join(root, 'home'), { recursive: true });
    await writeFile(
      path.join(root, 'home', '.claude.json'),
      JSON.stringify({ mcpServers: servers }),
    );
  };

  const writeOpencodeConfig = async (servers: object): Promise<void> => {
    const dir = path.join(root, 'home', '.config', 'opencode');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'opencode.json'),
      JSON.stringify({ mcp: servers }),
    );
  };

  it('reports a yml entry the agent config does not have', async () => {
    await writeClaudeConfig({});
    const { findings } = await checkMcpServers(
      root,
      'acme',
      config(['context7']),
      { [CLAUDE_REF]: {} },
      { probe: false },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('mcp-servers');
    expect(findings[0]!.what).toMatch(
      /yml registers 'context7' but Claude Code's config does not have it/,
    );
    expect(findings[0]!.fix).toMatch(/monoceros apply acme/);
  });

  it('reports the gap per agent, so a half-applied container is visible', async () => {
    await writeClaudeConfig({ context7: { type: 'http', url: 'https://x' } });
    await writeOpencodeConfig({});
    const { findings } = await checkMcpServers(
      root,
      'acme',
      config(['context7']),
      { [CLAUDE_REF]: {}, [OPENCODE_REF]: {} },
      { probe: false },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.where).toContain('opencode.json');
  });

  it('is quiet when every agent carries every entry', async () => {
    await writeClaudeConfig({ context7: { type: 'http', url: 'https://x' } });
    await writeOpencodeConfig({
      context7: { type: 'remote', url: 'https://x', enabled: true },
    });
    const { findings, probes } = await checkMcpServers(
      root,
      'acme',
      config(['context7']),
      { [CLAUDE_REF]: {}, [OPENCODE_REF]: {} },
      { probe: false },
    );
    expect(findings).toEqual([]);
    expect(probes).toHaveLength(1);
    expect(probes[0]!.registeredFor).toEqual(['Claude Code', 'OpenCode']);
  });

  it('reports servers with no agent to use them', async () => {
    const { findings } = await checkMcpServers(
      root,
      'acme',
      config(['context7']),
      {},
      { probe: false },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.what).toMatch(/no agent to use them/);
  });

  it('marks a stdio server as unprobed rather than reporting it as fine', async () => {
    await writeClaudeConfig({ notion: { command: 'npx', args: ['-y', 'x'] } });
    const { findings, probes } = await checkMcpServers(
      root,
      'acme',
      config(['notion']),
      { [CLAUDE_REF]: {} },
      { probe: false },
    );
    expect(findings).toEqual([]);
    expect(probes[0]).toEqual({
      name: 'notion',
      transport: 'stdio',
      registeredFor: ['Claude Code'],
    });
  });

  it('does nothing at all for a workbench with neither servers nor agents', async () => {
    const result = await checkMcpServers(
      root,
      'acme',
      config([]),
      {},
      {
        probe: false,
      },
    );
    expect(result).toEqual({ findings: [], probes: [] });
  });
});
