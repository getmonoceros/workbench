import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { parseDocument } from 'yaml';
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
      git: z
        .object({
          user: GitUserSchema.optional(),
        })
        .optional(),
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
        .optional(),
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
