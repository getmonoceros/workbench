// Ship the committed catalog.json inside the npm package. `dist` is already in
// package `files`, so copying it there publishes it to npm, where the docs MCP
// fetches the RELEASED catalog via jsDelivr:
//   https://cdn.jsdelivr.net/npm/@getmonoceros/workbench@latest/dist/catalog.json
// The root catalog.json is kept fresh by the precheck gate before any publish,
// so the copy always reflects the release it ships in. Runs after tsup (which
// cleans dist), see package.json "build".
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/cli/scripts
const cliRoot = path.resolve(here, '..');
const checkoutRoot = path.resolve(cliRoot, '..', '..');

copyFileSync(
  path.join(checkoutRoot, 'catalog.json'),
  path.join(cliRoot, 'dist', 'catalog.json'),
);

console.log('[copy-catalog-to-dist] dist/catalog.json');
