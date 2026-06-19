// Catalogs of supported language toolchains and backing services for
// the yml profile. Curated whitelists keep the surface small and
// reviewable; unknown values are rejected up front rather than passed
// through to devcontainer / compose.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ServiceHealthcheck, ServiceObject } from '../config/schema.js';
import type { ResolvedService } from './types.js';
import { loadDescriptorCatalogSync } from '../catalog/load-sync.js';
import type { CatalogComponent } from '../catalog/load.js';

// Monoceros runtime image — thin layer on top of Microsoft's
// typescript-node base (see images/runtime/Dockerfile). The default
// points at the floating major tag on GHCR, so an `apply` from a
// fresh install pulls a published image without further setup.
//
// Contributors who are iterating on the runtime image itself
// (`pnpm image:build` → `monoceros-runtime:dev`) can override this
// via the `MONOCEROS_BASE_IMAGE_OVERRIDE` env var to point at their
// local tag without editing source. Empty or whitespace-only values
// are ignored so an accidentally-set-blank var doesn't break apply.
const DEFAULT_BASE_IMAGE = 'ghcr.io/getmonoceros/monoceros-runtime:1';
const override = process.env.MONOCEROS_BASE_IMAGE_OVERRIDE?.trim();
export const BASE_IMAGE =
  override && override.length > 0 ? override : DEFAULT_BASE_IMAGE;

// Registry repo for the Monoceros runtime image. The yml pins only a
// version (ADR 0017); the repo is a CLI constant.
const RUNTIME_IMAGE_REPO = 'ghcr.io/getmonoceros/monoceros-runtime';

// The runtime version a fresh `monoceros init` pins. SINGLE source of
// truth: `images/runtime/VERSION` (the same file release-runtime.yml
// publishes from). tsup substitutes the literal at build time (see
// tsup.config.ts → `__DEFAULT_RUNTIME_VERSION__`); in dev/test (tsx, no
// substitution) we read the file from the repo. So a runtime-image bump
// is a ONE-LINE change in `images/runtime/VERSION` — this is never
// hand-edited, and `init`'s pin can't drift from the published image.
declare const __DEFAULT_RUNTIME_VERSION__: string;
export const DEFAULT_RUNTIME_VERSION: string =
  typeof __DEFAULT_RUNTIME_VERSION__ === 'string'
    ? __DEFAULT_RUNTIME_VERSION__
    : readFileSync(
        fileURLToPath(
          new URL('../../../../images/runtime/VERSION', import.meta.url),
        ),
        'utf8',
      ).trim();

// Minimum runtime version that ships the node-owned `~/.vscode-server`
// dirs the IDE-state volumes need (ADR 0015). Below this, the scaffold
// must not emit those volume mounts or the container breaks on start.
// Unlike DEFAULT_RUNTIME_VERSION this is a deliberate, hand-set
// per-feature gate: it's the version the capability was INTRODUCED in
// and stays frozen there even as the image moves on. A future
// image-gated feature gets its own MIN_RUNTIME_FOR_<feature>.
const MIN_RUNTIME_FOR_IDE_VOLUMES = '1.1.0';

// Minimum runtime version that ships sshd + socat for the universal IDE
// attach point (ADR 0022). Below this the image has no sshd, so the
// host-side SSH config would point at a dead port - apply skips the
// whole SSH setup. Frozen at the version the capability was INTRODUCED
// in, like MIN_RUNTIME_FOR_IDE_VOLUMES above.
const MIN_RUNTIME_FOR_SSH_ATTACH = '1.2.0';

/**
 * Resolve a pinned `runtimeVersion` to a concrete image ref.
 * `MONOCEROS_BASE_IMAGE_OVERRIDE` (dev) always wins. With no pin we fall
 * back to the legacy floating major tag (pre-0017 behavior) so an
 * unpinned yml still yields a usable — if non-reproducible — image;
 * `apply` is what rejects an unpinned yml. See ADR 0017.
 */
export function resolveRuntimeImage(version?: string): string {
  const ov = process.env.MONOCEROS_BASE_IMAGE_OVERRIDE?.trim();
  if (ov && ov.length > 0) return ov;
  if (!version) return `${RUNTIME_IMAGE_REPO}:1`;
  return `${RUNTIME_IMAGE_REPO}:${version}`;
}

