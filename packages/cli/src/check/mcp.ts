import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { McpTransport, SolutionConfig } from '../config/schema.js';
import { agentsPresent, type AgentTarget } from '../create/mcp-registration.js';
import type { CreateOptions } from '../create/types.js';
import type { Finding } from './index.js';

/**
 * `monoceros check` for the `mcpServers:` block (ADR 0045).
 *
 * The chain from a yml entry to a tool the agent can call has five links: the
 * yml, apply, the agent's config file, the agent's runtime, and the model
 * deciding to reach for it. Only the last one is outside Monoceros, and before
 * this check a builder had no way to tell which link was broken. An agent that
 * says "I have no context7 tool" is not evidence either way; one was observed
 * reporting results from tools it had invented.
 *
 * So this checks the artifact, not the intent: it reads what actually sits in
 * each present agent's config file, compares that against the yml, and then asks
 * the server itself what tools it serves. Naming those tools is the point. It
 * turns "is it configured?" into a list the builder can hold against what the
 * agent claims.
 *
 * A `stdio` server is not probed: that would mean running a foreign package from
 * a check command. Its config is verified, its tools are not, and the report
 * says which.
 */

/** How long a single MCP round trip may take before the probe gives up. */
const PROBE_TIMEOUT_MS = 8000;

export interface McpProbe {
  name: string;
  transport: McpTransport;
  /** Agent labels whose config carries this server. */
  registeredFor: string[];
  /** Tool names the server advertises. Absent for stdio (not probed). */
  tools?: string[];
  /**
   * The server wants an interactive sign-in, so an unauthenticated probe
   * cannot list its tools. Not a failure: see `needsSignIn`.
   */
  needsAuth?: boolean;
  /** Why the probe did not produce a tool list. */
  error?: string;
}

interface AgentEntry {
  agent: AgentTarget;
  /** Server name → its config object, as it stands in the agent's file. */
  servers: Map<string, Record<string, unknown>>;
}

export interface McpCheckResult {
  findings: Finding[];
  probes: McpProbe[];
}

export async function checkMcpServers(
  root: string,
  name: string,
  config: SolutionConfig,
  features: CreateOptions['features'],
  opts: { probe?: boolean } = {},
): Promise<McpCheckResult> {
  const declared = config.mcpServers.map((e) => e.name);
  const agents = agentsPresent(features);
  if (declared.length === 0 && agents.length === 0) {
    return { findings: [], probes: [] };
  }

  const findings: Finding[] = [];
  const entries: AgentEntry[] = [];
  for (const agent of agents) {
    entries.push({
      agent,
      servers: await readAgentServers(root, agent),
    });
  }

  // The yml is the intent; the agent config is what the agent will act on. A
  // gap between them means apply has not run since the yml changed (or someone
  // edited the config by hand), which looks exactly like a broken server.
  for (const agentEntry of entries) {
    const { agent, servers } = agentEntry;
    const where = path.join(...agent.configPath);
    for (const server of declared) {
      if (servers.has(server)) continue;
      findings.push({
        rule: 'mcp-servers',
        where,
        what: `The yml registers '${server}' but ${agent.label}'s config does not have it, so the agent cannot reach it.`,
        fix: `Run \`monoceros apply ${name}\` to write the registration.`,
      });
    }
  }
  if (declared.length > 0 && agents.length === 0) {
    findings.push({
      rule: 'mcp-servers',
      where: `${name}.yml`,
      what: `The yml registers ${declared.length === 1 ? 'an MCP server' : 'MCP servers'} (${declared.join(', ')}) but the container has no agent to use them.`,
      fix: `Add one with \`monoceros add-feature ${name} claude\` (or \`… opencode\`), then apply.`,
    });
  }

  const probes = await buildProbes(entries, opts.probe !== false);
  for (const probe of probes) {
    if (probe.error === undefined) continue;
    findings.push({
      rule: 'mcp-servers',
      where: `mcpServers.${probe.name}`,
      what: `The server is registered but did not answer: ${probe.error}`,
      fix: `Check the credential in ${name}.env and that the endpoint is reachable from this machine.`,
    });
  }
  return { findings, probes };
}

/** The servers key of one agent's config file, as a name → config map. */
async function readAgentServers(
  root: string,
  agent: AgentTarget,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await fs.readFile(path.join(root, ...agent.configPath), 'utf8'),
    );
  } catch {
    return out; // absent or malformed — the drift check reports the gap
  }
  if (typeof parsed !== 'object' || parsed === null) return out;
  const block = (parsed as Record<string, unknown>)[agent.serversKey];
  if (typeof block !== 'object' || block === null) return out;
  for (const [serverName, value] of Object.entries(
    block as Record<string, unknown>,
  )) {
    if (typeof value === 'object' && value !== null) {
      out.set(serverName, value as Record<string, unknown>);
    }
  }
  return out;
}

/**
 * One probe per server name across all agents. The definition is taken from the
 * first agent that has it — they are written from one canonical shape, so any of
 * them answers the same question.
 */
