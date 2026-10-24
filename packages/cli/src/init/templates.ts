import { existsSync, readdirSync, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  monocerosHome as defaultMonocerosHome,
  userWorkbenchTemplatesDir,
  workbenchTemplatesDir,
} from '../config/paths.js';
import { DEFAULT_RUNTIME_VERSION } from '../create/catalog.js';
import { parseConfig } from '../config/io.js';
import type { SolutionConfig } from '../config/schema.js';
import type { CatalogComponent } from '../catalog/load.js';
import type {
  CatalogJsonTemplate,
  CatalogJsonTemplateFeature,
} from '../catalog/catalog-json.js';
import { matchMonocerosFeature } from '../util/ref.js';

/**
 * Workbench templates: prepared ymls `monoceros init --template=<name>`
 * starts from.
 *
 * A template exists for what the `--with-*` flags cannot express. A plugin is
 * a nested block under its feature entry, and options marked `surface: yml`
 * (the permission mode, the `twg`/`rovodev`/`forge` switches) live in the file
 * too. The flags carry neither, so a setup that needs them would otherwise be
 * a docs page the builder retypes. The template is that setup as a yml, and
 * what lands in `container-configs/` is an ordinary config file, edited and
 * re-applied like any other.
 *
 * Two placeholders are substituted on init, nothing else: the container name
 * and the runtime version. Keeping the file a real, complete yml is the
 * point: it can be read, diffed and hand-edited in the repo, and what the
 * builder gets is what they saw.
 *
 * Two places hold them: `<MONOCEROS_HOME>/templates/workbenches/` first, then
 * the ones shipped with the CLI. A builder's own template therefore wins over
 * a shipped one of the same name, which is what makes the shipped set a
 * starting point rather than a fixed list. There is nothing to write for this:
 * a template is a workbench yml, so the way to make one is to copy a config
 * that works, put the two placeholders back in, and drop it in that directory.
 */
const NAME_PLACEHOLDER = /__MONOCEROS_NAME__/g;
const RUNTIME_PLACEHOLDER = /__MONOCEROS_RUNTIME_VERSION__/g;

/** A directory templates are read from, and whether it is the builder's own. */
export interface TemplateSource {
  dir: string;
  local: boolean;
}

/**
 * The directories a template is looked for in, in order. The builder's own
 * first, then the shipped set.
 */
export function workbenchTemplateSources(
  opts: TemplateLookup = {},
): TemplateSource[] {
  const sources: TemplateSource[] = [];
  const user = opts.userDir ?? safeUserTemplatesDir(opts.monocerosHome);
  if (user) sources.push({ dir: user, local: true });
  const bundled = opts.bundledDir ?? safeTemplatesDir();
  if (bundled) sources.push({ dir: bundled, local: false });
  return sources;
}

/** The directories alone, in lookup order. */
export function workbenchTemplateDirs(opts: TemplateLookup = {}): string[] {
  return workbenchTemplateSources(opts).map((s) => s.dir);
}

export interface TemplateLookup {
  /** Override the builder's template dir. Tests inject one. */
  userDir?: string | undefined;
  /** Override the shipped template dir. Tests inject one. */
  bundledDir?: string | undefined;
  /** Override the resolved MONOCEROS_HOME the user dir is derived from. */
  monocerosHome?: string | undefined;
}

/**
 * Template names from both directories, sorted and deduplicated. A name in
 * both appears once, and it is the builder's file that `renderWorkbenchTemplate`
 * will read.
 */
export function listWorkbenchTemplates(opts: TemplateLookup = {}): string[] {
  const names = new Set<string>();
  for (const dir of workbenchTemplateDirs(opts)) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.yml')) names.add(file.slice(0, -'.yml'.length));
    }
  }
  return [...names].sort();
}

/**
 * Read a template and substitute the two placeholders. Throws with the
 * available names when the template does not exist, the same shape as an
 * unknown `--with-features` value.
 */
export async function renderWorkbenchTemplate(
  template: string,
  containerName: string,
  opts: TemplateLookup = {},
): Promise<string> {
  // Reject a name that would escape a template dir before touching the
  // filesystem, the value comes straight off the command line.
  const traverses =
    template.includes('/') ||
    template.includes('\\') ||
    template.includes('..');
  const file = traverses
    ? undefined
    : workbenchTemplateDirs(opts)
        .map((dir) => path.join(dir, `${template}.yml`))
        .find((candidate) => existsSync(candidate));
  if (!file) {
    const known = listWorkbenchTemplates(opts).join(', ') || '(none)';
    throw new Error(
      `Unknown template: ${JSON.stringify(template)}. Available: ${known}.`,
    );
  }
  const text = await fs.readFile(file, 'utf8');
  return fillTemplatePlaceholders(text, containerName);
}

