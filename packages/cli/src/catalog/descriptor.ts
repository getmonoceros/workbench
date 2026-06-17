import { z } from 'zod';
import { REGEX } from '../config/schema.js';

/**
 * Unified component descriptor (`component.yml`) — the single source of
 * truth for one catalog component (a language, a service, or a feature).
 * See ADR 0020. This module owns only the *schema + types*; loading from
 * disk lives in `./load.ts`, and nothing consumes it yet (Phase 1 is
 * additive — the old `catalog.ts` + `templates/components/*.yml` paths
 * still run unchanged).
 *
 * One descriptor replaces what used to be spread across `catalog.ts`
 * (config-in-code), the hand-written `devcontainer-feature.json`, and the
 * `templates/components/*.yml` fragment. The shape is a common head, one
 * option model, optional briefing, and exactly one category-specific
 * block matching `category`.
 */

/** Component identifier: lowercase, e.g. `java`, `postgres`, `claude-code`. */
export const DESCRIPTOR_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export const CategorySchema = z.enum(['language', 'service', 'feature']);
export type DescriptorCategory = z.infer<typeof CategorySchema>;

const OptionTypeSchema = z.enum(['string', 'boolean', 'number']);

/**
 * Where an option's value is written when a container is composed:
 *   - `yml`    → a literal `key: <default>` in `container-configs/<name>.yml`
 *                (visible, editable; e.g. claude `permissionMode: auto`)
 *   - `env`    → a `key: ${ENV_VAR}` placeholder in the yml, with the var
 *                seeded into `<name>.env`. This is the old `optionHints`
 *                behavior — credentials and per-site config the builder
 *                fills in (e.g. apiKey, atlassian instance/email).
 *   - `silent` → only into the generated devcontainer.json (not surfaced;
 *                e.g. a feature `version` that floats to latest, ADR 0018)
 *
 * Defaults to `silent`: an option is hidden unless a descriptor opts in.
 */
const SurfaceSchema = z.enum(['yml', 'silent', 'env']);

const OptionValueSchema = z.union([z.string(), z.boolean(), z.number()]);

export const OptionSpecSchema = z.object({
  type: OptionTypeSchema,
  default: OptionValueSchema.optional(),
  description: z.string().optional(),
  surface: SurfaceSchema.default('silent'),
  /** Suggested values (rendered as devcontainer `proposals`). */
  proposals: z.array(z.string()).optional(),
});
export type OptionSpec = z.infer<typeof OptionSpecSchema>;

export const BriefingLineSchema = z.object({
  text: z.string().min(1),
  /**
   * Option name; the line is emitted only when that option resolves
   * truthy (after merging defaults + user options). Must reference an
   * option declared on the same descriptor.
   */
  whenOption: z.string().optional(),
});
export type BriefingLine = z.infer<typeof BriefingLineSchema>;

const HealthcheckSchema = z.object({
  test: z.array(z.string()).min(1),
  interval: z.string().optional(),
  timeout: z.string().optional(),
  retries: z.number().int().positive().optional(),
  startPeriod: z.string().optional(),
});

/** `category: language` block — maps to an upstream devcontainer feature. */
export const LanguageBlockSchema = z.object({
  /** Upstream OCI feature ref, e.g. `ghcr.io/devcontainers/features/java:1`. */
  feature: z.string().regex(REGEX.featureRef),
  /** True when the toolchain is already in the base runtime image (node). */
  builtin: z.boolean().default(false),
  /**
   * Version shown inline in the generated yml (`name:<defaultVersion>`), so
   * the builder sees where to edit it. Should equal the upstream feature's
   * real default to stay behavior-neutral. For a `builtin` language it is the
   * base-image version; pinning that exact version stays builtin (no feature
   * install), only a different version triggers the upstream feature.
   * Coerced to string so bare YAML numbers (`defaultVersion: 22`) work.
   */
  defaultVersion: z.coerce.string().optional(),
  /**
   * Versions the upstream feature accepts (docs/UX only, not enforced).
   * Coerced to string so authors can write bare YAML numbers
   * (`versions: [latest, 21, 17]`) without quoting.
   */
  versions: z.array(z.coerce.string()).optional(),
});
export type LanguageBlock = z.infer<typeof LanguageBlockSchema>;

