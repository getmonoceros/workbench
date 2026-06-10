import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { isMap, Pair, parseDocument, Scalar, YAMLMap } from 'yaml';
import type { Document } from 'yaml';
import {
  FeatureOptionValueSchema,
  GitUserSchema,
  REGEX,
  isValidEmail,
} from './schema.js';
import { monocerosConfigPath, monocerosHome } from './paths.js';

/**
 * `<MONOCEROS_HOME>/monoceros-config.yml` — optional builder-owned
 * defaults that apply across every container materialized through
 * this home. Today the only field is git identity; future fields
 * (default editor, Claude auth profile, ...) plug into the same
 * structure.
 *
 * Schema is permissive: missing top-level keys are fine, the file
 * itself is optional. Schema violations surface as a hard error
 * (better to refuse than silently ignore a typo'd key the builder
 * thought was effective).
 */

const SCHEMA_VERSION = 1 as const;

/**
 * `defaults.features` — map of devcontainer feature ref to a default
 * option object. When a container yml references the same feature ref
 * without overriding a specific option, the value from here is used.
 * Per-container options always win.
 *
 * Typical use: stash the Atlassian apiToken / Anthropic apiKey here
 * once globally instead of repeating them in every container yml.
 */
export const MonocerosConfigSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  // .nullish() (= .optional().nullable()) on defaults so the shipped
  // sample yml — where `defaults:` is uncommented but every sub-block
  // is commented out — parses cleanly. YAML produces `defaults: null`
  // in that case; without .nullish() the schema would reject it and
  // we'd be back to forcing builders to comment-juggle three lines.
  defaults: z
    .object({
      // .nullish() (not just .optional()) so the sample yml can leave
      // `git:` uncommented as a category marker — YAML produces
      // `git: null` for an empty mapping, which zod's plain
      // `.optional()` would reject.
      git: z
        .object({
          // Strict email here: monoceros-config defaults are not tied to
          // any container `<name>.env`, so `${VAR}` placeholders make no
          // sense and the format can (and should) be validated at load
          // time — unlike the container/repo `git.user`, which defers to
          // apply after interpolation.
          user: GitUserSchema.optional().refine(
            (u) => u?.email === undefined || isValidEmail(u.email),
            { message: 'Invalid email in defaults.git.user', path: ['email'] },
          ),
        })
        .nullish(),
      // .nullish() for the same reason as `git` — the sample keeps
      // `features:` uncommented as a category marker.
      features: z
        .record(
          z
            .string()
            .regex(
              REGEX.featureRef,
              "Invalid feature ref. Expected an OCI-image-style ref like 'ghcr.io/getmonoceros/monoceros-features/<name>:<tag>'.",
            ),
          z.record(z.string(), FeatureOptionValueSchema),
        )
        .nullish(),
    })
    .nullish(),
  // Machine-global routing settings — one Traefik per builder, so
  // host-port and similar live here rather than in any container yml.
  // See ADR 0007.
  routing: z
    .object({
      hostPort: z
        .number()
        .int()
        .min(1)
        .max(65535)
        .optional()
        .describe(
          'Host port the Traefik singleton binds. Default 80. Set this when 80 is held by another service on your machine — URLs then become http://<name>.localhost:<port>/.',
        ),
    })
    .nullish(),
  // Tool-freshness settings (ADR 0018). One machine-global knob.
  upgrade: z
    .object({
      staleDays: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Days after the last `monoceros upgrade` before `apply` nudges you to refresh tooling. Default 30.',
        ),
    })
    .nullish(),
});

export type MonocerosConfig = z.infer<typeof MonocerosConfigSchema>;

export interface ReadMonocerosConfigOptions {
  /** Override of the user-data home. Tests inject a tmpdir. */
  monocerosHome?: string;
}

/**
 * Read `<home>/monoceros-config.yml`. Returns `undefined` if the file
 * isn't there (the normal case for a fresh setup). Throws on a parse
 * or schema error — the builder explicitly created the file, so a
 * silent ignore would be worse than a loud abort.
 */