/** Compare two exact `major.minor.patch` versions: -1 | 0 | 1. */
export function compareRuntimeVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Whether the pinned runtime supports the ADR-0015 IDE-state volumes.
 * False when unpinned (legacy) or below the minimum — those containers
 * get no IDE volume mounts, so they never break on an image lacking the
 * node-owned `~/.vscode-server` dirs.
 */
export function runtimeSupportsIdeVolumes(version?: string): boolean {
  if (!version) return false;
  return compareRuntimeVersions(version, MIN_RUNTIME_FOR_IDE_VOLUMES) >= 0;
}

/**
 * Whether the pinned runtime ships sshd + socat for the ADR-0022 IDE
 * attach point. False when unpinned or below the minimum - those
 * containers get no host-side SSH config (the image has no sshd).
 */
export function runtimeSupportsSshAttach(version?: string): boolean {
  if (!version) return false;
  return compareRuntimeVersions(version, MIN_RUNTIME_FOR_SSH_ATTACH) >= 0;
}

export interface LanguageEntry {
  id: string;
  feature: string;
  /**
   * Feature options always applied for this language, on top of which
   * the optional `version` from the spec is layered. Lets a language
   * ship sensible defaults its upstream feature leaves off — e.g. the
   * `java` feature installs only a JDK by default, so we turn on
   * Maven + Gradle here so a plain `languages: [java]` is build-ready.
   */
  defaultOptions?: Readonly<Record<string, unknown>>;
  /**
   * The subset of options the builder should SEE in the yml (descriptor
   * `surface: yml`). `init` renders these as the language's object form
   * (e.g. java's `installMaven` / `installGradle`); editing them in the yml
   * overrides the default at apply time. A superset-or-equal of these always
   * applies via `defaultOptions` regardless of what the yml shows.
   */
  ymlOptions?: Readonly<Record<string, string | number | boolean>>;
  /**
   * Version rendered inline in the yml (`name:<defaultVersion>`) so the
   * builder sees where to edit it. For a builtin language this is the
   * base-image version: pinning exactly it stays builtin (no feature install
   * — see `resolveFeatures`); a different version triggers the feature.
   */
  defaultVersion?: string;
  /**
   * VS Code extensions to recommend in the `.code-workspace` when this
   * language is present (ADR 0016). See descriptor.ts for the cross-editor
   * (VS Code / Codium) list-both rationale.
   */
  vscodeExtensions?: readonly string[];
}

// ─── Descriptor-derived catalogs (ADR 0020) ──────────────────────
// LANGUAGE_CATALOG / SERVICE_CATALOG / BUILTIN_LANGUAGES are no longer
// hand-written literals: they are a typed projection of the unified
// component descriptors under `components/`, loaded synchronously at import
// so these eager const exports keep their original shape and every existing
// consumer keeps working unchanged. The descriptor is the single source of
// truth (see ADR 0020); these records derive from it.
const DESCRIPTORS = loadDescriptorCatalogSync();

/** Plain `{ key: defaultValue }` for the options that declare a default. */
function descriptorOptionDefaults(
  options: Record<string, { default?: string | boolean | number }>,
): Record<string, string | boolean | number> {
  const out: Record<string, string | boolean | number> = {};
  for (const [key, spec] of Object.entries(options)) {
    if (spec.default !== undefined) out[key] = spec.default;
  }
  return out;
}

/** Option defaults the descriptor marks `surface: yml` (shown in the yml). */
function descriptorYmlOptionDefaults(
  options: Record<
    string,
    { default?: string | boolean | number; surface?: string }
  >,
): Record<string, string | boolean | number> {
  const out: Record<string, string | boolean | number> = {};
  for (const [key, spec] of Object.entries(options)) {
    if (spec.surface === 'yml' && spec.default !== undefined) {
      out[key] = spec.default;
    }
  }
  return out;
}

/** CLI/yml selector for a component (its `name`, defaulting to `id`). */
function descriptorSelector(c: CatalogComponent): string {
  return c.descriptor.name ?? c.descriptor.id;
}

// `node` is in the base runtime image (descriptor `language.builtin: true`),
// so the bare entry `languages: [node]` installs nothing extra. Versioned
// node — `node:20` — bypasses the builtin set and goes through the upstream
// feature, because the base image's node version isn't otherwise selectable.
export const BUILTIN_LANGUAGES = new Set<string>(
  [...DESCRIPTORS.values()]
    .filter((c) => c.category === 'language' && c.descriptor.language?.builtin)
    .map(descriptorSelector),
);

