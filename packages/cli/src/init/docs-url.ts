/**
 * The page on getmonoceros.build that documents a catalog component.
 *
 * The generated yml points at these instead of restating what they say. A
 * header that summarises the docs costs lines above every entry and goes stale
 * on its own schedule; a link stays right whatever the page says next week.
 *
 * Derived rather than carried per component: every curated component gets its
 * page in the same change as its descriptor, and the page's slug is the yml
 * selector. A component with no catalog entry (a third-party OCI ref, a custom
 * service image) has no page, so its caller emits no link at all rather than
 * one that 404s.
 */
const DOCS_SECTIONS = {
  language: 'languages',
  service: 'services',
  feature: 'features',
  'mcp-server': 'mcp-servers',
} as const;

export type DocsSection = keyof typeof DOCS_SECTIONS;

/** `name` is the yml selector (`claude`, `postgres`, `context7`). */
export function componentDocsURL(section: DocsSection, name: string): string {
  return `https://getmonoceros.build/docs/${DOCS_SECTIONS[section]}/${name}/`;
}
