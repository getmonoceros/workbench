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
 * The prose above an `mcpServers:` entry: what the server is, and where the
 * page that documents it lives. Deliberately not a summary of that page. The
 * transport, the option table and the sign-in procedure all used to be written
 * out here, which cost nine comment lines above a one-line entry and went stale
 * separately from the docs.
 *
 * The one exception is the sign-in marker. An entry with no credential
 * otherwise reads like an entry someone forgot to finish, and that confusion
 * happens while looking at the yml, not while reading a page.
 */
export function buildMcpHeaderLines(
  descriptor: Descriptor,
  width: number,
): string[] {
  const paragraphs: string[] = [];
  const what = `${descriptor.displayName}: ${descriptor.description}`;
  paragraphs.push(
    descriptor.mcpServer?.auth === 'oauth'
      ? `${what} Signs in interactively, so there is no key to fill.`
      : what,
  );
  for (const note of descriptor.usageNotes) {
    const trimmed = note.trim();
    if (trimmed.length > 0) paragraphs.push(trimmed);
  }
  paragraphs.push(mcpServerDocsURL(descriptor.name ?? descriptor.id));
  const out: string[] = [];
  for (const para of paragraphs) {
    for (const line of wrapToComment(para, width)) out.push(line);
  }
  return out;
}

/**
 * The connector's own page in the user docs. Every curated connector has one,
 * added in the same change as its descriptor, so this is derived rather than
 * carried per component. The provider's own URL stays in `documentationURL`,
 * where the catalog and the website read it; the page linked here is the one
 * that covers the connector as Monoceros ships it.
 */
export function mcpServerDocsURL(name: string): string {
  return `https://getmonoceros.build/docs/mcp-servers/${name}/`;
}

/** yaml-lib `commentBefore` form: one leading space per line. */
export function mcpHeaderCommentBefore(descriptor: Descriptor): string {
  return buildMcpHeaderLines(descriptor, FEATURE_HEADER_WIDTH)
    .map((l) => ` ${l}`)
    .join('\n');
}
