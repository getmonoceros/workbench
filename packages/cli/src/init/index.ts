import { existsSync, promises as fs } from 'node:fs';
import { consola } from 'consola';
import { parseDocument } from 'yaml';
import {
  containerConfigPath,
  containerConfigsDir,
  monocerosHome as defaultMonocerosHome,
  workbenchRoot as defaultWorkbenchRoot,
  workbenchCheckoutRoot,
  componentsDir as defaultComponentsDir,
  prettyPath,
} from '../config/paths.js';
import { KNOWN_PROVIDER_HOSTS, REGEX } from '../config/schema.js';
import { deriveRepoName } from '../create/scaffold.js';
import { addRepoToDoc } from '../modify/yml.js';
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
  /**
   * Git URLs to clone into `projects/` on the first apply. Each URL
   * lands at `projects/<URL-derived-leaf>/` (e.g.
   * `https://.../foo.git` → `projects/foo/`). For nested destination
   * paths (`projects/apps/web/`) use `monoceros add-repo --path=...`
   * post-init — the init flag intentionally keeps the syntax minimal.
   */
  withRepo?: string[];
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

  // Feature manifests live at the workbench-checkout root, not in
  // the CLI bundle. In tests the fixture sets `workbenchRoot` to a
  // dir that happens to hold both the templates *and* an
  // `images/features/` tree; honour that override. In real use we
  // fall back to `workbenchCheckoutRoot()` which returns null when
  // the CLI is run from an npm install — manifest lookups then
  // return undefined and init renders without optionHints.
  const checkoutRoot = opts.workbenchRoot ?? workbenchCheckoutRoot();
  const lookup = (ref: string) => loadFeatureManifestSummary(ref, checkoutRoot);

  let text: string;
  const requested = opts.with ?? [];
  if (requested.length === 0) {
    text = generateDocumentedYml(opts.name, catalog, lookup);
  } else {
    const components = resolveComponents(catalog, requested);
    text = generateComposedYml(opts.name, components, lookup);
  }

  // Merge --with-repo URLs into the freshly composed yml. We parse the
  // text into a Document, run the same addRepoToDoc mutator that
  // `monoceros add-repo` uses (idempotent on duplicates), and re-
  // serialise. Comments from the composed/documented yml survive the
  // round-trip because we use the yaml AST API, not a string rewrite.
  //
  // `--with-repo` only accepts canonical-host URLs — passing
  // `provider:` through the CLI would clutter init's syntax with a
  // rarely-used field. Builders with self-hosted GitLab / Gitea
  // first run `init` to set up the container, then
  // `add-repo … --provider=…` for those custom repos.
  const repos = (opts.withRepo ?? [])
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  if (repos.length > 0) {
    const offending: string[] = [];
    for (const url of repos) {
      let host: string | undefined;
      try {
        host = url.startsWith('https://') ? new URL(url).hostname : undefined;
      } catch {
        host = undefined;
      }
      if (!host || !KNOWN_PROVIDER_HOSTS[host.toLowerCase()]) {
        offending.push(url);
      }
    }
    if (offending.length > 0) {
      throw new Error(
        [
          `--with-repo only supports github.com / gitlab.com / bitbucket.org URLs.`,
          `These are not canonical: ${offending.join(', ')}`,
          `For other hosts, run \`monoceros init <name>\` first, then`,
          `\`monoceros add-repo <name> <url> --provider=github|gitlab|bitbucket\`.`,
        ].join('\n'),
      );
    }
    const doc = parseDocument(text);
    for (const url of repos) {
      const path = deriveRepoName(url);
      addRepoToDoc(doc, { url, path });
    }
    text = String(doc);
  }

  await fs.mkdir(containerConfigsDir(home), { recursive: true });
  await fs.writeFile(dest, text, 'utf8');

  const documented = requested.length === 0;
  const displayPath = prettyPath(dest);
  if (documented) {
    logger.success(
      `Wrote documented default to ${displayPath}. Un-comment what you need, then \`monoceros apply ${opts.name}\`.`,
    );
  } else {
    logger.success(
      `Composed ${requested.length} component(s) into ${displayPath}: ${requested.join(', ')}`,
    );
    logger.info(
      `Edit the file if you need to tweak, then \`monoceros apply ${opts.name}\`.`,
    );
  }

  return { configPath: dest, documented };
}
