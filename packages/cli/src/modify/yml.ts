import { type Document, isMap, isScalar, isSeq, YAMLMap, YAMLSeq } from 'yaml';
import type { FeatureOptions, RepoEntry } from '../create/types.js';
import { deriveRepoName } from '../create/scaffold.js';

/**
 * AST-level mutators for solution-config yml. Each function:
 *   - takes a yaml.Document obtained from `parseConfig`
 *   - mutates it in place if the operation introduces a change
 *   - returns `true` iff the doc was changed, `false` for a no-op
 *     (matches the `mutate()` skeleton's "no-change" branch)
 *
 * All mutators preserve every comment and blank line in the surrounding
 * yml — that's the whole point of the AST approach over a plain
 * `toJS → edit → toString` cycle.
 *
 * Validation is NOT done here. The caller is expected to re-validate
 * the doc (via `parseConfig(stringifyConfig(doc))`) before persisting
 * — that surfaces schema violations with the regular field-path-aware
 * error message.
 */

/** Ensure `doc[key]` is a sequence and return it. */
function ensureSeq(doc: Document, key: string): YAMLSeq {
  const existing = doc.get(key, true);
  if (existing && isSeq(existing)) return existing;
  const seq = new YAMLSeq();
  doc.set(key, seq);
  return seq;
}

/** Drop `doc[key]` when its sequence is empty. */
function pruneEmptySeq(doc: Document, key: string): void {
  const node = doc.get(key, true);
  if (node && isSeq(node) && node.items.length === 0) {
    doc.delete(key);
  }
}

/** Compare a scalar item's value (handles both Scalar nodes and plain JS). */
function scalarValue(item: unknown): unknown {
  return isScalar(item) ? item.value : item;
}

export function addLanguageToDoc(doc: Document, lang: string): boolean {
  const seq = ensureSeq(doc, 'languages');
  if (seq.items.some((i) => scalarValue(i) === lang)) return false;
  seq.add(lang);
  return true;
}

export function addServiceToDoc(doc: Document, service: string): boolean {
  const seq = ensureSeq(doc, 'services');
  if (seq.items.some((i) => scalarValue(i) === service)) return false;
  seq.add(service);
  return true;
}

export function addAptPackagesToDoc(
  doc: Document,
  packages: string[],
): boolean {
  const seq = ensureSeq(doc, 'aptPackages');
  let changed = false;
  for (const pkg of packages) {
    if (seq.items.some((i) => scalarValue(i) === pkg)) continue;
    seq.add(pkg);
    changed = true;
  }
  return changed;
}

export function addInstallUrlToDoc(doc: Document, url: string): boolean {
  const seq = ensureSeq(doc, 'installUrls');
  if (seq.items.some((i) => scalarValue(i) === url)) return false;
  seq.add(url);
  return true;
}

/**
 * Add (or no-op) a devcontainer feature entry. Mirrors the legacy
 * `add-feature` semantics: re-adding the same ref with different
 * options is an explicit error (the builder must remove + re-add to
 * change options); same ref + same options is a no-op.
 */
export function addFeatureToDoc(
  doc: Document,
  ref: string,
  options: FeatureOptions = {},
): boolean {
  const seq = ensureSeq(doc, 'features');
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    const itemRef = item.get('ref');
    if (itemRef !== ref) continue;
    // Same ref: check options equality. Use the live doc's toJS so the
    // sub-map's scalars resolve to plain values; passing doc as the
    // schema/context is required by yaml@2.
    const itemJs = item.toJS(doc) as { options?: FeatureOptions };
    const existingJs = itemJs.options ?? {};
    if (JSON.stringify(existingJs) === JSON.stringify(options)) {
      return false;
    }
    throw new Error(
      `Feature ${ref} is already configured with different options. Remove it first (\`monoceros remove-feature ${ref}\`) before re-adding.`,
    );
  }
  const entry = new YAMLMap();
  entry.set('ref', ref);
  if (Object.keys(options).length > 0) {
    entry.set('options', options);
  }
  seq.add(entry);
  return true;
}

