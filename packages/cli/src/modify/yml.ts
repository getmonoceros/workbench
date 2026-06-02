import {
  type Document,
  isMap,
  isScalar,
  isSeq,
  Pair,
  parseDocument,
  Scalar,
  YAMLMap,
  YAMLSeq,
} from 'yaml';
import type { FeatureOptions, RepoEntry } from '../create/types.js';
import { deriveRepoName } from '../create/scaffold.js';
import { loadFeatureManifestSummary } from '../init/manifest.js';
import {
  buildFeatureHeaderCommentBefore,
  featureOptionHints,
  FEATURE_HEADER_WIDTH,
} from '../init/feature-doc.js';

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

/** Find the services[] item whose `name:` equals `name`. */
function findServiceItem(seq: YAMLSeq, name: string): YAMLMap | undefined {
  for (const item of seq.items) {
    if (isMap(item) && item.get('name') === name) return item;
  }
  return undefined;
}

export type AddServiceOutcome =
  | { outcome: 'added' }
  | { outcome: 'exists' }
  | { outcome: 'conflict'; existingImage: string };

/**
 * Add a service entry built from pre-rendered map-body lines (see
 * init/service-doc.ts). Idempotent by `name`:
 *   - no entry with that name → append (parsing the body so comments in
 *     a custom scaffold survive), report `added`.
 *   - an entry with that name + the same image → `exists` (no-op,
 *     preserves any builder edits to that block).
 *   - an entry with that name + a different image → `conflict` (caller
 *     turns this into an actionable error).
 */
