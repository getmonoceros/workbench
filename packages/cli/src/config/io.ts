import { promises as fs } from 'node:fs';
import { Document, parseDocument } from 'yaml';
import { type SolutionConfig, validateConfig } from './schema.js';

/**
 * A parsed solution-config yml plus its AST. `config` is the validated
 * plain-JS view (used to drive the apply pipeline); `doc` is the
 * `yaml.Document` (used by mutation helpers so comments and ordering
 * survive a round-trip).
 */
export interface ParsedConfig {
  config: SolutionConfig;
  doc: Document.Parsed;
  /** Source path or `<inline>` for an in-memory parse. Used in errors. */
  source: string;
}

/**
 * Parse a yml string and validate against the schema. Throws on
 * yaml syntax errors and on schema violations. The returned `doc`
 * preserves comments and node ordering — pass it to mutation helpers
 * (`addRepoToDoc`, …) and `stringifyConfig` so the builder's hand-
 * written comments survive `monoceros add-*`.
 */
export function parseConfig(
  yamlText: string,
  source = '<inline>',
): ParsedConfig {
  const doc = parseDocument(yamlText, { prettyErrors: true });
  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    throw new Error(`yaml parse error in ${source}: ${first.message}`);
  }
  const config = validateConfig(doc.toJS());
  return { config, doc, source };
}

export async function readConfig(filePath: string): Promise<ParsedConfig> {
  const text = await fs.readFile(filePath, 'utf8');
  return parseConfig(text, filePath);
}

/** Serialize a Document back to yaml. */
export function stringifyConfig(doc: Document): string {
  return String(doc);
}

export async function writeConfig(
  filePath: string,
  doc: Document,
): Promise<void> {
  await fs.writeFile(filePath, stringifyConfig(doc), 'utf8');
}

/**
 * Build a fresh Document from a plain-JS config object. Used when
 * generating a yml from a template (no source comments to preserve)
 * or when migrating an existing stack.json. The resulting Document
 * is suitable for further mutation + `stringifyConfig`.
 *
 * The output is stable: keys appear in the canonical order defined
 * by `KEY_ORDER` below, so two configs with the same content yield
 * byte-identical yaml.
 */
export function createDoc(config: SolutionConfig): Document {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    if (key in config) {
      const value = (config as unknown as Record<string, unknown>)[key];
      if (isEmptyContainer(value)) continue;
      ordered[key] = value;
    }
  }
  const doc = new Document(ordered);
  return doc;
}

/**
 * Canonical key order in generated yaml. Matches the example skeleton
 * in `docs/backlog.md`. Hand-edited yml does not have to follow this
 * order (parser accepts any) — but anything `createDoc` writes does.
 */
const KEY_ORDER = [
  'schemaVersion',
  'name',
  'languages',
  'aptPackages',
  'features',
  'installUrls',
  'services',
  'repos',
  'routing',
  'git',
] as const;

function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length === 0;
  }
  return false;
}
