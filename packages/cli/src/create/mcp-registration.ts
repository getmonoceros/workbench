import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { matchMonocerosFeature } from '../util/ref.js';
import type { McpTransport } from '../config/schema.js';
import type { ResolvedMcpServer } from '../catalog/mcp.js';
import type { CreateOptions } from './types.js';

/**
 * Register the container's `mcpServers:` entries with every agent present in it,
 * by merging them into that agent's own config at apply (ADR 0045).
 *
 * Two properties of those files shape everything here. They **survive apply**
 * (persistent-home paths, bind-mounted out of `container/<name>/home/`, seeded
 * once and never truncated), and **the agent writes to them itself**: Claude
 * keeps project trust and history in `.claude.json`, OpenCode keeps whatever the
 * builder put in `opencode.json`, and either may hold a server added by hand. So
 * this merges rather than writes: only the servers key is touched, and inside it
 * only the entries Monoceros put there.
 *
 * Which entries those are is recorded per agent in
 * `.monoceros/mcp-registrations.json`, host-side, in Monoceros' own directory.
 * Not as an extra key inside the agent's file: that file belongs to another tool,
 * and a foreign key in it is exactly the kind of detail that breaks on the next
 * update. It is also not in `state.json`, which answers a different question
 * (which yml this container came from) and is written by apply after the
 * scaffold, whereas the record has to be read and written in the same step as
 * the merge.
 *
 * Without that record a connector removed from the yml could not disappear
 * without taking a hand-added server of the same name with it.
 *
 * Every agent in the container gets the same servers. The briefing tells all of
 * them the servers are there, so registering for only some would make the
 * briefing lie to the rest.
 */