/** Substitute the two placeholders, the only thing init changes in a template. */
export function fillTemplatePlaceholders(
  text: string,
  containerName: string,
): string {
  return text
    .replace(NAME_PLACEHOLDER, containerName)
    .replace(RUNTIME_PLACEHOLDER, DEFAULT_RUNTIME_VERSION);
}

/** A template as read from disk, before its placeholders are filled. */
export interface TemplateFile {
  name: string;
  file: string;
  text: string;
  local: boolean;
}

/**
 * Every template once, sorted by name. A name in several sources is read from
 * the first, so the builder's file wins, as it does for `init --template`.
 */
export async function readWorkbenchTemplates(
  sources: readonly TemplateSource[],
): Promise<TemplateFile[]> {
  const byName = new Map<string, TemplateFile>();
  for (const { dir, local } of sources) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.yml')) continue;
      const name = entry.slice(0, -'.yml'.length);
      if (byName.has(name)) continue;
      const file = path.join(dir, entry);
      byName.set(name, {
        name,
        file,
        text: await fs.readFile(file, 'utf8'),
        local,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What a template brings, for `list-components --json`. Read with the config
 * parser after filling the placeholders, so a broken template fails here with
 * its path instead of at the next `init`.
 */
export function projectWorkbenchTemplate(
  template: TemplateFile,
  catalog: Map<string, CatalogComponent>,
): CatalogJsonTemplate {
  let config: SolutionConfig;
  try {
    // The name is not part of the output; it only has to be a valid one.
    config = parseConfig(
      fillTemplatePlaceholders(template.text, 'template'),
      template.file,
    ).config;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid workbench template ${template.file}: ${msg}`);
  }
  const description = templateDescription(template.text);
  return {
    name: template.name,
    ...(template.local ? { local: true as const } : {}),
    ...(description ? { description } : {}),
    languages: config.languages.map(languageLabel),
    services: config.services.map((s) => s.ref ?? s.name),
    features: config.features.map((f) => projectFeature(f, catalog)),
    mcpServers: config.mcpServers.map((m) => m.name),
  };
}

/** `node`, `node:24`, or the object form `{ java: { version: 21 } }` as `java:21`. */
function languageLabel(entry: SolutionConfig['languages'][number]): string {
  if (typeof entry === 'string') return entry;
  const [name, options] = Object.entries(entry)[0]!;
  return options['version'] !== undefined
    ? `${name}:${options['version']}`
    : name;
}

function projectFeature(
  entry: SolutionConfig['features'][number],
  catalog: Map<string, CatalogComponent>,
): CatalogJsonTemplateFeature {
  const id = matchMonocerosFeature(entry.ref)?.name;
  const descriptor = id ? catalog.get(id)?.descriptor : undefined;
  const out: CatalogJsonTemplateFeature = {
    name:
      descriptor?.category === 'feature'
        ? (descriptor.name ?? descriptor.id)
        : entry.ref,
  };
  const options = Object.entries(entry.options ?? {}).filter(
    ([, value]) => !(typeof value === 'string' && value.includes('${')),
  );
  if (options.length > 0) out.options = Object.fromEntries(options);
  if (entry.plugins && entry.plugins.length > 0) out.plugins = entry.plugins;
  return out;
}

/**
 * The first paragraph of the leading comment block that is not the header
 * init writes into every yml (`The workbench <name>. This file is the source
 * of truth …`), URL lines dropped. The shipped templates carry that header
 * with the placeholder, a template made by copying a config carries it with
 * the real name; in both the paragraph after it says what the template is
 * for. A builder's own template without the header gets its first comment.
 */
export function templateDescription(text: string): string | undefined {
  const paragraphs: string[][] = [[]];
  for (const line of text.trimStart().split('\n')) {
    if (!line.startsWith('#')) break;
    const body = line.replace(/^#\s?/, '').trim();
    if (body === '') paragraphs.push([]);
    else if (!/^https?:\/\/\S+$/.test(body)) paragraphs.at(-1)!.push(body);
  }
  const first = paragraphs.find(
    (p) => p.length > 0 && !p[0]!.startsWith('The workbench `'),
  );
  return first?.join(' ');
}

/**
 * The templates dir, or undefined when the CLI-bundle root cannot be
 * resolved. Only the listing swallows that: completion and error messages ask
 * for the names outside a workbench checkout too, and an empty list there is
 * better than a crash.
 */
function safeTemplatesDir(): string | undefined {
  try {
    return workbenchTemplatesDir();
  } catch {
    return undefined;
  }
}

/**
 * The builder's template dir, or undefined when MONOCEROS_HOME cannot be
 * resolved. Same reasoning as above: completion asks for the names in places
 * where a home may not exist yet.
 */
function safeUserTemplatesDir(home?: string): string | undefined {
  try {
    return userWorkbenchTemplatesDir(home ?? defaultMonocerosHome());
  } catch {
    return undefined;
  }
}
