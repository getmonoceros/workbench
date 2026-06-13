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
          defaultPort: svc.defaultPort,
          ...(svc.vscodeExtensions
            ? { vscodeExtensions: svc.vscodeExtensions }
            : {}),
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
    ...(entry.healthcheck ? { healthcheck: entry.healthcheck } : {}),
    ...(entry.restart ? { restart: entry.restart } : {}),
    ...(entry.command ? { command: entry.command } : {}),
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
    ...(def.healthcheck ? { healthcheck: def.healthcheck } : {}),
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
 * Connection environment variables to inject into the WORKSPACE container
 * for curated services, derived from their (already `${VAR}`-resolved)
 * env + service name + port. Lets the app and the in-container AI agent
 * connect without anyone knowing or hardcoding the dev-default credentials
 * — they read `DATABASE_URL` / `REDIS_URL` (and the engine-specific `PG*` /
 * `MYSQL_*`) instead. These are dev-only defaults inside the isolated
 * container, not secrets. Custom-image services are skipped (Monoceros
 * doesn't know their connection shape). `DATABASE_URL` points at the first
 * SQL database found (postgres wins over mysql when both are present).
 */
export function serviceConnectionEnv(
  services: readonly ResolvedService[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const svc of services) {
    if (!isCuratedService(svc.name)) continue;
    const host = svc.name;
    if (svc.name === 'postgres') {
      const user = svc.env.POSTGRES_USER ?? 'postgres';
      const pass = svc.env.POSTGRES_PASSWORD ?? '';
      const db = svc.env.POSTGRES_DB ?? user;
      const port = svc.port ?? 5432;
      env.PGHOST = host;
      env.PGPORT = String(port);
      env.PGUSER = user;
      env.PGPASSWORD = pass;
      env.PGDATABASE = db;
      // Postgres always wins DATABASE_URL (overrides a mysql one set earlier).
      env.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${port}/${db}`;
    } else if (svc.name === 'mysql') {
      const pass = svc.env.MYSQL_ROOT_PASSWORD ?? '';
      const db = svc.env.MYSQL_DATABASE ?? '';
      const port = svc.port ?? 3306;
      env.MYSQL_HOST = host;
      env.MYSQL_PORT = String(port);
      env.MYSQL_USER = 'root';
      env.MYSQL_PASSWORD = pass;
      env.MYSQL_DATABASE = db;
      // Only the fallback when there's no postgres.
      if (env.DATABASE_URL === undefined) {
        env.DATABASE_URL = `mysql://root:${pass}@${host}:${port}/${db}`;
      }
    } else if (svc.name === 'redis') {
      const port = svc.port ?? 6379;
      env.REDIS_URL = `redis://${host}:${port}`;
    }
  }
  return env;
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