export const LANGUAGE_CATALOG: Readonly<Record<string, LanguageEntry>> =
  Object.fromEntries(
    [...DESCRIPTORS.values()]
      .filter((c) => c.category === 'language')
      .map((c) => {
        const key = descriptorSelector(c);
        const defaults = descriptorOptionDefaults(c.descriptor.options);
        const ymlOptions = descriptorYmlOptionDefaults(c.descriptor.options);
        const entry: LanguageEntry = {
          id: key,
          feature: c.descriptor.language!.feature,
          ...(Object.keys(defaults).length > 0
            ? { defaultOptions: defaults }
            : {}),
          ...(Object.keys(ymlOptions).length > 0 ? { ymlOptions } : {}),
          ...(c.descriptor.language!.defaultVersion !== undefined
            ? { defaultVersion: c.descriptor.language!.defaultVersion }
            : {}),
          ...(c.descriptor.language!.vscodeExtensions
            ? { vscodeExtensions: c.descriptor.language!.vscodeExtensions }
            : {}),
        };
        return [key, entry];
      }),
  );

/**
 * Language entries in a container yml may carry an optional
 * version suffix: `java:17`, `node:20`. The suffix is anything
 * the upstream devcontainer feature accepts as its `version`
 * option (typically `latest`, a major like `17`, or an exact
 * semver like `3.12.1`).
 */
export const LANGUAGE_SPEC_RE = /^([a-z][a-z0-9-]*)(?::([A-Za-z0-9._-]+))?$/;

export interface LanguageSpec {
  name: string;
  version?: string;
}

/**
 * Split a yml language entry into name + optional version. Returns
 * `null` when the input is not a valid language spec. Callers use
 * that null to surface a schema error.
 */
export function parseLanguageSpec(spec: string): LanguageSpec | null {
  const m = LANGUAGE_SPEC_RE.exec(spec);
  if (!m) return null;
  return { name: m[1]!, ...(m[2] !== undefined ? { version: m[2] } : {}) };
}

export interface ServiceEntry {
  id: string;
  image: string;
  /**
   * Literal dev-default values for the service's env vars. These are
   * rendered as `${KEY}` *placeholders* into the yml (expandCuratedService)
   * and seeded as `KEY=<default>` into `<name>.env` (curatedServiceEnvDefaults),
   * so the yml is shareable without baking credentials in while the
   * connection string stays predictable out of the box.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * Readiness probe. Curated services ship one so the workspace's
   * `depends_on` gates on `service_healthy` (actually accepting
   * connections) rather than just `service_started`. `${VAR}` in the
   * test resolves from `<name>.env` at apply time like any other field.
   */
  healthcheck?: ServiceHealthcheck;
  /**
   * Container-side mount target for the service's persistent data.
   * Monoceros bind-mounts this onto `<container-dir>/data/<id>/` on
   * the host so DB content is visible in the host filesystem
   * (browsable, backupable, removable with the usual tools instead
   * of `docker volume ...`). See ADR 0003 for the per-container
   * state-model the data dir slots into.
   */
  dataMount?: string;
  /**
   * Compose `user:` for the service container (e.g. `"0:0"`). Set for
   * images that run as a fixed non-root uid but must write a host
   * bind-mounted `dataMount` — without it they can't write the
   * apply-created data dir on native Linux and exit. See descriptor.ts.
   */
  user?: string;
  /**
   * Default in-container port the service listens on. Used by
   * `monoceros tunnel <name> <service>` to resolve the service-name
   * to a port without an extra CLI argument. See ADR 0009.
   */
  defaultPort: number;
  /**
   * VS Code extensions to *recommend* (not auto-install) when this
   * service is present. Written to `extensions.recommendations` in the
   * generated `.code-workspace`. Unlike feature-bound extensions (which
   * auto-install via the feature manifest), these are soft, context-
   * derived suggestions the builder can dismiss. See ADR 0016.
   */
  vscodeExtensions?: readonly string[];
  /**
   * Workspace connection env, keyed by logical SUFFIX (`URL`/`HOST`/`PORT`/
   * `USER`/`PASSWORD`/`DB`) → template. Baked into the yml at expand and
   * emitted as `<UPPER(name)>_<SUFFIX>` per instance by `serviceConnectionEnv`
   * (ADR 0021). Tokens `${host}`/`${port}`/`${<OPTION>}` are filled there.
   */
  connectionEnv?: Readonly<Record<string, string>>;
  /**
   * CLI client tool(s) installed into the WORKSPACE when this service is
   * present (ADR 0020). `apt` packages merge into the workspace apt-packages
   * feature (build-time); `npm` packages are installed globally in post-create
   * (guarded). E.g. postgres → apt `postgresql-client`, mongodb → npm
   * `mongosh`.
   */
  client?: Readonly<{ apt?: readonly string[]; npm?: readonly string[] }>;
  /**
   * Compose `command:` baked into the expanded yml (visible + editable).
   * The process to run instead of the image's default CMD, e.g. Keycloak's
   * `start-dev --import-realm`. See descriptor.ts.
   */
  command?: string;
  /**
   * Example bind-mounts rendered as a COMMENTED `volumes:` scaffold in the
   * generated yml (not active volumes). For services that need a project
   * file the catalog can't path-resolve, e.g. Keycloak's realm.json.
   * See descriptor.ts.
   */
  exampleVolumes?: readonly string[];
  /**
   * Start this service in a host-side SECOND WAVE, after `devcontainer up`
   * (and the in-container clone) has finished, rather than together with
   * the workspace. For services that bind-mount a file from a cloned repo
   * (Keycloak realm.json, …). Hidden / descriptor-only: not a yml field,
   * resolved here by name via `serviceDefersStart`. See ADR 0025.
   */
  deferStart?: boolean;
}

