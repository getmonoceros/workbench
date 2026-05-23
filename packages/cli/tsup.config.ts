import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

// Build configuration for the published `@getmonoceros/workbench`
// npm package. We bundle our own TypeScript sources into
// `dist/bin.js` (and any sibling chunks tsup produces) while leaving
// `dependencies` from package.json external — those come down via
// `npm install` on the user's machine, including `@devcontainers/cli`
// which we spawn as a child Node process at runtime.
//
// ESM only — we already use `import.meta.url`, `createRequire` and
// other ESM-native APIs throughout the source. There's no caller
// requiring CJS, and dual-format would only inflate the package.

// CLI version is sourced from package.json at build time and replaces
// the `__CLI_VERSION__` placeholder in `src/version.ts`. Single
// source of truth: bump `packages/cli/package.json`, rebuild, done —
// no second file to keep in sync.
const here = path.dirname(fileURLToPath(import.meta.url));
const pkgVersion = JSON.parse(
  readFileSync(path.join(here, 'package.json'), 'utf8'),
).version as string;

export default defineConfig({
  entry: ['src/bin.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Keep the shebang in dist/bin.js so the npm-installed `bin` shim
  // can execute it directly under `node`.
  shims: false,
  splitting: false,
  // External: everything from `dependencies` resolves at runtime
  // from the user's node_modules. tsup's default behaviour already
  // externalises declared deps; the explicit `noExternal: []` makes
  // that contract visible in the config.
  noExternal: [],
  // esbuild's `define` does compile-time string replacement on the
  // identifier — every `__CLI_VERSION__` in our sources gets
  // substituted with the JSON-encoded package version. The
  // JSON.stringify wrap is required (esbuild treats `define` values
  // as raw JS expressions, not strings).
  define: {
    __CLI_VERSION__: JSON.stringify(pkgVersion),
  },
});