export async function readMonocerosConfig(
  opts: ReadMonocerosConfigOptions = {},
): Promise<MonocerosConfig | undefined> {
  const home = opts.monocerosHome ?? monocerosHome();
  const filePath = monocerosConfigPath(home);
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length > 0) {
    throw new Error(
      `yaml parse error in ${filePath}: ${doc.errors[0]!.message}`,
    );
  }
  const result = MonocerosConfigSchema.safeParse(doc.toJS());
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `  - ${where}: ${issue.message}`;
      })
      .join('\n');
    throw new Error(
      `Invalid ${filePath}:\n${issues}\n\nSee ${filePath.replace(
        /\.yml$/,
        '.sample.yml',
      )} for a valid example.`,
    );
  }
  return result.data;
}

/** Default Traefik host port when `routing.hostPort` is unset. */
export const DEFAULT_PROXY_HOST_PORT = 80;

/**
 * Effective host port the Traefik singleton should bind. Falls back
 * to `DEFAULT_PROXY_HOST_PORT` (80) when the global config or its
 * `routing.hostPort` field is absent.
 */
export function proxyHostPort(config?: MonocerosConfig | undefined): number {
  return config?.routing?.hostPort ?? DEFAULT_PROXY_HOST_PORT;
}

export interface WriteGlobalDefaultGitUserResult {
  /** Absolute path to the file that was written. */
  filePath: string;
  /** True when a brand-new file was created (no monoceros-config.yml before). */
  created: boolean;
  /** True when an existing defaults.git.user was already set and we left it alone. */
  alreadySet: boolean;
}

/**
 * Persist `defaults.git.user` in `<MONOCEROS_HOME>/monoceros-config.yml`.
 *
 * Behaviour:
 *
 *   - File missing → create with the minimum shape (`schemaVersion: 1`
 *     + `defaults.git.user`). `monoceros-config.sample.yml` carries
 *     the canonical documentation; we don't reproduce it here.
 *   - File present, no `defaults.git.user` → fill it in,
 *     comment-preserving (the rest of the file stays untouched).
 *   - File present, `defaults.git.user` already set → leave as-is,
 *     report `alreadySet: true`. The caller decides whether to warn
 *     or fall back to a per-container override.
 *
 * The caller (apply / init identity flow) decides when to call this
 * — typically only when the builder explicitly chose `g` (global) or
 * `b` (both) in the scope prompt.
 */
export async function writeGlobalDefaultGitUser(
  user: { name: string; email: string },
  opts: { monocerosHome?: string } = {},
): Promise<WriteGlobalDefaultGitUserResult> {
  const home = opts.monocerosHome ?? monocerosHome();
  const filePath = monocerosConfigPath(home);

  let text: string | undefined;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    text = undefined;
  }

  // Brand-new file → write the minimal shape that mirrors the
  // shipped sample's structure (so a later auto-write can navigate
  // the same paths).
  if (text === undefined) {
    const fresh = [
      '# Optional — global defaults for monoceros containers.',
      '',
      'schemaVersion: 1',
      '',
      'defaults:',
      '  git:',
      '    user:',
      `      name: ${user.name}`,
      `      email: ${user.email}`,
      '',
    ].join('\n');
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(filePath, fresh, 'utf8');
    return { filePath, created: true, alreadySet: false };
  }

  // Existing file: operate via the yaml AST. With the simplified
  // sample (no nested commented sub-blocks under the active keys),
  // AST set-at-path is the right tool — the library can no longer
  // attach unrelated comments to the wrong node because there are
  // no fragmented comment runs between sibling maps.
  //
  // We ensure each level of the path (`defaults` → `git` → `user`)
  // exists as a YAMLMap, then set the two scalar fields. Pre-existing
  // values that are non-empty mean "already set" and we leave them
  // alone.
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length > 0) {
    throw new Error(
      `yaml parse error in ${filePath}: ${doc.errors[0]!.message}`,
    );
  }

  const defaultsMap = ensureMap(doc, 'defaults');
  // `git` is placed at the FRONT of `defaults` when newly created —
  // mirrors the shipped-sample layout (`defaults.git` before
  // `defaults.features`). A pre-existing `git:` keeps its position.
  const gitMap = ensureSubMapAtTop(defaultsMap, 'git');
  const userMap = ensureSubMap(gitMap, 'user');

  const existingName = userMap.get('name');
  const existingEmail = userMap.get('email');
  if (
    typeof existingName === 'string' &&
    existingName.length > 0 &&
    typeof existingEmail === 'string' &&
    existingEmail.length > 0
  ) {
    return { filePath, created: false, alreadySet: true };
  }

  // yaml's parser sometimes attaches a comment that visually belongs to
  // the NEXT outer-level sibling (e.g. `# Feature credentials & options.`
  // sitting above `features:`) to the trailing leaf scalar instead
  // (here: `email:`'s value). If we just `.set()`, that orphaned
  // comment renders right after our new value, producing chaos like:
  //   email:
  //
  //       a@example.com # Feature credentials & options.
  //
  // Relocate any such leaked comment to the next sibling of `git` under
  // `defaults` (the position it visually belongs to) before writing.
  relocateLeakedLeafComments(userMap, defaultsMap, 'git');

  userMap.set('name', user.name);
  userMap.set('email', user.email);
  const newText = String(doc);

  await fs.writeFile(filePath, newText, 'utf8');
  return { filePath, created: false, alreadySet: false };
}