// The `monoceros` user/password/db below are deliberate dev-only
// defaults, not secrets. A curated service renders its env as `${KEY}`
// placeholders into the yml and seeds these literals into the gitignored
// `<name>.env`, so the yml stays shareable while the connection string
// is predictable out of the box — any builder running this workbench
// knows it at a glance:
//
//   postgresql://monoceros:monoceros@postgres:5432/monoceros
//   mysql://monoceros:monoceros@mysql:3306/monoceros
//
// To use a real password, change the value in `<name>.env` (it never
// leaves the host, never rides along when the yml is shared). Because
// the default isn't a secret, the secret-masking layer
// (util/mask-secrets.ts) doesn't and shouldn't mask it.
export const SERVICE_CATALOG: Readonly<Record<string, ServiceEntry>> =
  Object.fromEntries(
    [...DESCRIPTORS.values()]
      .filter((c) => c.category === 'service')
      .map((c) => {
        const key = descriptorSelector(c);
        const svc = c.descriptor.service!;
        if (svc.defaultPort === undefined) {
          throw new Error(
            `Service descriptor '${key}' is missing service.defaultPort.`,
          );
        }
        // env defaults are modeled as the service's surface:env options.
        const env = descriptorOptionDefaults(c.descriptor.options) as Record<
          string,
          string
        >;
        const entry: ServiceEntry = {
          id: key,
          image: svc.image,
          ...(Object.keys(env).length > 0 ? { env } : {}),
          ...(svc.healthcheck
            ? { healthcheck: svc.healthcheck as ServiceHealthcheck }
            : {}),
          ...(svc.dataMount ? { dataMount: svc.dataMount } : {}),
          ...(svc.user ? { user: svc.user } : {}),
          defaultPort: svc.defaultPort,
          ...(svc.vscodeExtensions
            ? { vscodeExtensions: svc.vscodeExtensions }
            : {}),
          ...(svc.connectionEnv ? { connectionEnv: svc.connectionEnv } : {}),
          ...(svc.client ? { client: svc.client } : {}),
          ...(svc.command ? { command: svc.command } : {}),
          ...(svc.exampleVolumes ? { exampleVolumes: svc.exampleVolumes } : {}),
          ...(svc.deferStart ? { deferStart: true } : {}),
        };
        return [key, entry];
      }),
  );

export function knownLanguages(): string[] {
  return [...BUILTIN_LANGUAGES, ...Object.keys(LANGUAGE_CATALOG)].sort();
}

export function knownServices(): string[] {
  return Object.keys(SERVICE_CATALOG).sort();
}

