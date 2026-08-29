import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import {
  McpTransportSchema,
  REGEX,
  validateMcpTransportFields,
} from '../config/schema.js';

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

export const CategorySchema = z.enum([
  'language',
  'service',
  'feature',
  'mcp-server',
]);
export type DescriptorCategory = z.infer<typeof CategorySchema>;

/**
 * Descriptor field holding each category's own block. Identical to the category
 * name except for `mcp-server`, whose field stays camelCase like every other
 * descriptor field.
 */
const BLOCK_KEY: Readonly<Record<DescriptorCategory, string>> = {
  language: 'language',
  service: 'service',
  feature: 'feature',
  'mcp-server': 'mcpServer',
};

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

/**
 * `deploy:` is this service's block for the project's pipeline compose
 * file, verbatim: the whole service body including `image:`, only the
 * `<name>:` key on top is added when it is rendered into
 * `.monoceros/deploy.md`. Service-only.
 *
 * Compose rather than prose so it can be parsed, validated and started in
 * a test. `image:` must match `service.image` (checked below), so a bumped
 * tag cannot go stale here.
 */
export const DeployBlockSchema = z.object({
  /** Compose body for this service, without the `<name>:` key. */
  compose: z.string().min(1),
  /**
   * What this service needs BESIDE itself, as a compose fragment with
   * top-level keys (`services:`, `volumes:`), copied verbatim. E.g. Keycloak
   * must not share the application's database, so it brings its own postgres
   * plus that volume's declaration.
   *
   * Top-level keys and not a second service body, because a volume has to be
   * declared at the top level to exist at all, and because one service may
   * need several. Everything it contributes must be named after the component
   * (`keycloak-db`, `keycloak-db-data`, checked below), so it merges into the
   * project's compose file without colliding with another block's parts.
   */
  requires: z.string().min(1).optional(),
});
export type DeployBlock = z.infer<typeof DeployBlockSchema>;

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
  /**
   * VS Code extensions to *recommend* (not auto-install) when this language
   * is present, written to the `.code-workspace` `extensions.recommendations`
   * (ADR 0016). List every editor variant where editors diverge: VS Code and
   * VSCodium each resolve recommendation IDs against their own registry (MS
   * Marketplace / Open VSX) and silently skip what they can't find, so an
   * ID that only exists for one editor is simply ignored by the other. E.g.
   * `[ms-python.python, ms-python.vscode-pylance]` — Codium drops Pylance.
   */
  vscodeExtensions: z.array(z.string()).optional(),
  /**
   * Home-relative directories that survive a rebuild, bind-mounted per
   * container out of `container/<name>/home/` — the same mechanism features
   * use for their login state. For a language this is where a toolchain keeps
   * what the PROJECT installed (Go's `GOBIN`, later `~/.m2/settings.xml`-style
   * state): per container, because two workbenches may pin different versions
   * of the same tool and a shared directory holds only one file per name.
   */
  persistentHomePaths: z.array(z.string().min(1)).optional(),
  /**
   * Absolute in-container directories backed by a MACHINE-WIDE docker volume,
   * shared by every workbench that has this language. Only for content that is
   * identical across containers by construction: a compiler's content-addressed
   * caches (Go's build and module cache, later `~/.m2/repository`, Cargo's
   * registry). Downloaded and compiled once, not per workbench, and not lost on
   * `apply`. Never use it for anything a project's own version pin can differ
   * on — that belongs in `persistentHomePaths`.
   */
  sharedCachePaths: z.array(z.string().min(1)).optional(),
  /**
   * Named runtime env injected into the workspace container (compose
   * `environment:` / image-mode `containerEnv`), the language-side sibling of
   * a feature's `workspaceEnv`. Plain literal values, no `${…}` templating:
   * they land in a compose file, where interpolation would resolve against the
   * HOST environment. Used to point a toolchain at the paths declared above.
   */
  workspaceEnv: z.record(z.string(), z.string()).optional(),
});
export type LanguageBlock = z.infer<typeof LanguageBlockSchema>;