/** `category: service` block — a backing container the workspace talks to. */
export const ServiceBlockSchema = z.object({
  image: z.string().min(1),
  defaultPort: z.number().int().positive().optional(),
  dataMount: z.string().optional(),
  /**
   * Compose `user:` for the service container (e.g. `"0:0"`). Needed for
   * images that run as a fixed non-root uid yet must write a host
   * bind-mounted `dataMount`: a freshly-created host data dir is owned by
   * the apply user, and on native Linux (no Docker-Desktop ownership
   * remapping) such an image cannot write it and exits. Running as root
   * lets it write the mount — the same de-facto situation as postgres,
   * whose image starts as root and chowns its data dir. E.g. rustfs.
   */
  user: z.string().min(1).optional(),
  healthcheck: HealthcheckSchema.optional(),
  /**
   * Connection env injected into the WORKSPACE container so the app / agent
   * can reach this service without hardcoding anything. Keyed by logical
   * SUFFIX → template; emitted at apply as `<UPPER(name)>_<SUFFIX>` per
   * service instance (ADR 0021), e.g. suffix `URL` on a service named
   * `postgres` → `POSTGRES_URL`. Tokens: `${host}` (the service's instance
   * name), `${port}` (its port, falling back to `defaultPort`), and
   * `${<OPTION>}` (its own option values, e.g. `${POSTGRES_USER}`). Example:
   *   URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${host}:${port}/${POSTGRES_DB}
   *   HOST: ${host}
   */
  connectionEnv: z.record(z.string(), z.string()).optional(),
  /**
   * CLI client tool(s) for this service, installed into the WORKSPACE
   * container at apply so the dev/agent can use them (the service runs in its
   * own container; the workspace has no client otherwise). `apt` packages are
   * merged into the workspace's apt-packages feature (build-time, cached);
   * `npm` packages are installed globally in post-create (guarded, so it's a
   * no-op once present). E.g. postgres → apt `postgresql-client` (`psql`),
   * mongodb → npm `mongosh`. See ADR 0020.
   */
  client: z
    .object({
      apt: z.array(z.string()).optional(),
      npm: z.array(z.string()).optional(),
    })
    .optional(),
  vscodeExtensions: z.array(z.string()).optional(),
});
export type ServiceBlock = z.infer<typeof ServiceBlockSchema>;

const PersistentHomeFileSchema = z.object({
  path: z.string().min(1),
  initialContent: z.string().optional(),
});

/**
 * One feature-contributed block of WORKSPACE runtime env (the feature-side
 * sibling of a service's `connectionEnv`, ADR 0021). `vars` maps env-var
 * names to templates; a template references the feature's own option values
 * with `${optionName}` and is filled at scaffold time against the resolved
 * options. When `whenOption` is set, the whole block is emitted only if that
 * option resolves truthy. Used so a feature can hand the workspace process
 * environment named vars (e.g. atlassian `forge` -> `FORGE_EMAIL` /
 * `FORGE_API_TOKEN`) without a per-tool login dance.
 */
const WorkspaceEnvBlockSchema = z.object({
  whenOption: z.string().optional(),
  vars: z.record(z.string(), z.string()),
});
export type WorkspaceEnvBlock = z.infer<typeof WorkspaceEnvBlockSchema>;

/** `category: feature` block — a tool we author and publish to GHCR. */
export const FeatureBlockSchema = z.object({
  /** Publishable feature version (devcontainer-feature.json `version`). */
  version: z.string().min(1),
  persistentHomePaths: z.array(z.string().min(1)).optional(),
  persistentHomeFiles: z.array(PersistentHomeFileSchema).optional(),
  vscodeExtensions: z.array(z.string()).optional(),
  /**
   * Named runtime env injected into the workspace container (compose
   * `environment:` / image-mode `containerEnv`). Catalog/CLI-side only — not
   * emitted into the published devcontainer-feature.json (like `presets`),
   * because it drives how the workbench wires the container, not the feature
   * install. See `featureWorkspaceEnv` in create/scaffold.ts.
   */
  workspaceEnv: z.array(WorkspaceEnvBlockSchema).optional(),
});
export type FeatureBlock = z.infer<typeof FeatureBlockSchema>;