/**
 * Compose profile assigned to deferred services so `devcontainer up`'s
 * profile-less `docker compose up -d` does NOT start them (a profiled
 * service is skipped unless its profile is active). The second wave brings
 * them up with `--profile <this>`. This is the mechanism that actually
 * holds back the first-wave start — `runServices` does not, because
 * devcontainer-cli's compose `up` ignores it for which services boot.
 * See ADR 0025.
 */
export const DEFERRED_SERVICE_PROFILE = 'monoceros-deferred';

/**
 * Whether a service starts in the host-side second wave (after the
 * in-container clone) rather than together with the workspace. Resolved
 * by catalog name — `deferStart` is a hidden, descriptor-only attribute,
 * so a renamed instance (yml `name` ≠ catalog id) is treated as
 * non-deferred. See ADR 0025.
 */
export function serviceDefersStart(name: string): boolean {
  return SERVICE_CATALOG[name]?.deferStart === true;
}

/**
 * Example bind-mounts for a curated service, rendered as a commented
 * `volumes:` scaffold in the generated yml (see init/service-doc.ts).
 * Empty for services without any. Looked up by catalog name.
 */
export function curatedServiceExampleVolumes(name: string): readonly string[] {
  return SERVICE_CATALOG[name]?.exampleVolumes ?? [];
}

/**
 * Normalize a `services:` object to a `ResolvedService` — fills the two
 * fields the scaffold treats as always-present (env, volumes) with their
 * empty defaults. `${VAR}` references in env/command pass through
 * untouched; they're resolved against `<name>.env` at apply time
 * (config/env-file.ts).
 */
export function resolveService(entry: ServiceObject): ResolvedService {
  return {
    name: entry.name,
    image: entry.image,
    ...(entry.port !== undefined ? { port: entry.port } : {}),
    env: entry.env ? { ...entry.env } : {},
    volumes: entry.volumes ? [...entry.volumes] : [],
    ...(entry.user ? { user: entry.user } : {}),
    ...(entry.healthcheck ? { healthcheck: entry.healthcheck } : {}),
    ...(entry.restart ? { restart: entry.restart } : {}),
    ...(entry.command ? { command: entry.command } : {}),
    ...(entry.connectionEnv
      ? { connectionEnv: { ...entry.connectionEnv } }
      : {}),
  };
}

/** Whether `name` is a known curated catalog service. */
export function isCuratedService(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(SERVICE_CATALOG, name);
}

/**
 * Expand a curated catalog name into a full `ServiceObject` — the
 * init-sugar form written into the yml so the builder sees (and can
 * edit) every field. Env values render as `${KEY}` placeholders (their
 * literal defaults are seeded into `<name>.env` via
 * `curatedServiceEnvDefaults`), so the yml is shareable without baking
 * credentials in. Throws if `name` isn't curated.
 */
export function expandCuratedService(name: string): ServiceObject {
  const def = SERVICE_CATALOG[name];
  if (!def) {
    throw new Error(
      `Unknown service '${name}'. Known catalog services: ${knownServices().join(', ')}.`,
    );
  }
  return {
    name: def.id,
    image: def.image,
    port: def.defaultPort,
    ...(def.env
      ? {
          env: Object.fromEntries(
            Object.keys(def.env).map((k) => [k, `\${${k}}`]),
          ),
        }
      : {}),
    ...(def.dataMount ? { volumes: [`data:${def.dataMount}`] } : {}),
    ...(def.user ? { user: def.user } : {}),
    ...(def.command ? { command: def.command } : {}),
    ...(def.healthcheck ? { healthcheck: def.healthcheck } : {}),
    // Bake the connection-env templates into the yml (suffix → template) so
    // they travel with the service: a renamed/duplicated instance keeps them,
    // and `serviceConnectionEnv` prefixes by the instance's current name.
    ...(def.connectionEnv ? { connectionEnv: { ...def.connectionEnv } } : {}),
    restart: 'unless-stopped',
  };
}

/**
 * The literal `KEY=<default>` values to seed into `<name>.env` for a
 * curated service's `${KEY}` env placeholders — the same dev-defaults
 * the catalog declares. Empty for services without env (redis).
 * `init` and `add-service` upsert these so the builder gets a working
 * container without filling anything, yet can change a value (e.g. a
 * real password) in one gitignored place. Returns `{}` for non-curated
 * names.
 */