/** `category: service` block — a backing container the workspace talks to. */
export const ServiceBlockSchema = z.object({
  image: z.string().min(1),
  defaultPort: z.number().int().positive().optional(),
  /**
   * The one HTTP port of this service that may leave the container: what
   * `monoceros share` offers on the LAN, and what the proxy writes a route
   * for. Absent means neither happens, which is the answer for every backing
   * store: Caddy speaks HTTP, so a database behind it would return garbage.
   *
   * A port and not a boolean, because `defaultPort` is the MACHINE port and
   * the two differ where it matters: mailpit's defaultPort is 1025 (SMTP)
   * while its web UI is 8025, rustfs's is 9000 (the S3 API) while the console
   * is 9001. A boolean falling back to defaultPort would expose SMTP and an
   * S3 API, the opposite of the intent.
   *
   * Unlike `deferStart` this is NOT descriptor-only: it is baked into the
   * expanded yml like `port` and `command`, so the builder sees it and can
   * remove the line to keep one workbench's service to itself.
   */
  httpPort: z.number().int().min(1).max(65535).optional(),
  /**
   * Compose `command:` for the service container — the process to run
   * instead of the image's default CMD. Baked into the expanded yml
   * (visible + editable, unlike `deferStart`). E.g. Keycloak needs
   * `start-dev --import-realm` because its image has no auto-start default.
   */
  command: z.string().optional(),
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
  /**
   * Example bind-mounts rendered as a COMMENTED `volumes:` scaffold in the
   * generated yml (init / add-service), for the builder to uncomment and
   * edit. NOT active volumes — the catalog can't know the builder's repo
   * path. Used by services that need a project file but can't auto-wire it
   * (e.g. Keycloak's realm.json / theme). Each entry is a compose volume
   * spec, e.g. `projects/<app>/keycloak/realm.json:/opt/keycloak/data/import/<app>.json:ro`.
   */
  exampleVolumes: z.array(z.string()).optional(),
  /**
   * Example env keys rendered as a COMMENTED `env:` scaffold in the generated
   * yml (init / add-service), next to `exampleVolumes` and for the same
   * reason: the keys exist, but only the builder's own config file says which
   * ones. Caddy is the case — a Caddyfile substitutes any `{$VAR}` it likes,
   * so the catalog cannot carry them as `options:` the way Keycloak's fixed
   * admin keys are carried. Each value is a `${VAR}` placeholder resolved
   * from `<name>.env` at apply; an unresolved one is a hard apply error.
   */
  exampleEnv: z.record(z.string(), z.string()).optional(),
  /**
   * Start this service in a SECOND WAVE, host-side, *after* `devcontainer
   * up` (and thus the in-container repo clone in post-create) has
   * finished — instead of together with the workspace at `compose up`.
   * For a service that bind-mounts a file from a cloned repo (e.g.
   * Keycloak's `realm.json`, a Postgres `init.sql`): the file does not
   * exist at the normal parallel start, but is on disk by the time the
   * second wave runs. See ADR 0025.
   *
   * Deliberately a HIDDEN, descriptor-only field: it is NOT exposed in the
   * user-facing yml schema and not baked into the expanded service object.
   * The start paths resolve it by catalog lookup on the service name
   * (`serviceDefersStart`). Caveat: a deferred service is NOT reachable
   * during the workspace's post-create.
   */
  deferStart: z.boolean().optional(),
  /**
   * Executables this service contributes to the workspace, copied at apply
   * into `<container>/.monoceros/bin/`. Each entry is a plain file name in
   * the component's own `tools/` directory (no path separators). Only
   * shipped when the service is configured — a container without keycloak
   * has no keycloak tool.
   *
   * For the operations a service needs that a compose file cannot express.
   * E.g. Keycloak's boot import only fills an empty database, so applying a
   * changed realm file to the RUNNING server needs an admin-API call:
   * `tools/keycloak-realm` does exactly that. Write them against what the
   * runtime image guarantees (bash, curl, jq) so they need no language
   * runtime, and let them read the service's connection env instead of
   * taking a URL, so they cannot be aimed at anything but this container.
   */
  tools: z
    .array(
      z
        .string()
        .min(1)
        .refine((name) => !name.includes('/') && !name.includes('\\'), {
          message: 'must be a plain file name inside the component tools/ dir',
        }),
    )
    .optional(),
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
/**
 * The example marketplace a plugin-hosting feature ships for its commented
 * `plugins:` scaffold. Same fields as the yml's plugin entry, minus the ones
 * an example never needs: it is written out verbatim, so keep it neutral.
 */
const ExamplePluginSchema = z.object({
  url: z.string().min(1),
  enable: z.array(z.string().min(1)).min(1),
});

export const FeatureBlockSchema = z.object({
  /** Publishable feature version (devcontainer-feature.json `version`). */
  version: z.string().min(1),
  /**
   * devcontainer `installsAfter`: features this one must not run before. Only
   * has an effect when the other feature is in the same container, so it is a
   * hint and never a requirement.
   *
   * Every feature that installs a global npm package needs
   * `ghcr.io/devcontainers/features/node` here. Without it the install runs
   * against the Node baked into the runtime image while the yml pins another
   * one, and npm resolves the version for a Node that is about to be replaced:
   * a workbench on `node:26` got `@forge/cli` 13.0.0, the newest release that
   * the base image's 22.23.1 satisfies, and then ran it on 26.
   */
  installsAfter: z.array(z.string().min(1)).optional(),
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
  /**
   * The in-container CLI that manages this agent's plugins (`claude`). Its
   * presence is what makes a `plugins:` block on the yml entry meaningful:
   * apply rejects `plugins:` on a feature without it, rather than installing
   * nothing and staying quiet about it. One field rather than a flag plus a
   * command, because the two can never disagree.
   */
  pluginCli: z.string().min(1).optional(),
  /**
   * One example plugin marketplace, rendered as a COMMENTED `plugins:` block
   * in the generated yml (init / add-feature) for the builder to uncomment
   * and edit. Same idea as a service's `exampleVolumes`: the catalog cannot
   * know which plugins a builder wants, but it can show the shape in the
   * file instead of making them look it up.
   */
  examplePlugin: ExamplePluginSchema.optional(),
});
export type FeatureBlock = z.infer<typeof FeatureBlockSchema>;

/**
 * `category: mcp-server` block — one MCP server an agent in the container can
 * reach. This is the whole definition, in ONE canonical shape; apply
 * translates it into the config format of each agent that is actually
 * present (ADR 0045). Nothing is installed: a connector contributes a
 * registration, not a devcontainer feature, which is why it needs no OCI
 * ref and no GHCR publish.
 *
 * String fields take `${optionName}` tokens, filled at apply from the
 * component's resolved options — the same convention a feature's
 * `workspaceEnv` uses, so a credential stays an `env`-surfaced option and
 * never a literal in a descriptor.
 */
export const McpBlockSchema = z
  .object({
    transport: McpTransportSchema,
    /** `stdio`: the executable to run in the container (e.g. `npx`). */
    command: z.string().min(1).optional(),
    /** `stdio`: argv after `command`. */
    args: z.array(z.string()).optional(),
    /** `stdio`: env for the server process. */
    env: z.record(z.string(), z.string()).optional(),
    /** `http` / `sse`: the endpoint. */
    url: z.string().min(1).optional(),
    /** `http` / `sse`: request headers, where a bearer token goes. */
    headers: z.record(z.string(), z.string()).optional(),
    /**
     * `oauth`: the server authenticates interactively. There is no credential
     * to put in the env file; the builder signs in once inside the container
     * and the agent keeps the grant. Two things follow from the marker: the
     * yml header says so instead of leaving a credential-less entry
     * unexplained, and a `${option}` that resolves empty drops its header or
     * env key rather than failing the apply — which is what lets a connector
     * offer a token as the alternative route to the same server.
     */
    auth: z.literal('oauth').optional(),
  })
  .superRefine((data, ctx) => {
    validateMcpTransportFields(data, ctx);
  });
export type McpBlock = z.infer<typeof McpBlockSchema>;

/** Pull the `${option}` tokens referenced by a set of templates. */
function optionTokens(templates: readonly string[]): string[] {
  const tokens: string[] = [];
  for (const template of templates) {
    for (const m of template.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)) {
      tokens.push(m[1]!);
    }
  }
  return tokens;
}

/** Every `${option}`-carrying template of an mcpServer block, with its path. */
function mcpTemplates(block: McpBlock): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  if (block.command !== undefined) {
    out.push({ path: 'command', value: block.command });
  }
  block.args?.forEach((arg, i) => out.push({ path: `args[${i}]`, value: arg }));
  for (const [key, value] of Object.entries(block.env ?? {})) {
    out.push({ path: `env.${key}`, value });
  }
  if (block.url !== undefined) out.push({ path: 'url', value: block.url });
  for (const [key, value] of Object.entries(block.headers ?? {})) {
    out.push({ path: `headers.${key}`, value });
  }
  return out;
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
    deploy: DeployBlockSchema.optional(),
    language: LanguageBlockSchema.optional(),
    service: ServiceBlockSchema.optional(),
    feature: FeatureBlockSchema.optional(),
    mcpServer: McpBlockSchema.optional(),
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
        data.mcpServer ? 'mcp-server' : null,
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
        message: `exactly one of language/service/feature/mcpServer is allowed, got: ${present.join(', ')}`,
      });
    } else if (present[0] !== data.category) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `category '${data.category}' requires a '${BLOCK_KEY[data.category]}' block, found '${BLOCK_KEY[present[0]!]}'`,
      });
    }

    // `deploy:` describes a compose service, so it only makes sense on a
    // service, and its `image:` must be the one this service runs.
    if (data.deploy) {
      if (data.category !== 'service') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deploy'],
          message: `deploy is only allowed on services, not '${data.category}'`,
        });
      }
      const image = /^\s*image:\s*(\S+)\s*$/m.exec(data.deploy.compose)?.[1];
      if (data.service && image !== data.service.image) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deploy', 'compose'],
          message:
            `deploy.compose image '${image ?? '(missing)'}' must match ` +
            `service.image '${data.service.image}'`,
        });
      }
      // A `${VAR:-fallback}` would put a dev value in a deployment file, so
      // a forgotten variable would start a reachable service on credentials
      // from this repo instead of failing. Values come from the pipeline.
      for (const [field, text] of [
        ['compose', data.deploy.compose],
        ...(data.deploy.requires
          ? ([['requires', data.deploy.requires]] as const)
          : []),
      ] as const) {
        const fallback = /\$\{[A-Za-z_][A-Za-z0-9_]*:-/.exec(text);
        if (fallback) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['deploy', field],
            message:
              `deploy.${field} must not default a variable (${fallback[0]}…): ` +
              'use `${VAR:?why it is needed}`',
          });
        }
      }
      if (data.deploy.requires !== undefined) {
        validateDeployRequires(data.deploy.requires, data.id, ctx);
      }
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
      for (const token of optionTokens(Object.values(block.vars))) {
        if (!optionKeys.has(token)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['feature', 'workspaceEnv', i, 'vars'],
            message: `workspaceEnv template references '\${${token}}', which is not a declared option`,
          });
        }
      }
    });

    // Same rule for an mcpServer block's templates: an unknown `${token}` would
    // render empty, which for a header or an env var means the server is
    // registered and silently unauthenticated.
    if (data.mcpServer) {
      for (const { path: field, value } of mcpTemplates(data.mcpServer)) {
        for (const token of optionTokens([value])) {
          if (!optionKeys.has(token)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['mcpServer', field],
              message: `mcpServer template references '\${${token}}', which is not a declared option`,
            });
          }
        }
      }
    }

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

