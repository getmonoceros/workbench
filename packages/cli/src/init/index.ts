import { existsSync, promises as fs } from 'node:fs';
import { consola } from 'consola';
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

  // --with-repo URL validation: only canonical hosts. Non-canonical
  // hosts (self-hosted GitLab, Gitea, …) need `provider:` in the yml,
  // and init has no --provider flag, so the builder takes the
  // `monoceros init` + `monoceros add-repo … --provider=…` path
  // instead.
  // Dedupe input URLs (preserve insertion order) — same URL passed
  // twice from the CLI is a no-op, matching how `monoceros add-repo`
  // treats the second-add case.
  const reposRaw = (opts.withRepo ?? [])
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  const repos: string[] = [];
  const seenRepoUrls = new Set<string>();
  for (const url of reposRaw) {
    if (seenRepoUrls.has(url)) continue;
    seenRepoUrls.add(url);
    repos.push(url);
  }
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
  }

  // Both generators take the URL list directly — no AST round-trip
  // after the fact. That lets each generator decide how to render the
  // repos block (commented hints in documented mode, active entries
  // with commented per-entry hint lines in composed mode), keeping
  // the "all available options visible" rule consistent across
  // sections.
  let text: string;
  const requested = opts.with ?? [];
  if (requested.length === 0) {
    text = generateDocumentedYml(opts.name, catalog, lookup, repos);
  } else {
    const components = resolveComponents(catalog, requested);
    text = generateComposedYml(opts.name, components, lookup, repos);
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
