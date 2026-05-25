import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { isMap, parseDocument } from 'yaml';
import { FeatureOptionValueSchema, GitUserSchema, REGEX } from './schema.js';
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
          user: GitUserSchema.optional(),
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

  if (text === undefined) {
    // Brand-new file — minimal shape. We don't try to mirror the
    // sample yml's comments here; the install path drops the sample
    // alongside, and a builder who wants the full reference reads
    // monoceros-config.sample.yml.
    const fresh = [
      '# Monoceros — builder-global defaults.',
      '#',
      '# Created on first apply when the identity prompt chose "save',
      '# globally". See monoceros-config.sample.yml in the same',
      '# directory for the full set of fields.',
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

  // Existing file. We DELIBERATELY do not use the yaml AST setter
  // here even though the rest of the codebase prefers it: the yaml
  // library's comment-attachment heuristic gets confused by the
  // shipped sample's structure (section-divider comments between
  // sub-blocks attach to the wrong node, so a `set('git', …)` lands
  // mid-file with comments rearranged around it). Result on real
  // user files was visible chaos.
  //
  // String-based insert is uglier as code but deterministic for
  // text: we parse only to validate, then locate the `defaults:` /
  // `git.user` regions textually and either insert a new block or
  // bail because one's already there.

  // First: validate via the real schema. A user-broken file should
  // fail loudly here, before we try to splice into it.
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length > 0) {
    throw new Error(
      `yaml parse error in ${filePath}: ${doc.errors[0]!.message}`,
    );
  }

  // alreadySet: walk the parsed structure (read-only) just to detect
  // an existing defaults.git.user. We never write through the AST.
  const parsedDefaults = doc.get('defaults', true);
  if (parsedDefaults && isMap(parsedDefaults)) {
    const gitNode = parsedDefaults.get('git', true);
    if (gitNode && isMap(gitNode)) {
      const userNode = gitNode.get('user', true);
      if (userNode && isMap(userNode)) {
        const existingName = userNode.get('name');
        const existingEmail = userNode.get('email');
        if (
          typeof existingName === 'string' &&
          existingName.length > 0 &&
          typeof existingEmail === 'string' &&
          existingEmail.length > 0
        ) {
          return { filePath, created: false, alreadySet: true };
        }
      }
    }
  }

  // No active defaults.git.user. Splice an active block into the
  // file's text. Two cases:
  //
  //   A) `defaults:` exists as a top-level line → insert the
  //      git/user block right after it. 2-space indent puts it at
  //      the same level as features/git/etc. The block goes BEFORE
  //      any existing sub-keys, but that's harmless — yaml mapping
  //      order is presentational, not semantic.
  //
  //   B) `defaults:` doesn't exist (rare — file with only routing,
  //      say) → append a fresh `defaults:` block at the end.
  //
  // Either way, the surrounding comments stay byte-for-byte
  // unchanged: we never touch them, just splice new lines in.
  const block = [
    '  git:',
    '    user:',
    `      name: ${user.name}`,
    `      email: ${user.email}`,
    '',
  ].join('\n');

  const defaultsLineMatch = text.match(/^defaults:[ \t]*\r?\n/m);
  let newText: string;
  if (defaultsLineMatch && defaultsLineMatch.index !== undefined) {
    const insertAt = defaultsLineMatch.index + defaultsLineMatch[0].length;
    newText = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Make sure we end the existing content with a newline before
    // appending the new section.
    const trimmedEnd = text.replace(/\s*$/, '\n');
    newText =
      trimmedEnd + '\n' + ['defaults:', block].join('\n').replace(/\n$/, '\n');
  }

  await fs.writeFile(filePath, newText, 'utf8');
  return { filePath, created: false, alreadySet: false };
}
