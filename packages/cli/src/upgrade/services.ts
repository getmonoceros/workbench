import {
  type Document,
  isMap,
  isSeq,
  parseDocument,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import {
  currentServiceVersion,
  expandServiceEntry,
  parseServiceRef,
  SERVICE_CATALOG,
  serviceEntryAt,
  type ServiceEntry,
} from '../create/catalog.js';

/**
 * `upgrade` for the services in a workbench yml (#139).
 *
 * A service written by `add-service` or `init` carries `ref: <id>@<n>`, the
 * descriptor version its block came from. Every version stays as a file, so
 * the block that version wrote can be rebuilt (`expandServiceEntry` is pure
 * in the descriptor and the service name). That gives three states for a
 * service whose descriptor has moved on:
 *
 *   base    what version n wrote
 *   ours    the entry as it is in the yml now
 *   theirs  what the newest version writes
 *
 * A field only the template changed takes the new value, a field only the
 * builder changed keeps theirs, and a field both changed differently is a
 * conflict that leaves the whole entry as it is. Maps (`env`,
 * `connectionEnv`, `healthcheck`) are compared key by key, lists as a whole.
 * The result is written field by field into the existing yml nodes, so the
 * comments and the commented-out scaffolds around the entry survive.
 *
 * An entry without `ref` was written before #139 or by hand. When it equals
 * what some version of the descriptor with its image repository writes,
 * apart from the image tag, it is stamped with that version, its tag moves
 * to that version's, and it is then upgraded like any other. Otherwise it only gets the image retag upgrade
 * has always done (ADR 0052), and a custom image nobody claims is left alone.
 *
 * Pure: text in, text out, no I/O.
 */

export interface FieldConflict {
  /** Dotted path inside the entry, e.g. `env.RABBITMQ_DEFAULT_VHOST`. */
  path: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
}

export type ServiceUpgrade =
  | {
      kind: 'upgraded' | 'replaced';
      service: string;
      id: string;
      from: number;
      to: number;
      /** Dev defaults of env keys the new version adds, for `<name>.env`. */
      newEnv: Record<string, string>;
    }
  | {
      kind: 'conflict';
      service: string;
      id: string;
      from: number;
      to: number;
      conflicts: FieldConflict[];
    }
  | { kind: 'stamped'; service: string; id: string; version: number }
  | { kind: 'retagged'; service: string; from: string; to: string };

export interface UpgradeServicesResult {
  yml: string;
  results: ServiceUpgrade[];
}

/** Keys that identify an entry rather than describe it; never merged. */
const IDENTITY = new Set(['name', 'ref']);

export function upgradeServices(
  yml: string,
  opts: { replace?: readonly string[] } = {},
): UpgradeServicesResult {
  const doc = parseDocument(yml);
  const seq = doc.get('services', true);
  const results: ServiceUpgrade[] = [];
  if (!isSeq(seq)) return { yml, results };
  const replace = new Set(opts.replace ?? []);

  (seq as YAMLSeq).items.forEach((node, index) => {
    if (!isMap(node)) return;
    const entry = (node as YAMLMap).toJSON() as Record<string, unknown>;
    const name = String(entry['name'] ?? '');
    let ref = typeof entry['ref'] === 'string' ? entry['ref'] : undefined;

    if (ref === undefined) {
      const stamp = findStamp(entry);
      if (!stamp) {
        const retag = retagImage(entry);
        if (retag) {
          doc.setIn(['services', index, 'image'], retag);
          results.push({
            kind: 'retagged',
            service: name,
            from: String(entry['image']),
            to: retag,
          });
        }
        return;
      }
      ref = `${stamp.id}@${stamp.version}`;
      insertRef(doc, node as YAMLMap, ref);
      entry['ref'] = ref;
      results.push({
        kind: 'stamped',
        service: name,
        id: stamp.id,
        version: stamp.version,
      });
      // The tag it differs in was written by an older catalog, not chosen by
      // the builder: the entry matched that version in everything else. So it
      // moves to the version's tag, as the retag of ADR 0052 always did.
      if (stamp.image !== entry['image']) {
        doc.setIn(['services', index, 'image'], stamp.image);
        results.push({
          kind: 'retagged',
          service: name,
          from: String(entry['image']),
          to: stamp.image,
        });
        entry['image'] = stamp.image;
      }
    }

    const parsed = parseServiceRef(ref);
    if (!parsed) return;
    const current = currentServiceVersion(parsed.id);
    const baseEntry = serviceEntryAt(parsed.id, parsed.version);
    // An unknown descriptor or a missing version file: apply reports both,
    // with the file it looked for, so there is nothing to merge here.
    if (current === undefined || baseEntry === undefined) return;
    const newest = SERVICE_CATALOG[parsed.id]!;

    if (replace.has(name)) {
      writeEntry(doc, index, entry, data(expand(newest, name)));
      doc.setIn(['services', index, 'ref'], `${parsed.id}@${current}`);
      results.push({
        kind: 'replaced',
        service: name,
        id: parsed.id,
        from: parsed.version,
        to: current,
        newEnv: addedEnv(baseEntry, newest),
      });
      return;
    }
    if (current <= parsed.version) return;

    const base = data(expand(baseEntry, name));
    const ours = data(entry);
    const theirs = data(expand(newest, name));
    const conflicts: FieldConflict[] = [];
    const merged = merge3(base, ours, theirs, [], conflicts);
    if (conflicts.length > 0) {
      results.push({
        kind: 'conflict',
        service: name,
        id: parsed.id,
        from: parsed.version,
        to: current,
        conflicts,
      });
      return;
    }
    writeEntry(doc, index, entry, merged as Record<string, unknown>);
    doc.setIn(['services', index, 'ref'], `${parsed.id}@${current}`);
    results.push({
      kind: 'upgraded',
      service: name,
      id: parsed.id,
      from: parsed.version,
      to: current,
      newEnv: addedEnv(baseEntry, newest),
    });
  });

  return { yml: results.length > 0 ? String(doc) : yml, results };
}

/** The block a version writes for a service of this name. */
function expand(def: ServiceEntry, name: string): Record<string, unknown> {
  return { ...expandServiceEntry(def), name } as Record<string, unknown>;
}

/** An entry without the keys that identify it. */
function data(entry: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entry).filter(([key]) => !IDENTITY.has(key)),
  );
}

