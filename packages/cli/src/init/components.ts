import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { componentsDir as defaultComponentsDir } from '../config/paths.js';
import { FeatureOptionValueSchema, REGEX } from '../config/schema.js';

/**
 * Components catalog — small, composable yml snippets that
 * `monoceros init` can merge into a container config.
 *
 * Each file under `templates/components/` is one component:
 *
 *   - `templates/components/node.yml` → component name `node`
 *   - `templates/components/atlassian/twg.yml` → component name
 *     `atlassian/twg`
 *
 * Sub-components live inside a directory whose name matches a parent
 * component (and which may itself have a top-level `<group>.yml`,
 * e.g. `atlassian.yml` for the "both tools" preset). The convention
 * is: a sub-component sets every sibling boolean option explicitly
 * (`true` for its own feature, `false` for the others), and the
 * merge applies OR-semantics on booleans so combining
 * `--with=atlassian/rovodev,atlassian/twg` correctly yields both
 * `true`. See `templates/components/README.md` for the full design.
 */

const CategorySchema = z.enum(['language', 'service', 'feature']);
export type ComponentCategory = z.infer<typeof CategorySchema>;

const FeatureContributionSchema = z.object({
  ref: z.string().regex(REGEX.featureRef),
  options: z.record(z.string(), FeatureOptionValueSchema).optional(),
});

/**
 * Shape validation for one component file. The contributes section is
 * deliberately narrow — exactly one of languages/services/features may
 * be set, and it must line up with the declared category.
 */
const ComponentFileSchema = z
  .object({
    displayName: z.string().min(1),
    description: z.string().min(1),
    category: CategorySchema,
    contributes: z.object({
      languages: z.array(z.string().min(1)).optional(),
      services: z.array(z.string().min(1)).optional(),
      features: z.array(FeatureContributionSchema).optional(),
    }),
  })
  .superRefine((data, ctx) => {
    const c = data.contributes;
    const filled = [
      c.languages && c.languages.length > 0 ? 'languages' : null,
      c.services && c.services.length > 0 ? 'services' : null,
      c.features && c.features.length > 0 ? 'features' : null,
    ].filter((x): x is string => x !== null);

    if (filled.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'contributes must set at least one of languages/services/features',
      });
      return;
    }
    if (filled.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `contributes must set exactly one of languages/services/features, got: ${filled.join(', ')}`,
      });
      return;
    }
    const expected =
      data.category === 'language'
        ? 'languages'
        : data.category === 'service'
          ? 'services'
          : 'features';
    if (filled[0] !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `category '${data.category}' requires contributes.${expected}, got contributes.${filled[0]}`,
      });
    }
  });

export type ComponentFile = z.infer<typeof ComponentFileSchema>;

export interface Component {
  /** Catalog name, e.g. `node`, `atlassian/twg`. Always slash-form. */
  name: string;
  /** Absolute filesystem path of the source yml — useful for errors. */
  sourcePath: string;
  file: ComponentFile;
}

/**
 * Walk `templates/components/` recursively, parse every `.yml` file,
 * validate it, return as a name-keyed map. README files and other
 * non-yml files are silently skipped.
 *
 * Throws on the first invalid component file with a path-anchored
 * error — better to refuse than to load an inconsistent catalog.
 */
export async function loadComponentCatalog(
  rootDir: string = defaultComponentsDir(),
): Promise<Map<string, Component>> {
  if (!existsSync(rootDir)) {
    return new Map();
  }
  const out = new Map<string, Component>();
  await walk(rootDir, rootDir, out);
  return out;
}

async function walk(
  baseDir: string,
  currentDir: string,
  out: Map<string, Component>,
): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walk(baseDir, full, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.yml')) continue;
    const relative = path.relative(baseDir, full);
    const name = relative
      .replace(/\.yml$/, '')
      .split(path.sep)
      .join('/');
    const text = await fs.readFile(full, 'utf8');
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (err) {
      throw new Error(
        `Failed to parse component ${name} (${full}): ${(err as Error).message}`,
      );
    }
    const parsed = ComponentFileSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => {
          const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
          return `  - ${where}: ${issue.message}`;
        })
        .join('\n');
      throw new Error(`Invalid component ${name} (${full}):\n${issues}`);
    }
    out.set(name, { name, sourcePath: full, file: parsed.data });
  }
}

/**
 * A `SolutionConfig`-shaped fragment produced by merging the
 * `contributes` of one or more components. Caller wraps this into
 * a full config (adds schemaVersion + name) before writing the yml.
 */
export interface MergedComponents {
  languages: string[];
  services: string[];
  features: Array<{
    ref: string;
    options: Record<string, string | number | boolean>;
  }>;
}