/** Claude Code's per-server shape, as published in its own docs. */
interface ClaudeMcpServerConfig {
  type?: 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * Rovo Dev's per-server shape, from `~/.rovodev/mcp.json`. Closest of the three
 * to our own vocabulary: it names the transport with the same three words.
 *
 * `enable_instructions` is deliberately never set. It hands the server's own
 * instructions to the agent as part of its prompt, which is a prompt-injection
 * surface we are not going to open on the builder's behalf.
 */
interface RovodevMcpServerConfig {
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * OpenCode's per-server shape. Differs from Claude's in three ways that all
 * matter: `local`/`remote` instead of the transport name (so `http` and `sse`
 * both land on `remote`), `command` is one array holding the executable *and*
 * its args, and the env key is `environment`.
 */
interface OpencodeMcpServerConfig {
  type: 'local' | 'remote';
  command?: string[];
  environment?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

/** Agents whose config Monoceros writes MCP registrations into. */
export type AgentId = 'claudeCode' | 'opencode' | 'rovodev';

export interface AgentTarget {
  id: AgentId;
  /** Catalog feature name that puts this agent in the container. */
  featureName: string;
  /** Builder-facing name, for errors. */
  label: string;
  /** Config file, relative to the container dir. */
  configPath: readonly string[];
  /** Key inside that file holding the server map. */
  serversKey: string;
  toConfig: (server: ResolvedMcpServer) => unknown;
  /** How the builder removes a hand-added server from this agent. */
  manualRemoval: (name: string) => string;
  /**
   * Extra condition on the feature's options. Rovo Dev ships inside the
   * atlassian feature, which installs three CLIs behind three toggles, so the
   * feature being present does not mean acli is.
   */
  enabledFor?: (options: Record<string, unknown>) => boolean;
}

const AGENTS: readonly AgentTarget[] = [
  {
    id: 'claudeCode',
    featureName: 'claude-code',
    label: 'Claude Code',
    configPath: ['home', '.claude.json'],
    serversKey: 'mcpServers',
    toConfig: toClaudeMcpConfig,
    manualRemoval: (name) => `claude mcp remove ${name}`,
  },
  {
    id: 'opencode',
    featureName: 'opencode',
    label: 'OpenCode',
    configPath: ['home', '.config', 'opencode', 'opencode.json'],
    serversKey: 'mcp',
    toConfig: toOpencodeMcpConfig,
    // OpenCode has no `mcp remove` subcommand; the config file is the interface.
    manualRemoval: (name) =>
      `remove "${name}" from home/.config/opencode/opencode.json`,
  },
  {
    id: 'rovodev',
    featureName: 'atlassian',
    label: 'Rovo Dev',
    configPath: ['home', '.rovodev', 'mcp.json'],
    serversKey: 'mcpServers',
    toConfig: toRovodevMcpConfig,
    manualRemoval: (name) => `acli rovodev mcp, then delete "${name}"`,
    // The atlassian feature also carries twg and Forge; only the `rovodev`
    // toggle puts acli in the container. Default true, matching the descriptor.
    enabledFor: (options) =>
      options.rovodev !== false && options.rovodev !== 'false',
  },
];

interface McpRegistrationRecord {
  schemaVersion: 1;
  /** Server names Monoceros registered on the last apply, per agent. */
  claudeCode?: string[];
  opencode?: string[];
  rovodev?: string[];
}

const REGISTRATION_FILE = ['.monoceros', 'mcp-registrations.json'];

/** The agents this container actually has, in AGENTS order. */
export function agentsPresent(
  features: CreateOptions['features'],
): AgentTarget[] {
  if (!features) return [];
  return AGENTS.filter((agent) => {
    const entry = Object.entries(features).find(
      ([ref]) => matchMonocerosFeature(ref)?.name === agent.featureName,
    );
    if (!entry) return false;
    return agent.enabledFor?.(entry[1] ?? {}) ?? true;
  });
}

/**
 * Error for a yml that lists MCP servers but has no agent to register them
 * with. A silently ignored `mcpServers:` block would look like a working
 * container whose agent simply cannot see the tools.
 */
export function formatNoAgentError(
  servers: readonly ResolvedMcpServer[],
  containerName: string,
): string {
  const names = servers.map((s) => s.name).join(', ');
  return (
    `The yml registers MCP servers (${names}) but the container has no agent to register them with.\n` +
    `Add one (\`monoceros add-feature ${containerName} claude\`, \`… opencode\` or ` +
    `\`… atlassian\`) or remove the ` +
    `\`mcpServers:\` entries ` +
    `(\`monoceros remove-mcp-server ${containerName} ${servers[0]?.name ?? '<connector>'}\`).`
  );
}

export function toClaudeMcpConfig(
  server: ResolvedMcpServer,
): ClaudeMcpServerConfig {
  if (server.transport === 'stdio') {
    // No `type` for stdio: it is the default and every published snippet omits
    // it, so this stays byte-comparable with what a builder pastes by hand.
    const out: ClaudeMcpServerConfig = { command: server.command! };
    if (server.args && server.args.length > 0) out.args = [...server.args];
    if (server.env && Object.keys(server.env).length > 0) {
      out.env = { ...server.env };
    }
    return out;
  }
  const out: ClaudeMcpServerConfig = {
    type: server.transport,
    url: server.url!,
  };
  if (server.headers && Object.keys(server.headers).length > 0) {
    out.headers = { ...server.headers };
  }
  return out;
}

export function toRovodevMcpConfig(
  server: ResolvedMcpServer,
): RovodevMcpServerConfig {
  if (server.transport === 'stdio') {
    const out: RovodevMcpServerConfig = {
      transport: 'stdio',
      command: server.command!,
    };
    if (server.args && server.args.length > 0) out.args = [...server.args];
    if (server.env && Object.keys(server.env).length > 0) {
      out.env = { ...server.env };
    }
    return out;
  }
  const out: RovodevMcpServerConfig = {
    transport: server.transport,
    url: server.url!,
  };
  if (server.headers && Object.keys(server.headers).length > 0) {
    out.headers = { ...server.headers };
  }
  return out;
}

export function toOpencodeMcpConfig(
  server: ResolvedMcpServer,
): OpencodeMcpServerConfig {
  if (server.transport === 'stdio') {
    const out: OpencodeMcpServerConfig = {
      type: 'local',
      command: [server.command!, ...(server.args ?? [])],
      enabled: true,
    };
    if (server.env && Object.keys(server.env).length > 0) {
      out.environment = { ...server.env };
    }
    return out;
  }
  // `sse` collapses into `remote` too: OpenCode has no separate type for it.
  const out: OpencodeMcpServerConfig = {
    type: 'remote',
    url: server.url!,
    enabled: true,
  };
  if (server.headers && Object.keys(server.headers).length > 0) {
    out.headers = { ...server.headers };
  }
  return out;
}

/**
 * Merge the resolved servers into every present agent's config. No-op for an
 * agent that is not in the container, and a whole no-op when nothing was ever
 * registered and nothing is asked for.
 *
 * Throws when a server name is present in an agent's config but was not put
 * there by Monoceros: that is a hand-added server colliding with a yml entry,
 * and there is no defensible precedence between the two. Halting says which
 * name, in which agent, and that it has to go from one side or the other.
 */
export async function writeMcpRegistrations(
  targetDir: string,
  features: CreateOptions['features'],
  servers: readonly ResolvedMcpServer[],
  containerName: string,
): Promise<void> {
  const recordPath = path.join(targetDir, ...REGISTRATION_FILE);
  const record = await readRegistrations(recordPath);
  const present = agentsPresent(features);
  const presentIds = new Set(present.map((a) => a.id));

  // Every agent that either should get servers now or got some last time. The
  // second case matters when the agent feature itself leaves the yml: its
  // registrations have to go, and the config file survives apply.
  const touched = AGENTS.filter(
    (a) => presentIds.has(a.id) || (record[a.id] ?? []).length > 0,
  );
  if (touched.length === 0) return;

  for (const agent of touched) {
    const wanted = presentIds.has(agent.id) ? servers : [];
    const owned = record[agent.id] ?? [];
    if (wanted.length === 0 && owned.length === 0) continue;
    await mergeIntoAgent(targetDir, agent, wanted, owned, containerName);
    record[agent.id] = wanted.map((s) => s.name).sort();
  }
  await writeRegistrations(recordPath, record);
}

async function mergeIntoAgent(
  targetDir: string,
  agent: AgentTarget,
  wanted: readonly ResolvedMcpServer[],
  owned: readonly string[],
  containerName: string,
): Promise<void> {
  const file = path.join(targetDir, ...agent.configPath);
  const config = await readJsonObject(file);
  const existing = config[agent.serversKey];
  const registered: Record<string, unknown> =
    typeof existing === 'object' && existing !== null
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const ownedSet = new Set(owned);
  const collisions = wanted
    .map((s) => s.name)
    .filter((name) => name in registered && !ownedSet.has(name));
  if (collisions.length > 0) {
    throw new Error(formatCollisionError(collisions, containerName, agent));
  }

  // Drop what we registered last time and the yml no longer asks for. Anything
  // the builder added by hand is not in `owned`, so it stays.
  const wantedNames = new Set(wanted.map((s) => s.name));
  for (const name of owned) {
    if (!wantedNames.has(name)) delete registered[name];
  }
  for (const server of wanted) {
    registered[server.name] = agent.toConfig(server);
  }

  if (Object.keys(registered).length > 0) config[agent.serversKey] = registered;
  else delete config[agent.serversKey];

  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

export function formatCollisionError(
  names: readonly string[],
  containerName: string,
  agent: Pick<AgentTarget, 'label' | 'manualRemoval'>,
): string {
  const list = names.join(', ');
  const plural = names.length > 1;
  return (
    `MCP server ${plural ? 'names' : 'name'} already registered in ${agent.label} by hand: ${list}.\n` +
    `The same ${plural ? 'names are' : 'name is'} in the yml's \`mcpServers:\` block, and Monoceros will not ` +
    `guess which definition wins.\n` +
    `Remove ${plural ? 'them' : 'it'} either from the yml (\`monoceros remove-mcp-server ${containerName} ${names[0]}\`) ` +
    `or from the container (${agent.manualRemoval(names[0]!)}), then apply again.`
  );
}

async function readRegistrations(file: string): Promise<McpRegistrationRecord> {
  const empty: McpRegistrationRecord = { schemaVersion: 1 };
  if (!existsSync(file)) return empty;
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return empty;
    const raw = parsed as Partial<McpRegistrationRecord>;
    const out: McpRegistrationRecord = { schemaVersion: 1 };
    for (const agent of AGENTS) {
      const names = raw[agent.id];
      if (Array.isArray(names)) {
        out[agent.id] = names.filter((n) => typeof n === 'string');
      }
    }
    return out;
  } catch {
    // Unreadable record: treat it as "we own nothing". The collision check then
    // errs toward stopping rather than overwriting a server we cannot prove is
    // ours, which is the safe direction.
    return empty;
  }
}

async function writeRegistrations(
  file: string,
  record: McpRegistrationRecord,
): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
}

/** Read a JSON object, tolerating absent / empty / malformed content. */
async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  if (!existsSync(file)) return {};
  try {
    const text = await fsp.readFile(file, 'utf8');
    if (!text.trim()) return {};
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // Malformed agent config — same call `writeClaudePermissionMode` makes:
    // start from a clean object rather than failing the apply.
    return {};
  }
}
