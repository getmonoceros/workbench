// Catalogs of supported language toolchains and backing services for
// the yml profile. Curated whitelists keep the surface small and
// reviewable; unknown values are rejected up front rather than passed
// through to devcontainer / compose.

import type { ServiceObject } from '../config/schema.js';
import type { ResolvedService } from './types.js';

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
  /**
   * Default in-container port the service listens on. Used by
   * `monoceros tunnel <name> <service>` to resolve the service-name
   * to a port without an extra CLI argument. See ADR 0009.
   */
  defaultPort: number;
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
    defaultPort: 5432,
  },
  mysql: {
    id: 'mysql',
    image: 'mysql:8',
    env: {
      MYSQL_ROOT_PASSWORD: 'monoceros',
      MYSQL_DATABASE: 'monoceros',
    },
    dataMount: '/var/lib/mysql',
    defaultPort: 3306,
  },
  redis: {
    id: 'redis',
    image: 'redis:8',
    dataMount: '/data',
    defaultPort: 6379,
  },
};

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
 * edit) every field. Throws if `name` isn't curated.
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
    ...(def.env ? { env: { ...def.env } } : {}),
    ...(def.dataMount ? { volumes: [`data:${def.dataMount}`] } : {}),
  };
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
