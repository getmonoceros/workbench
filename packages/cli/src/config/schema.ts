import { z } from 'zod';

/**
 * Shape validation for a Monoceros solution-config yml. Catalog
 * validation (which languages/services actually exist) happens
 * separately in `apply`, against `create/catalog.ts` — that keeps the
 * schema decoupled from the catalog and lets the schema live without
 * pulling the whole devcontainer scaffold module in.
 *
 * Schema mirrors the StackFile shape from `create/types.ts` except:
 *
 *   - `features` is an **array** of `{ ref, options }` entries (yml is
 *     edited by humans and arrays diff/comment better than maps).
 *     The apply step converts to the Record shape `devcontainer.json`
 *     expects.
 *
 *   - `externalServices.postgres` carries what `CreateOptions.postgresUrl`
 *     does today.
 *
 *   - `git.user.{name,email}` carries the host-captured identity so the
 *     yml-as-profile is self-contained when shared across containers.
 *     Optional — falls back to host-side `git config --global --get` +
 *     `.monoceros/gitconfig` at apply time, same as today.
 */

const SOLUTION_NAME_RE = /^[A-Za-z0-9._-]+$/;
const APT_PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9.+-]*$/;
const FEATURE_REF_RE = /^[a-z0-9.-]+(\/[a-z0-9._-]+)+:[a-z0-9._-]+$/;
const INSTALL_URL_RE = /^https:\/\/[A-Za-z0-9.\-_~/:?#[\]@!&'()*+,;=%]+$/;
const REPO_URL_RE = /^[A-Za-z0-9@:/+_~.#=&?-]+$/;
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;
const REPO_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const POSTGRES_URL_RE = /^postgres(ql)?:\/\//;

export const REGEX = {
  solutionName: SOLUTION_NAME_RE,
  aptPackage: APT_PACKAGE_NAME_RE,
  featureRef: FEATURE_REF_RE,
  installUrl: INSTALL_URL_RE,
  repoUrl: REPO_URL_RE,
  repoName: REPO_NAME_RE,
  repoBranch: REPO_BRANCH_RE,
  postgresUrl: POSTGRES_URL_RE,
};

/** Current schema version. Bumped only on breaking yml changes. */
export const CONFIG_SCHEMA_VERSION = 1 as const;

export const FeatureOptionValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
]);

export const FeatureEntrySchema = z.object({
  ref: z
    .string()
    .regex(
      FEATURE_REF_RE,
      "Invalid feature ref. Expected an OCI-image-style ref like 'ghcr.io/devcontainers/features/<name>:<tag>'.",
    ),
  options: z.record(z.string(), FeatureOptionValueSchema).optional(),
});

export const RepoEntrySchema = z.object({
  url: z
    .string()
    .regex(
      REPO_URL_RE,
      'Invalid repo URL. Use HTTPS or SSH/git@ form; no shell metacharacters.',
    ),
  name: z
    .string()
    .regex(
      REPO_NAME_RE,
      'Invalid repo name. Folder name must match /^[A-Za-z0-9._-]+$/.',
    )
    .optional(),
  branch: z
    .string()
    .regex(
      REPO_BRANCH_RE,
      'Invalid branch name. Must match /^[A-Za-z0-9._/-]+$/.',
    )
    .optional(),
});

export const GitUserSchema = z.object({
  name: z.string().min(1),
  email: z
    .string()
    .min(3)
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email'),
});

export const ExternalServicesSchema = z.object({
  postgres: z
    .string()
    .regex(
      POSTGRES_URL_RE,
      "Postgres URL must start with 'postgres://' or 'postgresql://'",
    )
    .optional(),
});

export const SolutionConfigSchema = z.object({
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  name: z
    .string()
    .regex(
      SOLUTION_NAME_RE,
      "Invalid solution name. Use letters, digits, '.', '_' or '-'.",
    ),
  languages: z.array(z.string().min(1)).default([]),
  aptPackages: z
    .array(
      z
        .string()
        .regex(
          APT_PACKAGE_NAME_RE,
          "Invalid apt package name. Expected lowercase alphanumeric plus '.+-'.",
        ),
    )
    .default([]),
  features: z.array(FeatureEntrySchema).default([]),
  installUrls: z
    .array(
      z
        .string()
        .regex(
          INSTALL_URL_RE,
          "Invalid install URL. Must start with 'https://' and contain only URL-safe characters (no shell metacharacters).",
        ),
    )
    .default([]),
  services: z.array(z.string().min(1)).default([]),
  repos: z.array(RepoEntrySchema).default([]),
  externalServices: ExternalServicesSchema.default({}),
  git: z
    .object({
      user: GitUserSchema.optional(),
    })
    .optional(),
});

export type SolutionConfig = z.infer<typeof SolutionConfigSchema>;
export type FeatureEntry = z.infer<typeof FeatureEntrySchema>;
export type RepoEntry = z.infer<typeof RepoEntrySchema>;
export type GitUser = z.infer<typeof GitUserSchema>;
export type ExternalServices = z.infer<typeof ExternalServicesSchema>;

/**
 * Validate parsed yml (e.g. from `doc.toJS()`) against the schema. On
 * failure, throws an Error whose message lists every issue with its
 * dotted path — the apply step prints that verbatim, so the builder
 * sees exactly which yml field is wrong.
 */
export function validateConfig(input: unknown): SolutionConfig {
  const result = SolutionConfigSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `  - ${where}: ${issue.message}`;
      })
      .join('\n');
    throw new Error(`Invalid solution config:\n${issues}`);
  }
  return result.data;
}