export function addServiceEntryToDoc(
  doc: Document,
  name: string,
  image: string,
  bodyLines: string[],
  scaffoldComment?: string,
): AddServiceOutcome {
  const seq = ensureSeq(doc, 'services');
  const existing = findServiceItem(seq, name);
  if (existing) {
    const existingImage = existing.get('image');
    if (existingImage === image) return { outcome: 'exists' };
    return { outcome: 'conflict', existingImage: String(existingImage) };
  }
  const node = parseDocument(bodyLines.join('\n')).contents as YAMLMap;
  // The commented scaffold (custom images) rides as the node's trailing
  // `comment` — comments parsed inside the body string would be dropped
  // when the map is moved into the sequence, but a node `.comment`
  // survives and renders each line under the item, prefixed with `#`.
  if (scaffoldComment) node.comment = scaffoldComment;
  seq.add(node);
  return { outcome: 'added' };
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

/**
 * Set (or replace) the container-level `git.user` block. Used by the
 * apply / init identity prompt when the builder chose "save in this
 * container's yml" (scope `c` or `b`).
 *
 * Idempotent on identical input: same name + email → no doc change,
 * return false. Different values → in-place overwrite, return true.
 *
 * When `git` is newly created (didn't exist before this call) the
 * block lands right after `name:` at the top of the document — same
 * "identity is the first thing under the container's own intro"
 * layout used by monoceros-config's `defaults.git`. A pre-existing
 * `git:` key keeps its position; the builder's manual reorderings
 * are respected.
 *
 * Comment-preserving as usual for our AST mutators.
 */
export function setContainerGitUserInDoc(
  doc: Document,
  user: { name: string; email: string },
): boolean {
  const gitNode = doc.get('git', true);
  let gitMap: YAMLMap;
  let createdNew = false;
  if (gitNode && isMap(gitNode)) {
    gitMap = gitNode;
  } else {
    gitMap = new YAMLMap();
    insertTopLevelAfterName(doc, 'git', gitMap, GIT_USER_HEADER_COMMENT);
    createdNew = true;
  }
  const userNode = gitMap.get('user', true);
  let userMap: YAMLMap;
  if (userNode && isMap(userNode)) {
    userMap = userNode;
  } else {
    userMap = new YAMLMap();
    gitMap.set('user', userMap);
  }
  const currentName = userMap.get('name');
  const currentEmail = userMap.get('email');
  if (!createdNew && currentName === user.name && currentEmail === user.email) {
    return false;
  }
  userMap.set('name', user.name);
  userMap.set('email', user.email);
  relocateLeakedSectionComments(doc);
  return true;
}

/**
 * yaml-lib's parser will sometimes attach a column-0 comment block
 * sitting between two top-level keys (e.g. the `# Repos cloned…`
 * header above `repos:`) to the previous top-level pair's deepest
 * trailing node rather than to the next pair's `commentBefore`. On
 * re-emit via the AST writers (setContainerGitUserInDoc et al.) the
 * comment then comes out indented under the previous section instead
 * of standing at column 0 above the next section — visually broken.
 *
 * This walks the document, finds such leaked comments on the LAST
 * leaf of each top-level section, and moves them to the
 * `commentBefore` of the NEXT top-level pair (where they visually
 * belong).
 *
 * Safe to call after any AST mutation; idempotent — already-correctly-
 * placed comments aren't touched.
 */
export function relocateLeakedSectionComments(doc: Document): void {
  const root = doc.contents;
  if (!root || !isMap(root)) return;
  const items = root.items;
  for (let i = 0; i < items.length - 1; i++) {
    const here = items[i]!;
    const next = items[i + 1]!;
    const leak = takeTrailingLeafComment(here.value);
    if (!leak) continue;
    const nextKey = next.key as {
      commentBefore?: string | null;
      spaceBefore?: boolean;
    } | null;
    if (!nextKey || typeof nextKey !== 'object') continue;
    const existing = nextKey.commentBefore ?? '';
    nextKey.commentBefore = existing ? `${leak}\n${existing}` : leak;
    nextKey.spaceBefore = true;
  }
}

/**
 * If `node` is a container whose deepest trailing element carries a
 * comment block that includes a yaml-lib "blank line separator" (a
 * `\n\n` inside the `comment` string — that's how yaml stores a
 * source-level blank line between two trailing comment runs), strip
 * the post-separator portion and return it. Everything before the
 * blank line is a legitimate inline hint that belongs to the leaf;
 * everything after is the next section's leaked header.
 *
 * Returns `null` when there's no blank-line separator — in that case
 * the trailing comment is all legitimate inline content, leave it.
 */
function takeTrailingLeafComment(node: unknown): string | null {
  if (!node) return null;
  type CommentNode = {
    comment?: string | null;
    spaceBefore?: boolean;
  };
  // First, check this node's own trailing comment for a leak.
  const c = node as CommentNode;
  if (typeof c.comment === 'string' && c.comment.length > 0) {
    const blankMatch = c.comment.match(/\n[ \t]*\n/);
    if (blankMatch && blankMatch.index !== undefined) {
      // Strip ONLY the blank-line separator. The character that
      // follows is the leading single space yaml-lib uses between
      // `#` and the comment text — preserve it, otherwise the
      // relocated block emits as `#Foo` instead of `# Foo`.
      const tail = c.comment.slice(blankMatch.index + blankMatch[0].length);
      c.comment = c.comment.slice(0, blankMatch.index);
      if (tail.length > 0) return tail;
    }
  }
  // Recurse into children — last-first across both maps and seqs, so
  // we find the DEEPEST leak first (yaml-lib's parser pushes leaked
  // comments as deep as it can). When a seq has multiple items and
  // the leak sits on an EARLIER one (because subsequent items were
  // added by a later mutation), we walk back through the siblings
  // until we find it.
  if (isMap(node) && node.items.length > 0) {
    for (let i = node.items.length - 1; i >= 0; i--) {
      const value = (node.items[i] as { value?: unknown }).value;
      const found = takeTrailingLeafComment(value);
      if (found) return found;
    }
  }
  if (isSeq(node) && node.items.length > 0) {
    for (let i = node.items.length - 1; i >= 0; i--) {
      const found = takeTrailingLeafComment(node.items[i]);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Insert a new top-level key into the document, positioned right
 * after `name:` (or at index 1 if `name:` isn't there). Used so newly-
 * persisted `git:` lands at the top of the yml where the builder
 * expects to find it — mirrors the `defaults.git.user` placement in
 * monoceros-config.sample.yml.
 *
 * If `comment` is given, it's attached as the new pair's
 * `commentBefore` so the section gets the same explanatory line the
 * other sections carry.
 */
function insertTopLevelAfterName(
  doc: Document,
  key: string,
  value: YAMLMap,
  comment: string | undefined,
): void {
  const root = doc.contents;
  if (!root || !isMap(root)) {
    // Document with no top-level map (shouldn't happen for a real
    // solution-config) — fall back to plain set, which appends.
    doc.set(key, value);
    return;
  }
  // Wrap the key in a Scalar so we can attach commentBefore + spaceBefore
  // to it. A plain string key (which is what Pair accepts as a shorthand)
  // doesn't have those fields.
  const keyScalar = new Scalar(key);
  if (comment) {
    keyScalar.commentBefore = comment;
    keyScalar.spaceBefore = true;
  }
  const pair = new Pair(keyScalar, value);
  const nameIdx = root.items.findIndex((p) => {
    const k = p.key as { value?: unknown } | string | null;
    return (typeof k === 'string' ? k : (k?.value ?? null)) === 'name';
  });
  const insertAt = nameIdx >= 0 ? nameIdx + 1 : Math.min(1, root.items.length);
  root.items.splice(insertAt, 0, pair);
}

const GIT_USER_HEADER_COMMENT = [
  ' Git committer identity for this container. Overrides',
  " monoceros-config.yml's defaults.git.user. Applies to every repo",
  ' below unless that repo declares its own `git.user` override.',
].join('\n');

/**
 * Read the port number from a `routing.ports:` entry — handles both
 * the short form (`- 3000`) and the long form (`- port: 3000`).
 * Returns `null` for malformed entries (the schema catches them, but
 * the mutator is defensive).
 */
function portOfItem(item: unknown): number | null {
  const scalar = scalarValue(item);
  if (typeof scalar === 'number' && Number.isInteger(scalar)) {
    return scalar;
  }
  if (isMap(item)) {
    const p = item.get('port');
    if (typeof p === 'number' && Number.isInteger(p)) return p;
  }
  return null;
}

/** Ensure `routing` is a map and return it (created if absent). */
function ensureRoutingMap(doc: Document): YAMLMap {
  const existing = doc.get('routing', true);
  if (existing && isMap(existing)) return existing;
  const map = new YAMLMap();
  doc.set('routing', map);
  return map;
}

/**
 * Move a port to position 0 in the `routing.ports` sequence (or add
 * it there if it isn't already in the list). The first entry doubles
 * as the bare `<name>.localhost` default route in the Traefik dynamic
 * config, so this is how the builder picks which app the bare URL
 * points at.
 *
 * Returns `true` if anything changed. Idempotent: when the port is
 * already at index 0, the call is a no-op.
 */
export function setDefaultPortInDoc(doc: Document, port: number): boolean {
  const routing = ensureRoutingMap(doc);
  const existing = routing.get('ports', true);
  let seq: YAMLSeq;
  if (existing && isSeq(existing)) {
    seq = existing;
  } else {
    seq = new YAMLSeq();
    routing.set('ports', seq);
  }
  const currentIdx = seq.items.findIndex((i) => portOfItem(i) === port);
  if (currentIdx === 0) return false;
  if (currentIdx > 0) {
    // Splice out preserves the node — comments attached to the entry
    // ride along to the new position. Then unshift back at index 0.
    const [item] = seq.items.splice(currentIdx, 1);
    seq.items.unshift(item);
    return true;
  }
  // Not in the list yet — insert at the front.
  seq.items.unshift(port);
  return true;
}

/**
 * Add (or no-op) one or more ports to `routing.ports`. Comparison is
 * by port number, so a long-form entry (`- port: 3000`) matches a
 * short-form input (`3000`) and vice versa — that keeps `add-port`
 * idempotent against either form the builder may have written by
 * hand.
 *
 * Writes the short form for new entries (lowest-noise yml). To get
 * the long form, the builder edits the yml directly — relevant once
 * the long form carries additional fields (TLS entrypoint, path
 * prefix … see ADR 0007).
 */
export function addPortsToDoc(doc: Document, ports: number[]): boolean {
  const routing = ensureRoutingMap(doc);
  const existing = routing.get('ports', true);
  let seq: YAMLSeq;
  if (existing && isSeq(existing)) {
    seq = existing;
  } else {
    seq = new YAMLSeq();
    routing.set('ports', seq);
  }
  let changed = false;
  for (const port of ports) {
    if (seq.items.some((i) => portOfItem(i) === port)) continue;
    seq.add(port);
    changed = true;
  }
  // No prune here — a non-empty `routing.ports` is the whole point of
  // add-port. If `routing` was freshly created with only this `ports:`
  // field, leaving it bare is fine; future fields (vscodeAutoForward
  // etc.) attach to the same map.
  return changed;
}

/**
 * Remove one or more ports from `routing.ports`. Matches both short
 * and long form. Idempotent — ports not present are skipped silently,
 * the return reflects whether any actual removal happened. When the
 * port list is empty after removal, the `ports:` key is pruned. If
 * `routing` becomes completely empty (no other sub-keys), the whole
 * block is dropped too — symmetric to how other sequence-emptying
 * mutators behave.
 */
export function removePortsFromDoc(doc: Document, ports: number[]): boolean {
  const routing = doc.get('routing', true);
  if (!routing || !isMap(routing)) return false;
  const seq = routing.get('ports', true);
  if (!seq || !isSeq(seq)) return false;
  const targets = new Set(ports);
  let changed = false;
  for (let i = seq.items.length - 1; i >= 0; i--) {
    const p = portOfItem(seq.items[i]);
    if (p !== null && targets.has(p)) {
      seq.items.splice(i, 1);
      changed = true;
    }
  }
  if (changed) {
    if (seq.items.length === 0) routing.delete('ports');
    if (routing.items.length === 0) doc.delete('routing');
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
 *
 * `displayName` is what the builder typed on the command line —
 * either a short-name (`atlassian` / `atlassian/twg`) or the full
 * OCI ref. Used in error messages so the suggestion to run
 * `monoceros remove-feature <X>` echoes the form they're familiar
 * with rather than the always-the-full-ref form. Defaults to `ref`
 * when omitted.
 */
export function addFeatureToDoc(
  doc: Document,
  ref: string,
  options: FeatureOptions = {},
  displayName?: string,
): boolean {
  const seq = ensureSeq(doc, 'features');
  const label = displayName ?? ref;
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
      `Feature ${label} is already configured with different options. Remove it first (\`monoceros remove-feature ${label}\`) before re-adding.`,
    );
  }
  const entry = new YAMLMap();
  entry.set('ref', ref);
  if (Object.keys(options).length > 0) {
    entry.set('options', options);
  }
  // Manifest-driven per-feature header block (tagline + description,
  // options summary, documentationURL) — the same prose the init
  // generator emits. Attached as commentBefore on the sequence ITEM
  // (the entry map itself) so yaml-lib renders it as a block ABOVE
  // the dash:
  //
  //     # Atlassian — …
  //     # Options: …
  //       - ref: ghcr.io/…/atlassian:1
  //
  // Attaching to the inner `ref` key instead would land the comment
  // INSIDE the dash block (`- # Atlassian` on one line) — valid yaml
  // but visually inconsistent with what `init` produces. Unknown /
  // third-party refs produce no summary → no header → bare `- ref:`.
  const summary = loadFeatureManifestSummary(ref);
  const headerBefore = buildFeatureHeaderCommentBefore(
    summary,
    FEATURE_HEADER_WIDTH,
  );
  if (headerBefore.length > 0) {
    (entry as { commentBefore?: string }).commentBefore = headerBefore;
    (entry as { spaceBefore?: boolean }).spaceBefore = true;
  }
  // Credential option hints as a commented `${VAR}` skeleton below the
  // `- ref:` — same placeholders init renders, and the matching env vars
  // are seeded into <name>.env by runAddFeature. As a node `.comment`
  // (the only attachment that survives the move into the sequence),
  // serialized with a `# ` prefix per line.
  const hints = featureOptionHints(summary, ref, Object.keys(options));
  if (hints.length > 0) {
    const commentLines = [' options:'];
    for (const h of hints) commentLines.push(`   ${h.key}: ${h.placeholder}`);
    (entry as { comment?: string }).comment = commentLines.join('\n');
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
    // The `mutate()` wrapper relocates leaked section comments
    // post-mutation — no per-call invocation needed here.
    return true;
  }
  const entry = new YAMLMap();
  entry.set('url', repo.url);
  // Only persist `path` when it differs from the URL-derived default.
  // Keeps the yml minimal — the apply pipeline re-derives at runtime.
  const persistPath = repo.path !== deriveRepoName(repo.url);
  if (persistPath) {
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
  // Surface the optional fields the caller did NOT pass as commented
  // hints right under the entry — same single-`#`-depth shape the
  // generator emits in composed mode (`# path: / # provider: / …`).
  // Without these the builder can't see at a glance what else they
  // could set without re-reading the docs.
  const hintLines: string[] = [];
  if (!persistPath) hintLines.push(' path:');
  if (!repo.provider) hintLines.push(' provider:');
  if (!repo.gitUser) {
    hintLines.push(' git:');
    hintLines.push('   user:');
    hintLines.push('     name:');
    hintLines.push('     email:');
  }
  if (hintLines.length > 0) {
    (entry as { comment?: string }).comment = hintLines.join('\n');
  }
  seq.add(entry);
  // Section-comment relocation runs in `mutate()` post-apply.
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
  const node = doc.get('services', true);
  if (!node || !isSeq(node)) return false;
  const idx = node.items.findIndex(
    (i) => isMap(i) && i.get('name') === service,
  );
  if (idx === -1) return false;
  node.items.splice(idx, 1);
  pruneEmptySeq(doc, 'services');
  return true;
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

  // yaml-lib parks the header comment block that visually precedes
  // entry[idx] as the trailing `.comment` of the PREVIOUS sequence
  // item, separated from that item's own inline hints by a `\n\n`.
  // Splicing the entry doesn't touch the previous sibling, so the
  // header lines would survive in the previous entry's trailing
  // comment and re-emit as orphaned column-2 prose under features.
  // Strip the post-`\n\n` tail from the previous item's comment
  // before we splice — symmetric to how relocateLeakedSectionComments
  // moves the routing-section header forward.
  if (idx > 0) {
    const prev = seq.items[idx - 1] as { comment?: string | null } | null;
    if (prev && typeof prev.comment === 'string' && prev.comment.length > 0) {
      const blank = prev.comment.match(/\n[ \t]*\n/);
      if (blank && blank.index !== undefined) {
        prev.comment = prev.comment.slice(0, blank.index);
      }
    }
  }

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