/**
 * Get the document's top-level `<key>` as a YAMLMap, creating it
 * (and replacing a null/scalar value with a fresh map) if needed.
 * Used by writeGlobalDefaultGitUser to navigate to the persistence
 * point without crashing on yml shapes like `defaults:` (parsed as
 * null) or a missing top-level key.
 */
function ensureMap(doc: Document, key: string): YAMLMap {
  const node = doc.get(key, true);
  if (node && isMap(node)) return node;
  const m = new YAMLMap();
  doc.set(key, m);
  return m;
}

/** Same as ensureMap but for a sub-key under an existing YAMLMap. */
function ensureSubMap(parent: YAMLMap, key: string): YAMLMap {
  const node = parent.get(key, true);
  if (node && isMap(node)) return node;
  const m = new YAMLMap();
  parent.set(key, m);
  return m;
}

/**
 * Variant of `ensureSubMap` that inserts a *new* key at the FRONT of
 * `parent.items` rather than appending. Used for `defaults.git` so the
 * new block lands where the shipped sample places it (above
 * `features`) and not at the end after every other entry. A
 * pre-existing key keeps its position untouched.
 *
 * Before inserting, transfers any `commentBefore` that yaml-lib
 * attached to `parent` itself (this happens when the source's
 * leading comment-block ABOVE parent's first child was associated
 * with the map node rather than the first Pair) over to that first
 * child's key — otherwise the comment would visually re-attach to
 * our newly-front-inserted pair and mislabel it.
 */
function ensureSubMapAtTop(parent: YAMLMap, key: string): YAMLMap {
  const node = parent.get(key, true);
  if (node && isMap(node)) return node;

  type CommentNode = {
    commentBefore?: string | null;
    spaceBefore?: boolean;
  };
  const parentMaybe = parent as CommentNode;
  const newKey = new Scalar(key);

  // yaml-lib often parks the comment-block above parent's first
  // child on the map node itself, not on the Pair. When we unshift
  // a new front Pair we have to redistribute that block: the first
  // paragraph (everything up to a blank-line separator) describes
  // what we're inserting, so it travels with the new key; the rest
  // continues to describe the old first child.
  //
  // Before redistributing we strip any commented-out skeleton of the
  // same key (`# git: / #   user: / #     name: …`) — that's the
  // placeholder a builder leaves behind when they un-commented prose
  // but not the structural keys. We're about to write a real active
  // block; the placeholder would otherwise sit right next to it as
  // dead text.
  if (
    parent.items.length > 0 &&
    typeof parentMaybe.commentBefore === 'string' &&
    parentMaybe.commentBefore.length > 0
  ) {
    const cleaned = stripCommentedKeySkeleton(parentMaybe.commentBefore, key);
    const blankMatch = cleaned.match(/\n[ \t]*\n/);
    let head: string;
    let tail: string;
    if (blankMatch && blankMatch.index !== undefined) {
      head = cleaned.slice(0, blankMatch.index);
      tail = cleaned.slice(blankMatch.index + blankMatch[0].length);
    } else {
      head = cleaned;
      tail = '';
    }
    if (head.length > 0) {
      newKey.commentBefore = head;
      if (parentMaybe.spaceBefore) newKey.spaceBefore = true;
    }
    if (tail.length > 0) {
      const firstKey = parent.items[0]!.key as CommentNode | null;
      if (firstKey && typeof firstKey === 'object') {
        const existing = firstKey.commentBefore ?? '';
        firstKey.commentBefore = existing ? `${tail}\n${existing}` : tail;
        firstKey.spaceBefore = true;
      }
    }
    parentMaybe.commentBefore = null;
    parentMaybe.spaceBefore = false;
  }

  const m = new YAMLMap();
  const pair = new Pair(newKey, m);
  parent.items.unshift(pair);
  return m;
}