/**
 * A `deploy.requires` fragment must parse as compose and everything it
 * contributes must be named after the component, so two blocks in one file
 * cannot collide on a service or volume name.
 */
function validateDeployRequires(
  requires: string,
  id: string,
  ctx: z.RefinementCtx,
): void {
  let doc: unknown;
  try {
    doc = parseYaml(requires);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deploy', 'requires'],
      message: `deploy.requires is not valid YAML: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return;
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deploy', 'requires'],
      message:
        'deploy.requires must be a compose fragment with top-level keys ' +
        '(`services:`, `volumes:`)',
    });
    return;
  }
  const fragment = doc as Record<string, unknown>;
  for (const section of ['services', 'volumes'] as const) {
    const block = fragment[section];
    if (block === undefined || block === null) continue;
    if (typeof block !== 'object' || Array.isArray(block)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deploy', 'requires'],
        message: `deploy.requires ${section} must be a mapping`,
      });
      continue;
    }
    for (const name of Object.keys(block as Record<string, unknown>)) {
      if (name !== id && !name.startsWith(`${id}-`)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deploy', 'requires'],
          message:
            `deploy.requires ${section} '${name}' must be named after the ` +
            `component ('${id}' or '${id}-…'), so two blocks cannot collide`,
        });
      }
    }
  }
}
