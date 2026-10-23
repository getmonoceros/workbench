import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { componentsRootDir, userTemplatesDir } from '../config/paths.js';
import {
  DescriptorSchema,
  type Descriptor,
  type DescriptorCategory,
} from './descriptor.js';

/**
 * Loader for the unified component descriptors (ADR 0020). Reads the
 * `components/` tree into one in-memory model. Phase 1: additive only —
 * no consumer reads from here yet.
 *
 * Layout (category is dictated by the parent directory, then
 * cross-checked against the descriptor's own `category`):
 *
 *   components/
 *     languages/<id>/component.yml
 *     services/<id>/component.yml
 *     features/<id>/component.yml   (+ install.sh, generated json)
 *     mcp-servers/<id>/component.yml (registration only, nothing installed)
 */

export const CATEGORY_DIRS: Readonly<Record<string, DescriptorCategory>> = {
  languages: 'language',
  services: 'service',
  features: 'feature',
  'mcp-servers': 'mcp-server',
};

/** Directory a category's descriptors live in, for error messages. */
const DIR_FOR_CATEGORY: Readonly<Record<DescriptorCategory, string>> =
  Object.fromEntries(
    Object.entries(CATEGORY_DIRS).map(([dir, category]) => [category, dir]),
  ) as Record<DescriptorCategory, string>;

export interface CatalogComponent {
  id: string;
  category: DescriptorCategory;
  /** Absolute path of the source descriptor file — used in errors. */
  sourcePath: string;
  descriptor: Descriptor;
  /** Read from the builder's `<MONOCEROS_HOME>/templates/`, not shipped. */
  local?: true;
  /**
   * Older versions of a service descriptor, by version (#139):
   * `component@<n>.yml` next to a shipped one, `<id>@<n>.yml` next to the
   * builder's own. The component itself is the current version; a workbench
   * whose `ref` names an older one is read against the entry here.
   */
  older?: ReadonlyMap<number, CatalogComponent>;
}

/** A descriptor file as read from disk, before it is parsed. */
export interface DescriptorFile {
  name: string;
  sourcePath: string;
  text: string;
}

const OLDER_VERSION_RE = /^(.+)@([1-9][0-9]*)\.yml$/;

/**
 * Attach the older versions found next to a current descriptor. Each one is
 * `<base>@<n>.yml`, must carry `version: n`, and must be older than the
 * current one.
 */
export function withOlderVersions(
  current: CatalogComponent,
  files: readonly DescriptorFile[],
  base: string,
  storedAs: 'folder' | 'file',
): CatalogComponent {
  const older = new Map<number, CatalogComponent>();
  for (const file of files) {
    const m = OLDER_VERSION_RE.exec(file.name);
    if (!m || m[1] !== base) continue;
    const version = Number(m[2]);
    const component = parseDescriptorFile(
      file.text,
      file.sourcePath,
      current.id,
      'service',
      storedAs,
    );
    if (component.descriptor.version !== version) {
      throw new Error(
        `Descriptor ${file.sourcePath} carries version ${component.descriptor.version}, but its file name says ${version}.`,
      );
    }
    if (version >= current.descriptor.version) {
      throw new Error(
        `${file.sourcePath} is version ${version}, but the current ${current.sourcePath} is version ${current.descriptor.version}. Raise the version of the current one.`,
      );
    }
    older.set(version, component);
  }
  return older.size > 0 ? { ...current, older } : current;
}

/**
 * Walk the `components/` tree, parse + validate every `component.yml`,
 * return an id-keyed map. Throws on the first invalid descriptor with a
 * path-anchored message — refuse rather than load an inconsistent catalog.
 *
 * Without `rootDir` this is the catalog a command works with: the resolved
 * components root (checkout in dev, bundled copy in prod — see
 * `config/paths.ts#componentsRootDir`) plus the builder's own services and MCP
 * servers from `<MONOCEROS_HOME>/templates/{services,mcp-servers}/<id>.yml`,
 * which win by id (ADR 0063). An explicit
 * `rootDir` reads that tree alone, so the scripts that generate the published
 * catalog never pick up the machine's own descriptors; tests pass `userDir`
 * to add an overlay to it.
 */
