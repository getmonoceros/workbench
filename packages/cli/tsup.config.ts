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
});