/**
 * The newest version of the descriptor with this entry's image repository
 * whose block equals the entry apart from the image tag, if any.
 */
function findStamp(
  entry: Record<string, unknown>,
): { id: string; version: number; image: string } | undefined {
  const image = typeof entry['image'] === 'string' ? entry['image'] : '';
  const owner = Object.values(SERVICE_CATALOG).find(
    (def) => imageRepo(def.image) === imageRepo(image),
  );
  if (!owner) return undefined;
  const name = String(entry['name'] ?? '');
  for (let version = owner.version; version >= 1; version--) {
    const def = serviceEntryAt(owner.id, version);
    if (!def) continue;
    const written = { ...data(expand(def, name)), image };
    if (deepEqual(written, data(entry))) {
      return { id: owner.id, version, image: def.image };
    }
  }
  return undefined;
}

/** The catalog's image for an entry nobody could stamp, when it differs. */
function retagImage(entry: Record<string, unknown>): string | undefined {
  const image = typeof entry['image'] === 'string' ? entry['image'] : '';
  const owner = Object.values(SERVICE_CATALOG).find(
    (def) => imageRepo(def.image) === imageRepo(image),
  );
  return owner && owner.image !== image ? owner.image : undefined;
}

/**
 * The repository half of an image reference: everything before the tag or
 * digest. A registry port (`ghcr.io:5000/x/app`) is not a tag, so the split
 * is only a tag when it comes after the last `/`.
 */
export function imageRepo(image: string): string {
  const repo = image.split('@')[0]!;
  const colon = repo.lastIndexOf(':');
  return colon > repo.lastIndexOf('/') ? repo.slice(0, colon) : repo;
}

/** `ref:` goes right under `name:`, where add-service writes it. */
function insertRef(doc: Document, node: YAMLMap, ref: string): void {
  const at = node.items.findIndex(
    (pair) => (pair.key as { value?: unknown })?.value === 'name',
  );
  node.items.splice(at + 1, 0, doc.createPair('ref', ref));
}

/** Env keys the new version adds, with their dev defaults. */
function addedEnv(
  base: ServiceEntry,
  newest: ServiceEntry,
): Record<string, string> {
  const before = new Set(Object.keys(base.env ?? {}));
  return Object.fromEntries(
    Object.entries(newest.env ?? {}).filter(([key]) => !before.has(key)),
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Three-way merge of one value. `undefined` means absent, so a key one side
 * removed is a change like any other.
 */
function merge3(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  path: string[],
  conflicts: FieldConflict[],
): unknown {
  if (deepEqual(ours, theirs)) return ours;
  if (deepEqual(base, ours)) return theirs;
  if (deepEqual(base, theirs)) return ours;
  if (isPlainObject(ours) && isPlainObject(theirs)) {
    const b = isPlainObject(base) ? base : {};
    const out: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(ours), ...Object.keys(theirs)]);
    for (const key of keys) {
      const v = merge3(
        b[key],
        ours[key],
        theirs[key],
        [...path, key],
        conflicts,
      );
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  conflicts.push({ path: path.join('.'), base, ours, theirs });
  return ours;
}

/**
 * Write the merged data into the entry's existing nodes: only what differs
 * from the entry is touched, so comments and key order stay where they are.
 */
function writeEntry(
  doc: Document,
  index: number,
  ours: Record<string, unknown>,
  merged: Record<string, unknown>,
): void {
  writeValue(doc, ['services', index], data(ours), merged);
}

function writeValue(
  doc: Document,
  path: (string | number)[],
  ours: Record<string, unknown>,
  merged: Record<string, unknown>,
): void {
  const keys = new Set([...Object.keys(ours), ...Object.keys(merged)]);
  for (const key of keys) {
    const before = ours[key];
    const after = merged[key];
    if (deepEqual(before, after)) continue;
    const at = [...path, key];
    if (after === undefined) {
      doc.deleteIn(at);
    } else if (isPlainObject(before) && isPlainObject(after)) {
      writeValue(doc, at, before, after);
    } else {
      // Keep a flow list a flow list (`test: [CMD, pg_isready]`).
      const old = doc.getIn(at, true);
      const node = doc.createNode(after);
      if (isSeq(old) && old.flow && isSeq(node)) node.flow = true;
      doc.setIn(at, node);
    }
  }
}
