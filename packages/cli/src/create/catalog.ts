// Catalogs of supported language toolchains and backing services for
// `monoceros create`. Curated whitelists keep the surface small and
// reviewable; unknown values are rejected up front rather than passed
// through to devcontainer / compose.

export const BASE_IMAGE =
  'mcr.microsoft.com/devcontainers/typescript-node:22-bookworm';

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
    volume: { name: 'postgres-data', mount: '/var/lib/postgresql/data' },
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
