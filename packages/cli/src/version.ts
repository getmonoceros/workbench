// Single source of truth for the CLI version: `packages/cli/package.json`.
//
// At build time tsup (`tsup.config.ts`) reads `package.json.version` and
// substitutes the `__CLI_VERSION__` placeholder below. So bumping the
// version means editing exactly one file — package.json — and rebuilding.
//
// In dev (vitest, tsc) the placeholder isn't replaced; the fallback
// `'dev'` kicks in. Tests don't depend on the exact version string.

declare const __CLI_VERSION__: string;

export const CLI_VERSION =
  typeof __CLI_VERSION__ === 'string' ? __CLI_VERSION__ : 'dev';
