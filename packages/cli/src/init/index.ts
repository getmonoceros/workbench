import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import {
  containerConfigPath,
  containerConfigsDir,
  monocerosHome as defaultMonocerosHome,
  workbenchRoot as defaultWorkbenchRoot,
  componentsDir as defaultComponentsDir,
} from '../config/paths.js';
import { REGEX } from '../config/schema.js';
import { loadComponentCatalog, resolveComponents } from './components.js';
import { generateComposedYml, generateDocumentedYml } from './generator.js';
import { loadFeatureManifestSummary } from './manifest.js';

/**
 * `monoceros init <name> [--with=<components>]` — produce a fresh
 * container-config yml at `<MONOCEROS_HOME>/container-configs/<name>.yml`.
 *
 * Two modes:
 *
 *   - With `--with=node,postgres,github,claude` (or any comma-list
 *     of component names from the catalog): the listed components
 *     are merged and the result written as an active, immediately-
 *     applyable yml. Per-feature option hints (auth/credentials
 *     from the feature manifest) appear as commented lines next to
 *     the active options so the builder can see what's available
 *     without leaving the file.
 *
 *   - Without `--with`: a documented-default yml is written. Every
 *     section is commented out, every catalog component appears as
 *     a suggestion with prose describing what it adds. Builder
 *     un-comments what they want, then `monoceros apply <name>`.
 *
 * Errors loudly if:
 *
 *   - the target config already exists (delete it first if you want
 *     to start over — protects hand-edits)
 *   - a `--with` name is not in the catalog (the error message
 *     lists what *is* available)
 *   - the chosen container name is shape-invalid
 */

export interface RunInitOptions {
  name: string;
  /**
   * Component names to compose. When empty/undefined → documented
   * mode (every component commented out). When set → composed mode
   * with exactly these components active.
   */
  with?: string[];
  /** Override of the CLI-bundle root that holds `templates/components/`. */
  workbenchRoot?: string;
  /** Override of the user-data home that owns `container-configs/`. */
  monocerosHome?: string;
  logger?: {
    success: (msg: string) => void;
    info: (msg: string) => void;
  };
}

export interface RunInitResult {
  configPath: string;
  /** True when the documented-default mode was used. */
  documented: boolean;
}

export async function runInit(opts: RunInitOptions): Promise<RunInitResult> {
  const workbench = opts.workbenchRoot ?? defaultWorkbenchRoot();
  const home = opts.monocerosHome ?? defaultMonocerosHome();
  const logger = opts.logger ?? {
    success: (msg) => consola.success(msg),
    info: (msg) => consola.info(msg),
  };

  if (!REGEX.solutionName.test(opts.name)) {
    throw new Error(
      `Invalid config name: ${JSON.stringify(opts.name)}. Use letters, digits, '.', '_' or '-'.`,
    );
  }

  const dest = containerConfigPath(opts.name, home);
  if (existsSync(dest)) {
    throw new Error(
      `Config already exists: ${dest}. Delete it manually before re-running \`monoceros init\` — this protects any hand-edits.`,
    );
  }

  const catalog = await loadComponentCatalog(defaultComponentsDir(workbench));
  if (catalog.size === 0) {
    throw new Error(
      `No components found under ${defaultComponentsDir(workbench)}. The workbench checkout is incomplete.`,
    );
  }

  const lookup = (ref: string) => loadFeatureManifestSummary(ref, workbench);

  let text: string;
  const requested = opts.with ?? [];
  if (requested.length === 0) {
    text = generateDocumentedYml(opts.name, catalog, lookup);
  } else {
    const components = resolveComponents(catalog, requested);
    text = generateComposedYml(opts.name, components, lookup);
  }

  await fs.mkdir(containerConfigsDir(home), { recursive: true });
  await fs.writeFile(dest, text, 'utf8');

  const documented = requested.length === 0;
  const rel = path.relative(home, dest) || dest;
  if (documented) {
    logger.success(
      `Wrote documented default to ${rel}. Un-comment what you need, then \`monoceros apply ${opts.name}\`.`,
    );
  } else {
    logger.success(
      `Composed ${requested.length} component(s) into ${rel}: ${requested.join(', ')}`,
    );
    logger.info(
      `Edit the file if you need to tweak, then \`monoceros apply ${opts.name}\`.`,
    );
  }

  return { configPath: dest, documented };
}
