import type { Descriptor } from '../catalog/descriptor.js';
import type { CatalogComponent } from '../catalog/load.js';
import {
  FEATURE_HEADER_WIDTH,
  featureOptionVarName,
  wrapToComment,
} from './feature-doc.js';

/**
 * The yml-writing side of an MCP server (ADR 0045): the options block that
 * goes into an `mcpServers:` entry, the `<name>.env` keys behind its `${VAR}`
 * placeholders, and the header comment above the entry.
 *
 * Sibling of `feature-doc.ts` / `service-doc.ts`, and deliberately built from
 * the descriptor rather than from a generated manifest: a connector publishes
 * no devcontainer feature, so there is no manifest to read.
 */

export interface McpConnectorDoc {
  /** Catalog selector, i.e. what goes in the yml as `name:`. */
  name: string;
  /** Options to write into the entry: yml defaults plus `${VAR}` placeholders. */
  options: Record<string, string | number | boolean>;
  /** Env keys to seed into `<name>.env` for the placeholders above. */
  envVars: string[];
  /** Header comment lines, without the `#` prefix. */
  headerLines: string[];
}

/** Find a `category: mcp` descriptor by its yml selector. */
export function findMcpConnector(
  catalog: Map<string, CatalogComponent>,
  name: string,
): Descriptor | undefined {
  for (const { descriptor: d } of catalog.values()) {
    if (d.category === 'mcp-server' && (d.name ?? d.id) === name) return d;
  }
  return undefined;
}

/** Every MCP server's selector, sorted — for error messages and listings. */
export function mcpConnectorNames(
  catalog: Map<string, CatalogComponent>,
): string[] {
  const out: string[] = [];
  for (const { descriptor: d } of catalog.values()) {
    if (d.category === 'mcp-server') out.push(d.name ?? d.id);
  }
  return out.sort();
}

export function buildMcpConnectorDoc(descriptor: Descriptor): McpConnectorDoc {
  const name = descriptor.name ?? descriptor.id;
  const options: Record<string, string | number | boolean> = {};
  const envVars: string[] = [];
  for (const [key, spec] of Object.entries(descriptor.options)) {
    if (spec.surface === 'yml') {
      if (spec.default !== undefined) options[key] = spec.default;
      continue;
    }
    if (spec.surface === 'env') {
      // Same derived name a feature option gets, so a builder learns one rule:
      // `<COMPONENT>_<OPTION>`. For context7 that lands on CONTEXT7_API_KEY,
      // which is also the header the server itself reads.
      const envVar = featureOptionVarName(name, key);
      options[key] = `\${${envVar}}`;
      envVars.push(envVar);
    }
  }
  return {
    name,
    options,
    envVars,
    headerLines: buildMcpHeaderLines(descriptor, FEATURE_HEADER_WIDTH),
  };
}

/**
 * The prose above an `mcpServers:` entry, same shape as a feature's: what it is, what
 * its options are, where to read more. Plus the transport, because whether the
 * server runs in the container or is reached over the network is the one thing
 * a builder should not have to look up elsewhere.
 */
export function buildMcpHeaderLines(
  descriptor: Descriptor,
  width: number,
): string[] {
  const paragraphs: string[] = [];
  paragraphs.push(`${descriptor.displayName}: ${descriptor.description}`);
  paragraphs.push(
    descriptor.mcpServer?.transport === 'stdio'
      ? 'Runs inside the container.'
      : 'Reached over the network, so this one leaves the container boundary.',
  );
  for (const note of descriptor.usageNotes) {
    const trimmed = note.trim();
    if (trimmed.length > 0) paragraphs.push(trimmed);
  }
  const optionParts = Object.entries(descriptor.options)
    .filter(([, spec]) => spec.surface !== 'silent')
    .map(([key, spec]) => {
      const short = spec.description
        ? shortenDescription(spec.description)
        : undefined;
      return short ? `${key} (${short})` : key;
    });
  if (optionParts.length > 0) {
    paragraphs.push(`Options: ${optionParts.join(', ')}.`);
  }
  if (descriptor.documentationURL) {
    paragraphs.push(
      `See ${descriptor.documentationURL} for further information.`,
    );
  }
  const out: string[] = [];
  for (const para of paragraphs) {
    for (const line of wrapToComment(para, width)) out.push(line);
  }
  return out;
}

/** First sentence of an option description, punctuation stripped. */
function shortenDescription(desc: string): string {
  const first = desc.split(/(?<=[.!?])\s+/)[0]?.trim() ?? desc.trim();
  return first.replace(/[.!?]+$/, '').trim();
}

/** yaml-lib `commentBefore` form: one leading space per line. */
export function mcpHeaderCommentBefore(descriptor: Descriptor): string {
  return buildMcpHeaderLines(descriptor, FEATURE_HEADER_WIDTH)
    .map((l) => ` ${l}`)
    .join('\n');
}
