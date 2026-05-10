// Catalogs of supported language toolchains and backing services for
// `monoceros create`. Curated whitelists keep the surface small and
// reviewable; unknown values are rejected up front rather than passed
// through to devcontainer / compose.

// Monoceros runtime image — thin layer on top of Microsoft's
// typescript-node base, adding the Claude Code CLI and an
// iptables-based egress allowlist. Built locally via
// `cd images/runtime && docker build -t monoceros-runtime:dev .`
// (see images/runtime/README.md). Once GHCR-published (Task 8c) we
// switch this to `ghcr.io/kamann/monoceros-runtime:<tag>`.
export const BASE_IMAGE = 'monoceros-runtime:dev';

export interface LanguageEntry {
  id: string;
  feature: string;
}

// `node` is included in the base image and therefore has no separate
// devcontainer feature. It is accepted as input but produces no output.
export const BUILTIN_LANGUAGES = new Set(['node']);

export const LANGUAGE_CATALOG: Readonly<Record<string, LanguageEntry>> = {
  python: { id: 'python', feature: 'ghcr.io/devcontainers/features/python:1' },
  java: { id: 'java', feature: 'ghcr.io/devcontainers/features/java:1' },
  go: { id: 'go', feature: 'ghcr.io/devcontainers/features/go:1' },
  rust: { id: 'rust', feature: 'ghcr.io/devcontainers/features/rust:1' },
  dotnet: { id: 'dotnet', feature: 'ghcr.io/devcontainers/features/dotnet:2' },
};

export interface ServiceEntry {
  id: string;
  image: string;
  env?: Readonly<Record<string, string>>;
  volume?: { name: string; mount: string };
}

export const SERVICE_CATALOG: Readonly<Record<string, ServiceEntry>> = {
  postgres: {
    id: 'postgres',
    image: 'postgres:18',
    env: {
      POSTGRES_USER: 'monoceros',
      POSTGRES_PASSWORD: 'monoceros',
      POSTGRES_DB: 'monoceros',
    },
    // Postgres 18+ stores data under /var/lib/postgresql/<major>/, so the
    // recommended volume mount is the parent directory; pre-18 used
    // /var/lib/postgresql/data directly. See
    // https://github.com/docker-library/postgres/pull/1259.
    volume: { name: 'postgres-data', mount: '/var/lib/postgresql' },
  },
  mysql: {
    id: 'mysql',
    image: 'mysql:8',
    env: {
      MYSQL_ROOT_PASSWORD: 'monoceros',
      MYSQL_DATABASE: 'monoceros',
    },
    volume: { name: 'mysql-data', mount: '/var/lib/mysql' },
  },
  redis: {
    id: 'redis',
    image: 'redis:8',
    volume: { name: 'redis-data', mount: '/data' },
  },
};

export function knownLanguages(): string[] {
  return [...BUILTIN_LANGUAGES, ...Object.keys(LANGUAGE_CATALOG)].sort();
}

export function knownServices(): string[] {
  return Object.keys(SERVICE_CATALOG).sort();
}