async function buildProbes(
  entries: readonly AgentEntry[],
  live: boolean,
): Promise<McpProbe[]> {
  const seen = new Map<string, { config: Record<string, unknown> }>();
  const agentsByServer = new Map<string, string[]>();
  for (const { agent, servers } of entries) {
    for (const [serverName, config] of servers) {
      if (!seen.has(serverName)) seen.set(serverName, { config });
      agentsByServer.set(serverName, [
        ...(agentsByServer.get(serverName) ?? []),
        agent.label,
      ]);
    }
  }

  const probes: McpProbe[] = [];
  for (const [serverName, { config }] of seen) {
    const url = typeof config.url === 'string' ? config.url : undefined;
    const registeredFor = agentsByServer.get(serverName) ?? [];
    if (url === undefined) {
      // stdio: config verified, server deliberately not started.
      probes.push({ name: serverName, transport: 'stdio', registeredFor });
      continue;
    }
    const probe: McpProbe = {
      name: serverName,
      transport: 'http',
      registeredFor,
    };
    if (!live) {
      probes.push(probe);
      continue;
    }
    const headers = plainStringMap(config.headers);
    const result = await probeRemoteServer(url, headers);
    if (result.tools) probe.tools = result.tools;
    if (result.needsAuth) probe.needsAuth = true;
    if (result.error !== undefined) probe.error = result.error;
    probes.push(probe);
  }
  return probes.sort((a, b) => a.name.localeCompare(b.name));
}

function plainStringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Speak MCP to a remote server: `initialize`, then `tools/list` with the session
 * id the first call returns. Two round trips because streamable HTTP binds the
 * session to that header; a single `tools/list` is refused.
 */
async function probeRemoteServer(
  url: string,
  headers: Record<string, string>,
): Promise<{ tools?: string[]; needsAuth?: boolean; error?: string }> {
  // Whether the registration carries a credential at all. It decides how a
  // 401 reads: with a credential it is a bad one, without it the server is
  // simply asking for the sign-in this probe can never perform.
  const carriesCredential = Object.keys(headers).length > 0;
  const base = {
    'content-type': 'application/json',
    // Both, because a server may answer either as JSON or as an SSE stream.
    accept: 'application/json, text/event-stream',
    ...headers,
  };
  try {
    const init = await fetch(url, {
      method: 'POST',
      headers: base,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'monoceros-check', version: '1' },
        },
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!init.ok) {
      if (needsSignIn(init, carriesCredential)) return { needsAuth: true };
      return { error: `HTTP ${init.status} on initialize` };
    }
    const initBody = parseRpc(await init.text());
    if (initBody?.error) return { error: rpcError(initBody.error) };
    const session = init.headers.get('mcp-session-id');

    const list = await fetch(url, {
      method: 'POST',
      headers: {
        ...base,
        'mcp-protocol-version': '2025-06-18',
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!list.ok) {
      if (needsSignIn(list, carriesCredential)) return { needsAuth: true };
      return { error: `HTTP ${list.status} on tools/list` };
    }
    const listBody = parseRpc(await list.text());
    if (listBody?.error) return { error: rpcError(listBody.error) };
    const tools = listBody?.result?.tools;
    if (!Array.isArray(tools)) return { error: 'no tool list in the answer' };
    const names = tools
      .map((t) => (typeof t?.name === 'string' ? t.name : undefined))
      .filter((n): n is string => n !== undefined);
    // A connected server with zero tools is the case that looks healthy and is
    // not; say so rather than reporting an empty list as success.
    if (names.length === 0) return { error: 'the server serves no tools' };
    return { tools: names };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message.includes('timeout') ? 'timed out' : message };
  }
}

/**
 * Whether a refused response means "sign in first" rather than "this is
 * broken". Three conditions, and each one earns its place:
 *
 *   - `401`/`403`, because that is what an unauthenticated MCP request gets.
 *   - a `WWW-Authenticate` header, because that is the server naming a way in.
 *     Without it a `401` is just a refusal and stays a failure, or the
 *     tolerance would swallow real breakage.
 *   - no credential in the registration. A server we DO send a token to and
 *     that still refuses us has a bad token, which is exactly the finding a
 *     builder needs. Only a registration with nothing to send can be waiting
 *     for the interactive sign-in.
 *
 * What this deliberately does not do is ask whether the sign-in has already
 * happened. It cannot: the probe holds no grant either way, so the answer is
 * `401` in a freshly built container and in one whose agents have been signed
 * in for weeks. Reading each agent's credential store to tell them apart would
 * mean tracking three private file formats and a fourth on the day a new agent
 * lands. So the report states what is true in both cases — this one signs in
 * interactively — and leaves the doing to the builder.
 */
function needsSignIn(response: Response, carriesCredential: boolean): boolean {
  if (carriesCredential) return false;
  if (response.status !== 401 && response.status !== 403) return false;
  return response.headers.get('www-authenticate') !== null;
}

interface RpcBody {
  result?: { tools?: Array<{ name?: unknown }> };
  error?: { code?: number; message?: unknown };
}

/**
 * Pull the JSON-RPC body out of a response that may be plain JSON or an SSE
 * frame (`event: message` + `data: {…}`), which is what streamable HTTP sends.
 */
function parseRpc(text: string): RpcBody | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as RpcBody;
    } catch {
      return undefined;
    }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try {
      return JSON.parse(line.slice(5).trim()) as RpcBody;
    } catch {
      // keep looking; a stream may carry comments and other events
    }
  }
  return undefined;
}

function rpcError(error: NonNullable<RpcBody['error']>): string {
  const message =
    typeof error.message === 'string' ? error.message : 'unknown error';
  return error.code !== undefined ? `${message} (${error.code})` : message;
}