/**
 * Merge the contributions of the given components into a single
 * fragment.
 *
 * Rules:
 *   - `languages`/`services`: concat + dedupe (insertion order kept
 *     stable; first occurrence wins).
 *   - `features`: deduped by `ref`. When two components contribute
 *     the same ref, their options are merged with the per-key rules
 *     below.
 *   - Per-key feature option merge:
 *       - booleans: OR (true wins)
 *       - strings + numbers: later component overrides (rare in
 *         practice — components should set activation flags, not
 *         credentials; credentials come from monoceros-config.yml
 *         defaults.features or the user editing the yml directly).
 *
 * The OR-merge for booleans is what makes
 * `--with=atlassian/rovodev,atlassian/twg` yield both `true` even
 * though each sub-component sets the sibling flag to `false`.
 */
/**
 * One entry of the resolved-components list. The optional `version`
 * is the `<name>:<version>` suffix from the CLI flag; today it
 * only applies to language components (we append it to each
 * contributed language string so the scaffold passes it as the
 * upstream feature's `version` option). For other categories,
 * providing a version is a builder error and resolveComponents
 * rejects it up front.
 */
export interface ResolvedComponent {
  component: Component;
  version?: string;
}

export function mergeComponents(
  resolved: Array<Component | ResolvedComponent>,
): MergedComponents {
  const languages: string[] = [];
  const services: string[] = [];
  const featureByRef = new Map<
    string,
    { ref: string; options: Record<string, string | number | boolean> }
  >();

  for (const entry of resolved) {
    const c = isResolvedComponent(entry) ? entry.component : entry;
    const version = isResolvedComponent(entry) ? entry.version : undefined;
    const ct = c.file.contributes;
    for (const lang of ct.languages ?? []) {
      // Language components can carry a `:version` suffix from the
      // CLI. We emit `<lang>:<version>` in the final yml; the
      // scaffold parses it back to the upstream feature's
      // `version` option at apply time.
      const value = version !== undefined ? `${lang}:${version}` : lang;
      if (!languages.includes(value)) languages.push(value);
    }
    for (const svc of ct.services ?? []) {
      if (!services.includes(svc)) services.push(svc);
    }
    for (const f of ct.features ?? []) {
      const existing = featureByRef.get(f.ref);
      if (!existing) {
        featureByRef.set(f.ref, {
          ref: f.ref,
          options: { ...(f.options ?? {}) },
        });
        continue;
      }
      existing.options = mergeFeatureOptions(existing.options, f.options ?? {});
    }
  }

  return {
    languages,
    services,
    features: [...featureByRef.values()],
  };
}

function isResolvedComponent(
  x: Component | ResolvedComponent,
): x is ResolvedComponent {
  return 'component' in x;
}

function mergeFeatureOptions(
  a: Record<string, string | number | boolean>,
  b: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const result = { ...a };
  for (const [key, valueB] of Object.entries(b)) {
    const valueA = result[key];
    if (typeof valueA === 'boolean' && typeof valueB === 'boolean') {
      result[key] = valueA || valueB;
      continue;
    }
    result[key] = valueB;
  }
  return result;
}

/**
 * Resolve `--with=…` names against the catalog. Accepts plain
 * names (`node`) and language-version pairs (`node:20`). Splits
 * the `:version` off, looks up the bare name in the catalog, and
 * carries the version forward only for language components — a
 * version on any other category is rejected with a clear error.
 *
 * Throws with the full list of unknown names so the builder fixes
 * them all at once rather than running into them one at a time.
 */
export function resolveComponents(
  catalog: Map<string, Component>,
  names: string[],
): ResolvedComponent[] {
  const unknown: string[] = [];
  const out: ResolvedComponent[] = [];
  for (const raw of names) {
    const colon = raw.indexOf(':');
    const name = colon === -1 ? raw : raw.slice(0, colon);
    const version = colon === -1 ? undefined : raw.slice(colon + 1);

    const c = catalog.get(name);
    if (!c) {
      // The unknown-name message reports the form the user typed
      // (including the :version) so it's easy to spot the typo.
      unknown.push(raw);
      continue;
    }
    if (version !== undefined && c.file.category !== 'language') {
      throw new Error(
        `Component '${name}' is a ${c.file.category}, not a language — a ':${version}' suffix has no meaning here.`,
      );
    }
    out.push({ component: c, ...(version !== undefined ? { version } : {}) });
  }
  if (unknown.length > 0) {
    const available = [...catalog.keys()].sort();
    throw new Error(
      `Unknown component${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.\n` +
        `Available: ${available.join(', ')}.`,
    );
  }
  return out;
}
