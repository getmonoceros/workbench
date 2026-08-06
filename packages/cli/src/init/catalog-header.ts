import {
  curatedLanguageHeader,
  curatedServiceHeader,
} from '../create/catalog.js';
import { componentDocsURL, type DocsSection } from './docs-url.js';
import { wrapToComment } from './feature-doc.js';

/**
 * The prose above a catalog entry in the generated yml, in one shape for every
 * category: what it is in the descriptor's own words, then the page that
 * documents it. A feature builds the same two parts from its manifest summary
 * (feature-doc.ts) and an MCP connector from its descriptor (mcp-doc.ts).
 *
 * What deliberately does NOT go here is anything the page says better: the
 * option table, the transport, the sign-in procedure, the vendor's own URL.
 * Those cost a paragraph above every entry and go stale on their own schedule.
 */
function headerLines(
  section: DocsSection,
  name: string,
  header: { displayName: string; description: string } | undefined,
  width: number,
): string[] {
  if (!header) return [];
  const out = wrapToComment(
    `${header.displayName}: ${header.description}`,
    width,
  );
  out.push(componentDocsURL(section, name));
  return out;
}

/**
 * Header for a `languages:` entry, looked up by the bare language name (the
 * `java` of `java:17`), because one page covers every version of it.
 */
export function buildLanguageHeaderLines(
  name: string,
  width: number,
): string[] {
  return headerLines('language', name, curatedLanguageHeader(name), width);
}

/**
 * Header for a `services:` entry, looked up by the CATALOG name rather than the
 * compose name: `--as pg-analytics` is still documented by the postgres page,
 * and the product name in the header is what explains that. A custom image has
 * no catalog entry and gets no header at all.
 *
 * The descriptor's `usageNotes` stay out. Keycloak's three paragraphs on realm
 * import are the page's job, and the actionable half of them is already the
 * commented `volumes:` scaffold directly below the entry.
 */
export function buildServiceHeaderLines(name: string, width: number): string[] {
  return headerLines('service', name, curatedServiceHeader(name), width);
}

/**
 * Put the container's real name where a comment says `<name>`.
 *
 * The prose in the yml is written once for every workbench, so it carries a
 * placeholder: `monoceros upgrade <name>`, `credentials belong in <name>.env`,
 * `monoceros tunnel <name> mailpit:8025`. In the file itself that is a command
 * the builder has to edit before it runs. Only comment lines are touched; a
 * value that happens to contain the token keeps it.
 */
export function substituteName(text: string, container: string): string {
  return text.replace(/<name>/g, container);
}

/** The same over a rendered document, comment lines only. */
export function withContainerName(
  lines: string[],
  container: string,
): string[] {
  return lines.map((line) =>
    line.trimStart().startsWith('#') ? substituteName(line, container) : line,
  );
}
