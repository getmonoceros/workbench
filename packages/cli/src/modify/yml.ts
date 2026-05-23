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
 * Add (or no-op) a repo entry to the `repos:` sequence.
 *
 * Idempotency: if an existing entry has the same URL AND the same
 * effective path AND the same gitUser, this is a no-op (returns
 * false). "Effective path" means the explicit `path:` value if set,
 * or the URL-derived single-segment default otherwise. Same URL
 * with a different path is intentionally allowed — that's the "I
 * want two clones of the same repo into different folders" case.
 *
 * `gitUser` is an optional per-repo override of the container-level
 * git.user. When set, persisted as a `git.user` nested map; falls
 * back to the container default at apply time when omitted.
 *
 * Branches are not part of this model. Switching branches is a
 * `git checkout` inside the container, not a yml-level concern.
 */
export function addRepoToDoc(doc: Document, repo: RepoEntry): boolean {
  const seq = ensureSeq(doc, 'repos');
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    const url = item.get('url');
    if (url !== repo.url) continue;
    const existingPath = item.get('path');
    const effectivePath =
      typeof existingPath === 'string'
        ? existingPath
        : deriveRepoName(url as string);
    if (effectivePath !== repo.path) continue;
    // Same url + same path. Check gitUser + provider equivalence too
    // so an entry that adds/changes either field is treated as an
    // update, not silently ignored.
    const existingGit = item.get('git', true);
    const existingUser =
      existingGit && isMap(existingGit) ? existingGit.get('user', true) : null;
    const existingName =
      existingUser && isMap(existingUser) ? existingUser.get('name') : null;
    const existingEmail =
      existingUser && isMap(existingUser) ? existingUser.get('email') : null;
    const existingGitUser =
      typeof existingName === 'string' && typeof existingEmail === 'string'
        ? { name: existingName, email: existingEmail }
        : undefined;
    const sameGitUser =
      (existingGitUser?.name ?? null) === (repo.gitUser?.name ?? null) &&
      (existingGitUser?.email ?? null) === (repo.gitUser?.email ?? null);
    const existingProvider = item.get('provider');
    const sameProvider =
      (typeof existingProvider === 'string' ? existingProvider : null) ===
      (repo.provider ?? null);
    if (sameGitUser && sameProvider) {
      return false;
    }
    // Different gitUser or provider → update in place instead of
    // appending a duplicate. Re-running add-repo with new values is
    // the natural way to change either field.
    if (repo.gitUser) {
      const gitMap = new YAMLMap();
      const userMap = new YAMLMap();
      userMap.set('name', repo.gitUser.name);
      userMap.set('email', repo.gitUser.email);
      gitMap.set('user', userMap);
      item.set('git', gitMap);
    } else {
      item.delete('git');
    }
    if (repo.provider) {
      item.set('provider', repo.provider);
    } else {
      item.delete('provider');
    }
    return true;
  }
  const entry = new YAMLMap();
  entry.set('url', repo.url);
  // Only persist `path` when it differs from the URL-derived default.
  // Keeps the yml minimal — the apply pipeline re-derives at runtime.
  if (repo.path !== deriveRepoName(repo.url)) {
    entry.set('path', repo.path);
  }
  if (repo.gitUser) {
    const gitMap = new YAMLMap();
    const userMap = new YAMLMap();
    userMap.set('name', repo.gitUser.name);
    userMap.set('email', repo.gitUser.email);
    gitMap.set('user', userMap);
    entry.set('git', gitMap);
  }
  if (repo.provider) {
    entry.set('provider', repo.provider);
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

/** Plural form — for `monoceros remove-apt-packages a b c`. */
export function removeAptPackagesFromDoc(
  doc: Document,
  packages: string[],
): boolean {
  let changed = false;
  for (const pkg of packages) {
    if (removeAptPackageFromDoc(doc, pkg)) changed = true;
  }
  return changed;
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
 * Remove a repo by either its url or its (effective) path. Symmetry
 * to add-repo: `monoceros remove-repo <url-or-path>` matches either
 * field. For nested paths the full path is the match key
 * (`remove-repo apps/web`), not the leaf segment.
 */
export function removeRepoFromDoc(doc: Document, urlOrPath: string): boolean {
  const seq = doc.get('repos', true);
  if (!seq || !isSeq(seq)) return false;
  const idx = seq.items.findIndex((item) => {
    if (!isMap(item)) return false;
    const url = item.get('url');
    if (url === urlOrPath) return true;
    const path = item.get('path');
    const effectivePath =
      typeof path === 'string'
        ? path
        : typeof url === 'string'
          ? deriveRepoName(url)
          : undefined;
    return effectivePath === urlOrPath;
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
