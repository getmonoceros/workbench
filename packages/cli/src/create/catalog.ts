// Catalogs of supported language toolchains and backing services for
// the yml profile. Curated whitelists keep the surface small and
// reviewable; unknown values are rejected up front rather than passed
// through to devcontainer / compose.

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

export interface LanguageEntry {
  id: string;
  feature: string;
}

// `node` is included in the base runtime image, so the bare entry
// `languages: [node]` is accepted as input but installs nothing
// extra. Versioned node — `node:20` — bypasses the builtin set and
// goes through the upstream feature like the other languages,
// because the base image's node version (22) isn't selectable
// otherwise.
export const BUILTIN_LANGUAGES = new Set(['node']);

export const LANGUAGE_CATALOG: Readonly<Record<string, LanguageEntry>> = {
  node: { id: 'node', feature: 'ghcr.io/devcontainers/features/node:1' },
  python: { id: 'python', feature: 'ghcr.io/devcontainers/features/python:1' },
  java: { id: 'java', feature: 'ghcr.io/devcontainers/features/java:1' },
  go: { id: 'go', feature: 'ghcr.io/devcontainers/features/go:1' },
  rust: { id: 'rust', feature: 'ghcr.io/devcontainers/features/rust:1' },
  dotnet: { id: 'dotnet', feature: 'ghcr.io/devcontainers/features/dotnet:2' },
};

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
  env?: Readonly<Record<string, string>>;
  /**
   * Container-side mount target for the service's persistent data.
   * Monoceros bind-mounts this onto `<container-dir>/data/<id>/` on
   * the host so DB content is visible in the host filesystem
   * (browsable, backupable, removable with the usual tools instead
   * of `docker volume ...`). See ADR 0003 for the per-container
   * state-model the data dir slots into.
   */
  dataMount?: string;
}

// The literal `monoceros` user/password/db on the service entries
// below is a deliberate dev-only convention, not a secret. The
// services are only reachable from inside the workspace container
// (no host port mapping), and the value is hardcoded into the
// catalog + docs so any builder running this workbench knows the
// connection string at a glance:
//
//   postgresql://monoceros:monoceros@postgres:5432/monoceros
//   mysql://monoceros:monoceros@mysql:3306/monoceros
//
// Because it isn't a secret, the secret-masking layer
// (util/mask-secrets.ts) doesn't and shouldn't mask it. Builders
// who want a real password should either:
//   - run their own DB outside the workbench and configure it via
//     `externalServices.postgres: postgresql://…` in the container
//     yml, OR
//   - swap to a per-container generated password — open issue when
//     this becomes a real need.
export const SERVICE_CATALOG: Readonly<Record<string, ServiceEntry>> = {
  postgres: {
    id: 'postgres',
    image: 'postgres:18',
    env: {
      POSTGRES_USER: 'monoceros',
      POSTGRES_PASSWORD: 'monoceros',
      POSTGRES_DB: 'monoceros',
    },
    // Postgres 18+ stores data under /var/lib/postgresql/<major>/, so
    // the recommended mount is the parent directory; pre-18 used
    // /var/lib/postgresql/data directly. See
    // https://github.com/docker-library/postgres/pull/1259.
    dataMount: '/var/lib/postgresql',
  },
  mysql: {
    id: 'mysql',
    image: 'mysql:8',
    env: {
      MYSQL_ROOT_PASSWORD: 'monoceros',
      MYSQL_DATABASE: 'monoceros',
    },
    dataMount: '/var/lib/mysql',
  },
  redis: {
    id: 'redis',
    image: 'redis:8',
    dataMount: '/data',
  },
};

export function knownLanguages(): string[] {
  return [...BUILTIN_LANGUAGES, ...Object.keys(LANGUAGE_CATALOG)].sort();
}

export function knownServices(): string[] {
  return Object.keys(SERVICE_CATALOG).sort();
}