/**
 * Add (or no-op) a repo entry. Idempotency rules match the legacy
 * `add-repo`:
 *   - same url + (effective) name + branch → no-op
 *   - same url, different (effective) name → add a second entry
 *     (validation will catch a name collision later)
 */
export function addRepoToDoc(doc: Document, repo: RepoEntry): boolean {
  const seq = ensureSeq(doc, 'repos');
  const repoName = repo.name ?? deriveRepoName(repo.url);
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    const url = item.get('url');
    if (url !== repo.url) continue;
    const existingName = item.get('name');
    const effectiveName =
      typeof existingName === 'string'
        ? existingName
        : deriveRepoName(url as string);
    const existingBranch = item.get('branch');
    if (
      effectiveName === repoName &&
      (existingBranch ?? undefined) === (repo.branch ?? undefined)
    ) {
      return false;
    }
  }
  const entry = new YAMLMap();
  entry.set('url', repo.url);
  // Only persist `name` when it differs from the URL-derived default.
  // Keeps the yml minimal — the apply pipeline re-derives at runtime.
  if (repo.name !== undefined && repo.name !== deriveRepoName(repo.url)) {
    entry.set('name', repo.name);
  }
  if (repo.branch !== undefined) {
    entry.set('branch', repo.branch);
  }
  seq.add(entry);
  return true;
}

/**
 * Remove helpers — symmetric to add, used by Task 6's `remove-*`
 * commands. Returning false when the target isn't present makes them
 * idempotent (caller logs "no-change" instead of erroring).
 */
export function removeLanguageFromDoc(doc: Document, lang: string): boolean {
  return removeScalarFromSeq(doc, 'languages', lang);
}

export function removeServiceFromDoc(doc: Document, service: string): boolean {
  return removeScalarFromSeq(doc, 'services', service);
}

export function removeAptPackageFromDoc(doc: Document, pkg: string): boolean {
  return removeScalarFromSeq(doc, 'aptPackages', pkg);
}

export function removeInstallUrlFromDoc(doc: Document, url: string): boolean {
  return removeScalarFromSeq(doc, 'installUrls', url);
}

export function removeFeatureFromDoc(doc: Document, ref: string): boolean {
  const seq = doc.get('features', true);
  if (!seq || !isSeq(seq)) return false;
  const idx = seq.items.findIndex((i) => isMap(i) && i.get('ref') === ref);
  if (idx < 0) return false;
  seq.items.splice(idx, 1);
  pruneEmptySeq(doc, 'features');
  return true;
}

/**
 * Remove a repo by either its url or its (effective) name. The legacy
 * add-repo lets builders disambiguate via `--name`, so symmetry here:
 * `monoceros remove-repo <url-or-name>` matches either field.
 */
export function removeRepoFromDoc(doc: Document, urlOrName: string): boolean {
  const seq = doc.get('repos', true);
  if (!seq || !isSeq(seq)) return false;
  const idx = seq.items.findIndex((item) => {
    if (!isMap(item)) return false;
    const url = item.get('url');
    if (url === urlOrName) return true;
    const name = item.get('name');
    const effectiveName =
      typeof name === 'string'
        ? name
        : typeof url === 'string'
          ? deriveRepoName(url)
          : undefined;
    return effectiveName === urlOrName;
  });
  if (idx < 0) return false;
  seq.items.splice(idx, 1);
  pruneEmptySeq(doc, 'repos');
  return true;
}

function removeScalarFromSeq(
  doc: Document,
  key: string,
  value: string,
): boolean {
  const seq = doc.get(key, true);
  if (!seq || !isSeq(seq)) return false;
  const idx = seq.items.findIndex((i) => scalarValue(i) === value);
  if (idx < 0) return false;
  seq.items.splice(idx, 1);
  pruneEmptySeq(doc, key);
  return true;
}
