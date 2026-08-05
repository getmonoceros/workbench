import type { McpEntry, McpTransport } from '../config/schema.js';
import type { CatalogComponent } from './load.js';
import type { Descriptor, OptionSpec } from './descriptor.js';

/**
 * Resolve the container yml's `mcp:` entries into the canonical server
 * definitions apply writes into each agent's config (ADR 0045).
 *
 * Two entry forms, and what tells them apart is whether the entry carries a
 * definition, not what it is called:
 *
 *   - **no definition** → resolved here against the catalog. Options are
 *     validated against the descriptor and its `${option}` templates are
 *     rendered with them.
 *   - **a definition** → passed through verbatim. Deliberately *not* resolved
 *     even when a connector of the same name exists, so shipping a curated
 *     `notion` tomorrow cannot change what an existing yml means. The
 *     shadowing is reported as a note, not an error.
 *
 * Pure: the caller loads the catalog and has already substituted `${VAR}` from
 * `<name>.env`, so everything left in a template here is an `${option}`.
 */

export interface ResolvedMcpServer {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Description for the agent briefing; only a catalog connector has one. */
  description?: string;
  /**
   * The connector's `briefing:` lines, gated on its options the same way a
   * feature's are. What the agent is told about *when* to reach for the
   * server, which is the part a one-line description cannot carry.
   */
  briefing?: string[];
  /** False for an inline entry, so callers can tell curated from pasted. */
  fromCatalog: boolean;
}

export interface ResolveMcpResult {
  servers: ResolvedMcpServer[];
  /** Builder-facing remarks that are not failures (name shadowing). */
  notes: string[];
}

/** The mcp connectors in the catalog, by yml selector. */
function mcpSelectors(
  catalog: Map<string, CatalogComponent>,
): Map<string, Descriptor> {
  const out = new Map<string, Descriptor>();
  for (const { descriptor: d } of catalog.values()) {
    if (d.category === 'mcp-server') out.set(d.name ?? d.id, d);
  }
  return out;
}

/** Whether an entry carries its own definition (see the module comment). */
export function isInlineMcpEntry(entry: McpEntry): boolean {
  return (
    entry.transport !== undefined ||
    entry.command !== undefined ||
    entry.args !== undefined ||
    entry.env !== undefined ||
    entry.url !== undefined ||
    entry.headers !== undefined
  );
}

export function resolveMcpServers(
  entries: readonly McpEntry[],
  catalog: Map<string, CatalogComponent>,
): ResolveMcpResult {
  const connectors = mcpSelectors(catalog);
  const servers: ResolvedMcpServer[] = [];
  const notes: string[] = [];
  const problems: string[] = [];

  for (const entry of entries) {
    if (isInlineMcpEntry(entry)) {
      if (connectors.has(entry.name)) {
        notes.push(
          `mcp '${entry.name}' is defined inline and shadows the catalog connector of the same name. ` +
            `Drop the definition fields to use the curated one.`,
        );
      }
      servers.push(inlineServer(entry));
      continue;
    }
    const descriptor = connectors.get(entry.name);
    if (!descriptor) {
      problems.push(unknownConnectorMessage(entry.name, catalog, connectors));
      continue;
    }
    const resolved = resolveFromDescriptor(entry, descriptor, problems);
    if (resolved) servers.push(resolved);
  }

  if (problems.length > 0) {
    throw new Error(`Invalid \`mcp:\` entries:\n${problems.join('\n')}`);
  }
  return { servers, notes };
}

/** An inline entry, verbatim. The yml schema already validated its shape. */
function inlineServer(entry: McpEntry): ResolvedMcpServer {
  const out: ResolvedMcpServer = {
    name: entry.name,
    // Non-null: the schema requires `transport` on any inline entry.
    transport: entry.transport!,
    fromCatalog: false,
  };
  if (entry.command !== undefined) out.command = entry.command;
  if (entry.args !== undefined) out.args = [...entry.args];
  if (entry.env !== undefined) out.env = { ...entry.env };
  if (entry.url !== undefined) out.url = entry.url;
  if (entry.headers !== undefined) out.headers = { ...entry.headers };
  return out;
}