export function curatedServiceEnvDefaults(
  name: string,
): Record<string, string> {
  const def = SERVICE_CATALOG[name];
  return def?.env ? { ...def.env } : {};
}

/**
 * Connection environment variables injected into the WORKSPACE container,
 * **per service instance** (ADR 0021). Each service that carries a
 * `connectionEnv` (suffix → template) emits `<UPPER(name)>_<SUFFIX>` —
 * e.g. a service named `postgres` → `POSTGRES_URL`, `POSTGRES_HOST`, …; a
 * second one named `analytics` → `ANALYTICS_URL`, … Because service names are
 * unique, the var names are unique by construction, so any number of databases
 * (same or different engine) coexist with no collision and one code path.
 *
 * Tokens in each template are filled here: `${host}` = the service's CURRENT
 * name (rename-safe), `${port}` = svc.port, `${<OPTION>}` = the service's
 * already-resolved env value. The templates are read from the service itself
 * (baked into the yml at expand), not looked up by catalog name, so renamed
 * and custom instances work too.
 *
 * Monoceros deliberately does NOT inject bare `DATABASE_URL` / `PGHOST` etc.:
 * those are project/framework concerns. A tool that wants `DATABASE_URL` reads
 * `<NAME>_URL` (the briefing says so) or maps it in the project's `.env`.
 */
export function serviceConnectionEnv(
  services: readonly ResolvedService[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const svc of services) {
    // The templates on the service win: `expand`/`add-service` serialise a
    // `connectionEnv` block into the yml (renderServiceObjectBody), so they
    // travel with the instance and a renamed/duplicated curated service
    // resolves here by its own name. The catalog-by-name lookup is only a
    // fallback for a hand-written curated entry that omits the block (and
    // happens to keep the catalog name).
    const conn = svc.connectionEnv ?? SERVICE_CATALOG[svc.name]?.connectionEnv;
    if (!conn || Object.keys(conn).length === 0) continue;
    const prefix = svc.name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
    const host = svc.name;
    const port = svc.port !== undefined ? String(svc.port) : '';
    const fill = (template: string): string =>
      template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, token: string) => {
        if (token === 'host') return host;
        if (token === 'port') return port;
        return svc.env[token] ?? '';
      });
    for (const [suffix, template] of Object.entries(conn)) {
      env[`${prefix}_${suffix}`] = fill(template);
    }
  }
  return env;
}

/**
 * APT packages for the CLI client tools of the curated services present in the
 * container (ADR 0020), e.g. a `postgres` service contributes
 * `postgresql-client` so `psql` is available in the workspace. Looked up by
 * catalog name (a renamed instance doesn't auto-contribute — add the package
 * via `aptPackages` if needed). Deduped + sorted; merged into the workspace's
 * apt-packages feature at scaffold time.
 */
export function serviceClientAptPackages(
  services: readonly ResolvedService[],
): string[] {
  const pkgs = new Set<string>();
  for (const svc of services) {
    for (const pkg of SERVICE_CATALOG[svc.name]?.client?.apt ?? []) {
      pkgs.add(pkg);
    }
  }
  return [...pkgs].sort();
}

/**
 * Global npm packages for the CLI client tools of the curated services present
 * (ADR 0020), e.g. a `mongodb` service contributes `mongosh`. Installed in
 * post-create (guarded, so already-present packages are skipped). Looked up by
 * catalog name (renamed instances don't auto-contribute). Deduped + sorted.
 */
export function serviceClientNpmPackages(
  services: readonly ResolvedService[],
): string[] {
  const pkgs = new Set<string>();
  for (const svc of services) {
    for (const pkg of SERVICE_CATALOG[svc.name]?.client?.npm ?? []) {
      pkgs.add(pkg);
    }
  }
  return [...pkgs].sort();
}

/**
 * Derive a compose service name from an image ref. Takes the last
 * path segment, strips the tag/digest, lowercases and sanitises:
 *   rustfs/rustfs:latest  → rustfs
 *   postgres:16-alpine    → postgres
 *   ghcr.io/foo/bar:1     → bar
 *   ghcr.io:5000/x/app    → app
 */
export function deriveServiceName(image: string): string {
  const lastSegment = image.split('/').pop() ?? image;
  const noTag = lastSegment.split('@')[0]!.split(':')[0]!;
  return noTag.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}