export async function loadDescriptorCatalog(
  rootDir?: string,
  userDir?: string,
): Promise<Map<string, CatalogComponent>> {
  const out = await walkTree(rootDir ?? componentsRootDir());
  const overlayDir = rootDir === undefined ? userTemplatesDir() : userDir;
  if (overlayDir) applyOverlay(out, await walkOwnDescriptors(overlayDir));
  return out;
}

async function walkTree(
  rootDir: string,
): Promise<Map<string, CatalogComponent>> {
  const out = new Map<string, CatalogComponent>();
  if (!existsSync(rootDir)) {
    return out;
  }
  for (const [dirName, category] of Object.entries(CATEGORY_DIRS)) {
    const categoryDir = path.join(rootDir, dirName);
    if (!existsSync(categoryDir)) continue;
    const entries = await fs.readdir(categoryDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const sourcePath = path.join(categoryDir, id, 'component.yml');
      if (!existsSync(sourcePath)) continue;
      let component = await loadOne(sourcePath, id, category);
      if (category === 'service') {
        const dir = path.join(categoryDir, id);
        const files: DescriptorFile[] = [];
        for (const name of await fs.readdir(dir)) {
          if (!OLDER_VERSION_RE.test(name)) continue;
          const filePath = path.join(dir, name);
          files.push({
            name,
            sourcePath: filePath,
            text: await fs.readFile(filePath, 'utf8'),
          });
        }
        component = withOlderVersions(component, files, 'component', 'folder');
      }
      addUnique(out, component);
    }
  }
  return out;
}

/**
 * The categories a builder can keep descriptors for under `templates/`, by
 * directory (ADR 0063). Services and MCP servers are catalog data alone, while
 * a language or feature also needs an install script published as an OCI
 * feature.
 */
export const OWN_CATEGORY_DIRS: Readonly<Record<string, DescriptorCategory>> = {
  services: 'service',
  'mcp-servers': 'mcp-server',
};

/**
 * The builder's own descriptors, `<templatesDir>/<category dir>/<id>.yml`.
 * One flat file each, like `templates/workbenches/<name>.yml`.
 */
async function walkOwnDescriptors(
  templatesDir: string,
): Promise<Map<string, CatalogComponent>> {
  const out = new Map<string, CatalogComponent>();
  for (const [dirName, category] of Object.entries(OWN_CATEGORY_DIRS)) {
    const dir = path.join(templatesDir, dirName);
    if (!existsSync(dir)) continue;
    const files: DescriptorFile[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.yml')) continue;
      const sourcePath = path.join(dir, entry.name);
      files.push({
        name: entry.name,
        sourcePath,
        text: await fs.readFile(sourcePath, 'utf8'),
      });
    }
    collectOwnDescriptors(out, files, category);
  }
  return out;
}

/**
 * Parse the files of one `templates/<category dir>/` into `out`. A name with
 * `@<n>` is an older version of a service and joins its current file; an MCP
 * server has no versions, because the yml names it and carries no block that
 * could fall behind.
 */
export function collectOwnDescriptors(
  out: Map<string, CatalogComponent>,
  files: readonly DescriptorFile[],
  category: DescriptorCategory,
): void {
  const older = files.filter((f) => OLDER_VERSION_RE.test(f.name));
  for (const file of files) {
    if (older.includes(file)) continue;
    addUnique(
      out,
      parseOwnDescriptor(file.text, file.sourcePath, file.name, category),
    );
  }
  const bases = new Set(older.map((f) => OLDER_VERSION_RE.exec(f.name)![1]!));
  for (const base of bases) {
    const first = older.find((f) => f.name.startsWith(`${base}@`))!;
    if (category !== 'service') {
      throw new Error(
        `${first.sourcePath}: only a service descriptor has versions. Rename it to ${base}.yml.`,
      );
    }
    const current = out.get(base);
    if (!current) {
      throw new Error(
        `${first.sourcePath} is an older version of '${base}', but ${base}.yml next to it is missing.`,
      );
    }
    out.set(base, withOlderVersions(current, older, base, 'file'));
  }
}