/**
 * Remove a commented-out skeleton of `key` (and its indented children)
 * from a yaml-lib `commentBefore` body.
 *
 * yaml-lib stores comment bodies stripped of the leading `#`: the
 * source `#   user:` becomes `   user:` in the comment string. So a
 * placeholder like
 *
 *     # git:
 *     #   user:
 *     #     name: "T"
 *     #     email: "h@k.de"
 *
 * lives in the comment body as four lines, the first ` git:` (single
 * leading space, the post-`#` convention) and the next three with
 * more leading spaces (the children of the commented map).
 *
 * Detection: a line matching ` <key>:` exactly, followed by zero or
 * more lines whose leading whitespace is strictly deeper than that
 * line's. Splice all of those out. Multiple skeletons (rare but
 * possible) get stripped in sequence.
 */
function stripCommentedKeySkeleton(commentBody: string, key: string): string {
  const lines = commentBody.split('\n');
  const headRe = new RegExp(`^ ${escapeRegExp(key)}:\\s*$`);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (headRe.test(line)) {
      // Skip the header and all following indented (deeper than
      // one space) lines — those are the commented map's children.
      i++;
      while (i < lines.length && /^ {2,}\S/.test(lines[i]!)) {
        i++;
      }
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Walk `leafMap`'s pair values. For any value scalar carrying a comment
 * (yaml's parser attaches the next outer-level pair's leading comment
 * to the previous level's trailing scalar when the indent drops by
 * more than one), move that comment to the `commentBefore` of the next
 * sibling of `ancestorKey` in `parent`. Also clear `spaceBefore` on
 * the leaf and set it on the relocation target so the blank line
 * re-appears in the right place.
 *
 * No-op when there's no leaked comment or no next sibling to host it.
 */
function relocateLeakedLeafComments(
  leafMap: YAMLMap,
  parent: YAMLMap,
  ancestorKey: string,
): void {
  const items = parent.items;
  const ancestorIdx = items.findIndex((p) => {
    const k = p.key as { value?: unknown } | string | null;
    const v = typeof k === 'string' ? k : (k?.value ?? null);
    return v === ancestorKey;
  });
  if (ancestorIdx < 0 || ancestorIdx + 1 >= items.length) return;
  const target = items[ancestorIdx + 1]!;
  type CommentNode = {
    comment?: string | null;
    commentBefore?: string | null;
    spaceBefore?: boolean;
  };
  for (const pair of leafMap.items) {
    const value = pair.value as CommentNode | null;
    if (!value || typeof value !== 'object') continue;
    const leakedComment = value.comment;
    const leakedSpace = value.spaceBefore;
    if (!leakedComment && !leakedSpace) continue;
    if (leakedComment) {
      const targetKey = target.key as CommentNode | null;
      if (targetKey && typeof targetKey === 'object') {
        const existing = targetKey.commentBefore ?? '';
        targetKey.commentBefore = existing
          ? `${leakedComment}\n${existing}`
          : leakedComment;
        if (leakedSpace) targetKey.spaceBefore = true;
      }
      value.comment = null;
    }
    if (leakedSpace) value.spaceBefore = false;
  }
}
