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
// Feature refs are OCI-style:
//   <registry>/<namespace>/<feature>:<tag>
// e.g. ghcr.io/devcontainers/features/python:1
//      ghcr.io/getmonoceros/monoceros-features/claude-code:1
const FEATURE_REF_RE = /^[a-z0-9.-]+(\/[a-z0-9._-]+)+:[a-z0-9._-]+$/;
const INSTALL_URL_RE = /^https:\/\/[A-Za-z0-9.\-_~/:?#[\]@!&'()*+,;=%]+$/;
// Repo URLs are HTTPS-only by design. SSH-style URLs (git@host:...,
// ssh://...) are explicitly out of scope — see ADR 0006 for the
// reasoning. The schema rejects them at parse time with a clear
// message rather than letting them through and failing opaquely
// during the clone in post-create.sh.
const REPO_URL_RE = /^https:\/\/[A-Za-z0-9@:/+_~.#=&?-]+$/;
// Path under `projects/`. Allows nested subfolders via `/` (e.g.
// `apps/web`, `monorepo/libs/shared`). The regex enforces:
//   - non-empty
//   - segments use [A-Za-z0-9._-] (same charset as a leaf folder name)
//   - no leading `/`, no trailing `/`, no consecutive `//`
// A separate refine rejects `.` / `..` segments — those would either
// be no-ops or escape `projects/`, neither belongs in a checked-in
// container yml.
const REPO_PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const POSTGRES_URL_RE = /^postgres(ql)?:\/\//;

export const REGEX = {
  solutionName: SOLUTION_NAME_RE,
  aptPackage: APT_PACKAGE_NAME_RE,
  featureRef: FEATURE_REF_RE,
  installUrl: INSTALL_URL_RE,
  repoUrl: REPO_URL_RE,
  repoPath: REPO_PATH_RE,
  postgresUrl: POSTGRES_URL_RE,
};

/**
 * The providers Monoceros knows how to render setup hints for.
 *
 * Canonical SaaS hostnames (`github.com` / `gitlab.com` /
 * `bitbucket.org`) auto-detect to their provider. Everything else
 * — self-hosted GitLab, GitHub Enterprise, Bitbucket Data Center,
 * Gitea / Forgejo — must declare `provider:` explicitly. Gitea has
 * no canonical SaaS host (gitea.com is a demo, not a SaaS), so any
 * `provider: gitea` entry is by definition self-hosted.
 *
 * Forgejo (the community fork of Gitea) shares Gitea's API, UI, and
 * auth flow — we bundle it under `provider: gitea` rather than
 * carrying a separate enum value.
 */
export const PROVIDER_VALUES = [
  'github',
  'gitlab',
  'bitbucket',
  'gitea',
] as const;
export type RepoProvider = (typeof PROVIDER_VALUES)[number];

/**
 * Hostnames whose provider is implicit — no `provider:` field needed
 * in the yml. Everything else (self-hosted GitLab on `git.firma.de`,
 * Gitea instances, …) requires an explicit declaration; the apply
 * pre-flight enforces that.
 */
export const KNOWN_PROVIDER_HOSTS: Readonly<Record<string, RepoProvider>> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
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

export const GitUserSchema = z.object({
  name: z.string().min(1),
  email: z
    .string()
    .min(3)
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email'),
});

export const RepoEntrySchema = z.object({
  url: z
    .string()
    .regex(
      REPO_URL_RE,
      'Invalid repo URL. Only HTTPS URLs are supported (https://...). SSH-style URLs (git@host:..., ssh://...) are not supported.',
    ),
  path: z
    .string()
    .regex(
      REPO_PATH_RE,
      "Invalid repo path. Use letters/digits/'._-', forward slashes for nested folders, no leading or trailing slash.",
    )
    .refine(
      (p) => !p.split('/').some((seg) => seg === '..' || seg === '.'),
      'Repo path segments cannot be "." or "..".',
    )
    .optional(),
  // Per-repo git identity override. Falls back to the container-level
  // `git.user` (which itself falls back to the host's
  // `git config --global` at apply time). Useful when a single
  // container clones multiple repos that need different committer
  // identities — e.g. work GitHub org vs personal projects.
  git: z
    .object({
      user: GitUserSchema.optional(),
    })
    .optional(),
  // Provider hint for the pre-flight credential check. For the three
  // canonical hosts (github.com / gitlab.com / bitbucket.org) the
  // provider is auto-detected and this field is unnecessary. For any
  // other host (self-hosted GitLab on a custom domain, Gitea, …) the
  // builder MUST declare the provider so apply can suggest the right
  // CLI setup (`glab auth login --hostname <host>` etc.) when
  // credentials are missing. Enforced at apply pre-flight, not at
  // parse time — see ADR 0006.
  provider: z.enum(PROVIDER_VALUES).optional(),
});

/**
 * A single entry under `ports:`. Two forms accepted:
 *
 *   ports:
 *     - 3000          # short form: just the port number
 *     - port: 9229    # long form, leaves room for future fields
 *                     # (protocol, path-prefix, entrypoint …)
 *
 * Today both forms carry the same information. The long form exists
 * so additive extensions (TLS entrypoint, path-based routing) don't
 * require a schema break. See ADR 0007.
 */
export const PortEntrySchema = z.union([
  z
    .number()
    .int()
    .min(1, 'Port must be ≥ 1.')
    .max(65535, 'Port must be ≤ 65535.'),
  z.object({
    port: z
      .number()
      .int()
      .min(1, 'Port must be ≥ 1.')
      .max(65535, 'Port must be ≤ 65535.'),
  }),
]);

/**
 * Routing block — everything Monoceros uses to expose container ports
 * to the host through the shared Traefik singleton.
 *
 *   - `ports`: container-internal ports the builder wants reachable
 *     via `<name>.localhost` / `<name>-<port>.localhost`. Short form
 *     `3000` or long form `{ port: 3000 }` are both accepted; mutators
 *     write the short form by default. First port doubles as the
 *     default route under the bare `<name>.localhost`.
 *
 *   - `vscodeAutoForward`: whether VS Code's Dev-Containers extension
 *     should also auto-forward ports on top of Traefik. Default
 *     `false`. Set to `true` only if VS Code's port panel should be
 *     the primary entry rather than `<name>.localhost`.
 *
 * Host-port for the Traefik singleton itself is global (one Traefik
 * per machine), not per container — it lives in `monoceros-config.yml`
 * under `routing.hostPort`. See ADR 0007.
 */
export const RoutingSchema = z.object({
  ports: z.array(PortEntrySchema).default([]),
  vscodeAutoForward: z.boolean().optional(),
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
  routing: RoutingSchema.optional(),
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
export type PortEntry = z.infer<typeof PortEntrySchema>;
export type Routing = z.infer<typeof RoutingSchema>;

/** Resolve a `PortEntry` (short or long form) to a plain port number. */
export function portNumber(entry: PortEntry): number {
  return typeof entry === 'number' ? entry : entry.port;
}

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