/** Parse one `templates/<category dir>/<id>.yml`; its id is the file name. */
export function parseOwnDescriptor(
  text: string,
  sourcePath: string,
  fileName: string,
  category: DescriptorCategory,
): CatalogComponent {
  return parseDescriptorFile(
    text,
    sourcePath,
    fileName.slice(0, -'.yml'.length),
    category,
    'file',
  );
}

/** Add a component, refusing a second one under the same id. */
export function addUnique(
  out: Map<string, CatalogComponent>,
  component: CatalogComponent,
): void {
  if (out.has(component.id)) {
    const first = out.get(component.id)!;
    throw new Error(
      `Duplicate component id '${component.id}': ${first.sourcePath} and ${component.sourcePath}.`,
    );
  }
  out.set(component.id, component);
}

/**
 * Lay the builder's own descriptors over the shipped ones (ADR 0063). Same id,
 * same category: theirs replaces ours. Clashing with a shipped component of
 * another category, by id or by the name it is selected with (`claude` is the
 * claude-code feature), is an error, because the one name would then mean a
 * service or MCP server in one command and a feature in the next.
 */
export function applyOverlay(
  out: Map<string, CatalogComponent>,
  own: Map<string, CatalogComponent>,
): void {
  const selector = (c: CatalogComponent): string =>
    c.descriptor.name ?? c.descriptor.id;
  for (const component of own.values()) {
    const clash = [...out.values()].find(
      (shipped) =>
        shipped.category !== component.category &&
        (shipped.id === component.id ||
          selector(shipped) === selector(component)),
    );
    if (clash) {
      const what = component.category === 'service' ? 'Service' : 'MCP server';
      throw new Error(
        `${what} '${selector(component)}' (${component.sourcePath}) has the name of the shipped ${clash.category} '${selector(clash)}'. Rename the file and its id.`,
      );
    }
    // `tools` are files next to a descriptor, and a flat yml has nowhere to
    // keep them. Under a shipped id they still resolve to the shipped ones.
    if (component.descriptor.service?.tools && !out.has(component.id)) {
      throw new Error(
        `Service '${component.id}' (${component.sourcePath}) lists tools, which only a shipped service can carry. Remove the tools entry.`,
      );
    }
    out.set(component.id, { ...component, local: true });
  }
}

async function loadOne(
  sourcePath: string,
  folderId: string,
  expectedCategory: DescriptorCategory,
): Promise<CatalogComponent> {
  const text = await fs.readFile(sourcePath, 'utf8');
  return parseDescriptorFile(text, sourcePath, folderId, expectedCategory);
}

/**
 * Parse + validate one descriptor's YAML text into a CatalogComponent.
 * Pure (no I/O) so both the async and sync loaders share it. Throws with a
 * path-anchored message on any problem.
 */
export function parseDescriptorFile(
  text: string,
  sourcePath: string,
  folderId: string,
  expectedCategory: DescriptorCategory,
  storedAs: 'folder' | 'file' = 'folder',
): CatalogComponent {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(
      `Failed to parse descriptor (${sourcePath}): ${(err as Error).message}`,
    );
  }
  const parsed = DescriptorSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `  - ${where}: ${issue.message}`;
      })
      .join('\n');
    throw new Error(`Invalid descriptor (${sourcePath}):\n${issues}`);
  }
  const descriptor = parsed.data;
  if (descriptor.id !== folderId) {
    throw new Error(
      `Descriptor id '${descriptor.id}' must match its ${storedAs} name '${folderId}' (${sourcePath}).`,
    );
  }
  if (descriptor.category !== expectedCategory) {
    throw new Error(
      `Descriptor '${descriptor.id}' has category '${descriptor.category}' but sits under '${DIR_FOR_CATEGORY[expectedCategory]}/' (${sourcePath}).`,
    );
  }
  return {
    id: descriptor.id,
    category: descriptor.category,
    sourcePath,
    descriptor,
  };
}