function resolveFromDescriptor(
  entry: McpEntry,
  descriptor: Descriptor,
  problems: string[],
): ResolvedMcpServer | null {
  const before = problems.length;
  const options = mergeMcpOptions(entry, descriptor, problems);
  // `mcpServer` is non-null: the descriptor schema requires the block for the
  // category, and only `category: mcp-server` descriptors reach here.
  const block = descriptor.mcpServer!;
  const render = (raw: string, field: string): string =>
    renderTemplate(raw, options, entry.name, field, problems);

  const briefing = descriptor.briefing
    .filter(
      (line) =>
        line.whenOption === undefined ||
        isTruthyOption(options[line.whenOption]),
    )
    .map((line) => line.text);

  const out: ResolvedMcpServer = {
    name: entry.name,
    transport: block.transport,
    description: descriptor.description,
    fromCatalog: true,
  };
  if (briefing.length > 0) out.briefing = briefing;
  if (block.command !== undefined) {
    out.command = render(block.command, 'command');
  }
  if (block.args !== undefined) {
    out.args = block.args.map((arg, i) => render(arg, `args[${i}]`));
  }
  // On an OAuth connector a credential is optional by definition, so a key
  // whose option is empty is dropped instead of failing the apply. Only
  // headers and env can be dropped; a url or a command has nowhere to go.
  const optional = block.auth === 'oauth';
  const renderEntries = (
    input: Record<string, string>,
    prefix: string,
  ): Record<string, string> => {
    const rendered: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
      if (optional && hasEmptyOption(value, options)) continue;
      rendered[key] = render(value, `${prefix}.${key}`);
    }
    return rendered;
  };

  if (block.env !== undefined) {
    const env = renderEntries(block.env, 'env');
    if (Object.keys(env).length > 0) out.env = env;
  }
  if (block.url !== undefined) out.url = render(block.url, 'url');
  if (block.headers !== undefined) {
    const headers = renderEntries(block.headers, 'headers');
    if (Object.keys(headers).length > 0) out.headers = headers;
  }
  return problems.length === before ? out : null;
}

/**
 * The connector's declared option defaults with the yml's values on top. An
 * empty yml value does NOT override — a blank `${VAR}` placeholder that the
 * builder never filled resolves to `''`, and the intent there is "unset", the
 * same rule feature options follow.
 */
function mergeMcpOptions(
  entry: McpEntry,
  descriptor: Descriptor,
  problems: string[],
): Record<string, string> {
  const specs = descriptor.options;
  const out: Record<string, string> = {};
  for (const [key, spec] of Object.entries(specs)) {
    out[key] = spec.default === undefined ? '' : String(spec.default);
  }
  for (const [key, value] of Object.entries(entry.options ?? {})) {
    if (!hasOption(specs, key)) {
      problems.push(
        `  - mcp '${entry.name}': unknown option '${key}'. Declared options: ` +
          `${Object.keys(specs).sort().join(', ') || '(none)'}.`,
      );
      continue;
    }
    const str = String(value);
    if (str === '') continue;
    out[key] = str;
  }
  return out;
}

function hasOption(specs: Record<string, OptionSpec>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(specs, key);
}

/** Options are strings after the merge, so `false` and `0` read as off too. */
function isTruthyOption(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== 'false' && v !== '0';
}

/** Whether a template references an option that resolved to nothing. */
function hasEmptyOption(raw: string, options: Record<string, string>): boolean {
  for (const match of raw.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)) {
    if (options[match[1]!] === '') return true;
  }
  return false;
}

/**
 * Fill `${option}` tokens. An option that resolves empty is a hard error and
 * not an empty string in the output: a connector registered with a blank
 * `Authorization` header is present in the agent's tool list and fails on
 * first use, which is the failure mode that looks like a working container
 * (see #82). Better to name the missing value while the builder is right here.
 *
 * An `auth: oauth` connector is the exception, and its caller keeps those
 * fields away from here: there the credential is optional, because the sign-in
 * inside the container is the other way in.
 */
function renderTemplate(
  raw: string,
  options: Record<string, string>,
  serverName: string,
  field: string,
  problems: string[],
): string {
  return raw.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, token: string) => {
    const value = options[token];
    if (value === undefined) {
      // The descriptor schema rejects an undeclared token, so this is only
      // reachable from a hand-edited catalog. Report rather than swallow.
      problems.push(
        `  - mcp '${serverName}': ${field} references '\${${token}}', which the connector does not declare.`,
      );
      return match;
    }
    if (value === '') {
      problems.push(
        `  - mcp '${serverName}': option '${token}' is empty, but ${field} needs it. ` +
          `Fill it in the yml or in <name>.env.`,
      );
      return match;
    }
    return value;
  });
}

function unknownConnectorMessage(
  name: string,
  catalog: Map<string, CatalogComponent>,
  connectors: Map<string, Descriptor>,
): string {
  // A name that exists in another category is almost always the wrong
  // command, so say which one instead of "unknown".
  for (const { descriptor: d } of catalog.values()) {
    if ((d.name ?? d.id) === name && d.category !== 'mcp-server') {
      return (
        `  - mcp '${name}': that is a ${d.category}, not an MCP connector. ` +
        `Use 'monoceros add-${d.category} <container> ${name}'.`
      );
    }
  }
  const known = [...connectors.keys()].sort().join(', ') || '(none)';
  return (
    `  - mcp '${name}': unknown connector. Catalog connectors: ${known}. ` +
    `For a server the catalog does not carry, put its own definition in the entry ` +
    `(transport, command/url, …) instead of just a name.`
  );
}