/** Pull the `${option}` tokens referenced by a workspaceEnv template set. */
function workspaceEnvTokens(vars: Record<string, string>): string[] {
  const tokens: string[] = [];
  for (const template of Object.values(vars)) {
    for (const m of template.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)) {
      tokens.push(m[1]!);
    }
  }
  return tokens;
}

export const DescriptorSchema = z
  .object({
    id: z
      .string()
      .regex(DESCRIPTOR_ID_RE, 'id must be lowercase letters/digits/hyphens'),
    /**
     * CLI/yml selector name (catalog key). Defaults to `id`. Lets a feature
     * keep a short selector (`claude`) while its published manifest id stays
     * canonical (`claude-code`).
     */
    name: z
      .string()
      .regex(DESCRIPTOR_ID_RE, 'name must be lowercase letters/digits/hyphens')
      .optional(),
    category: CategorySchema,
    displayName: z.string().min(1),
    description: z.string().min(1),
    documentationURL: z.string().url().optional(),
    options: z.record(z.string(), OptionSpecSchema).default({}),
    /** Free-text notes rendered above the component block at `init`. */
    usageNotes: z.array(z.string()).default([]),
    briefing: z.array(BriefingLineSchema).default([]),
    language: LanguageBlockSchema.optional(),
    service: ServiceBlockSchema.optional(),
    feature: FeatureBlockSchema.optional(),
    /**
     * Named option-override presets. Each becomes a selectable
     * `<name>/<presetKey>` component (e.g. `atlassian/twg`); the bare
     * component keeps the descriptor's own option defaults. Feature-only.
     */
    presets: z
      .record(
        z.string().regex(DESCRIPTOR_ID_RE),
        z.record(z.string(), OptionValueSchema),
      )
      .optional(),
  })
  .superRefine((data, ctx) => {
    // Exactly one category-specific block, and it must match `category`.
    const present = (
      [
        data.language ? 'language' : null,
        data.service ? 'service' : null,
        data.feature ? 'feature' : null,
      ].filter(Boolean) as DescriptorCategory[]
    ).sort();
    if (present.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `missing the '${data.category}' block required by category '${data.category}'`,
      });
    } else if (present.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `exactly one of language/service/feature is allowed, got: ${present.join(', ')}`,
      });
    } else if (present[0] !== data.category) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `category '${data.category}' requires a '${data.category}' block, found '${present[0]}'`,
      });
    }

    // Every briefing.whenOption must reference a declared option.
    const optionKeys = new Set(Object.keys(data.options));
    data.briefing.forEach((line, i) => {
      if (line.whenOption !== undefined && !optionKeys.has(line.whenOption)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['briefing', i, 'whenOption'],
          message: `whenOption '${line.whenOption}' is not a declared option`,
        });
      }
    });

    // Every feature.workspaceEnv block must reference declared options, both
    // in its `whenOption` gate and in each `${token}` of its var templates —
    // an unknown reference would silently render empty, which is a feature-
    // author bug worth catching at load time.
    data.feature?.workspaceEnv?.forEach((block, i) => {
      if (block.whenOption !== undefined && !optionKeys.has(block.whenOption)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['feature', 'workspaceEnv', i, 'whenOption'],
          message: `whenOption '${block.whenOption}' is not a declared option`,
        });
      }
      for (const token of workspaceEnvTokens(block.vars)) {
        if (!optionKeys.has(token)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['feature', 'workspaceEnv', i, 'vars'],
            message: `workspaceEnv template references '\${${token}}', which is not a declared option`,
          });
        }
      }
    });

    // Presets are feature-only, and each override must target a declared option.
    if (data.presets) {
      if (data.category !== 'feature') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['presets'],
          message: `presets are only allowed on features, not '${data.category}'`,
        });
      }
      for (const [presetKey, overrides] of Object.entries(data.presets)) {
        for (const optKey of Object.keys(overrides)) {
          if (!optionKeys.has(optKey)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['presets', presetKey, optKey],
              message: `preset '${presetKey}' overrides '${optKey}', which is not a declared option`,
            });
          }
        }
      }
    }
  });

export type Descriptor = z.infer<typeof DescriptorSchema>;
