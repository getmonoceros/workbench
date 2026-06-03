import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import {
  containerConfigPath,
  containerConfigsDir,
  containerEnvPath,
  monocerosHome as defaultMonocerosHome,
  workbenchRoot as defaultWorkbenchRoot,
  workbenchCheckoutRoot,
  componentsDir as defaultComponentsDir,
  prettyPath,
} from '../config/paths.js';
import {
  readMonocerosConfig,
  writeGlobalDefaultGitUser,
} from '../config/global.js';
import { parseConfig, stringifyConfig } from '../config/io.js';
import { ensureEnvGitignored, ensureEnvVars } from '../config/env-file.js';
import { featureOptionHints } from './feature-doc.js';
import { KNOWN_PROVIDER_HOSTS, REGEX } from '../config/schema.js';
import {
  resolveIdentityWithPrompt,
  type IdentityPrompt,
  type IdentityScopePrompt,
  type IdentitySpawn,
} from '../devcontainer/identity.js';
import { setContainerGitUserInDoc } from '../modify/yml.js';
import { loadComponentCatalog, mergeFeatureOptions } from './components.js';
import type { Component } from './components.js';
import {
  generateComposedYml,
  generateDocumentedYml,
  type ComposedInit,
  type InitService,
} from './generator.js';
import { loadFeatureManifestSummary } from './manifest.js';
import {
  curatedServiceEnvDefaults,
  deriveServiceName,
  isCuratedService,
  knownLanguages,
  parseLanguageSpec,
} from '../create/catalog.js';

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
   * Explicit per-category inputs (from `--with-languages`,
   * `--with-features`, `--with-services`, `--with-apt-packages`).
   * When ALL of these are empty/undefined → documented mode (every
   * catalog component commented out). When any is set → composed mode.
   *
   *   - `languages`: curated runtime names, optional `:version`
   *     (`java:17`). Validated against the language catalog.
   *   - `features`: curated short names (`claude`, `atlassian/twg`) OR
   *     full OCI refs (`ghcr.io/foo/bar:1`).
   *   - `services`: curated names (`postgres`) → expanded block, OR any
   *     image (`rustfs/rustfs:latest`) → name+image + commented scaffold.
   *   - `aptPackages`: arbitrary apt package names (no catalog).
   */
  languages?: string[];
  features?: string[];
  services?: string[];
  aptPackages?: string[];
  /**
   * Git URLs to clone into `projects/` on the first apply. Each URL
   * lands at `projects/<URL-derived-leaf>/` (e.g.
   * `https://.../foo.git` → `projects/foo/`). For nested destination
   * paths (`projects/apps/web/`) use `monoceros add-repo --path=...`
   * post-init — the init flag intentionally keeps the syntax minimal.
   */
  withRepo?: string[];
  /**
   * Container-internal ports to pre-seed in `routing.ports`. First
   * entry doubles as the bare `<name>.localhost` default route in
   * Traefik. Equivalent to running `monoceros add-port` after init.
   * Each must be an integer in [1, 65535]; invalid values raise a
   * usage error before the yml is written.
   */
  withPorts?: number[];
  /** Override of the CLI-bundle root that holds `templates/components/`. */
  workbenchRoot?: string;
  /** Override of the user-data home that owns `container-configs/`. */
  monocerosHome?: string;
  /** Injected for tests; production reads `git config --global`. */
  identitySpawn?: IdentitySpawn;
  /** Injected for tests; production prompts via consola. */
  identityPrompt?: IdentityPrompt;
  /** Injected for tests; production prompts via consola. */
  identityScopePrompt?: IdentityScopePrompt;
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

  // --with-ports validation: integer 1..65535, dedupe preserving
  // insertion order (first entry = the default route — collapsing two
  // mentions of 3000 to a single entry keeps that semantics
  // unambiguous).
  const portsRaw = opts.withPorts ?? [];
  const ports: number[] = [];
  const seenPorts = new Set<number>();
  for (const raw of portsRaw) {
    if (!Number.isInteger(raw) || raw < 1 || raw > 65535) {
      throw new Error(
        `Invalid port in --with-ports: ${JSON.stringify(raw)}. Expected integers between 1 and 65535.`,
      );
    }
    if (seenPorts.has(raw)) continue;
    seenPorts.add(raw);
    ports.push(raw);
  }

  // If the builder asked for repos via --with-repo, they'll need a
  // git committer identity at apply time. Pre-empt that prompt here
  // so the new container starts with the right values baked in —
  // either as a global default in monoceros-config (most common) or
  // as a container-level git.user (one-off identity for this
  // container). The prompt is skipped when the identity can be
  // resolved without asking (yml override doesn't exist yet at this
  // point, but defaults / host global may).
  let promptedIdentity:
    | {
        prompted?: { name: string; email: string; scope: 'g' | 'c' | 'b' };
      }
    | undefined;
  if (repos.length > 0) {
    const globalConfig = await readMonocerosConfig({ monocerosHome: home });
    promptedIdentity = await resolveIdentityWithPrompt({
      ...(opts.identitySpawn ? { spawn: opts.identitySpawn } : {}),
      ...(opts.identityPrompt ? { prompt: opts.identityPrompt } : {}),
      ...(opts.identityScopePrompt
        ? { scopePrompt: opts.identityScopePrompt }
        : {}),
      ...(globalConfig?.defaults?.git?.user
        ? { defaults: globalConfig.defaults.git.user }
        : {}),
      logger: { info: logger.info, warn: logger.info },
    });
  }

  // Both generators take the URL + port lists directly — no AST
  // round-trip after the fact. That lets each generator decide how
  // to render the routing/repos block (commented hints in documented
  // mode, active entries in composed mode), keeping the "all
  // available options visible" rule consistent across sections.
  let text: string;
  const composed = resolveComposedInit(catalog, {
    languages: opts.languages ?? [],
    features: opts.features ?? [],
    services: opts.services ?? [],
    aptPackages: opts.aptPackages ?? [],
  });
  const anyComposed =
    composed.languages.length > 0 ||
    composed.features.length > 0 ||
    composed.services.length > 0 ||
    composed.aptPackages.length > 0;
  if (!anyComposed) {
    text = generateDocumentedYml(opts.name, catalog, lookup, repos, ports);
  } else {
    text = generateComposedYml(opts.name, composed, lookup, repos, ports);
  }

  await fs.mkdir(containerConfigsDir(home), { recursive: true });
  await ensureEnvGitignored(containerConfigsDir(home));
  await fs.writeFile(dest, text, 'utf8');

  // Scaffold the gitignored `<name>.env`: create it with the header
  // stub, then seed the `${VAR}` references the composed yml carries —
  // feature credential placeholders as blank `VAR=` keys (builder fills
  // them) and curated-service env vars with their dev-defaults
  // (`POSTGRES_USER=monoceros`, …; builder can keep or change them).
  // Upsert — never overwrites an existing env file's keys (e.g. one
  // from `restore`). Service defaults win over feature blanks on the
  // (unlikely) key collision.
  const envPath = containerEnvPath(opts.name, home);
  const seedVars: Record<string, string> = {};
  for (const f of composed.features) {
    for (const h of featureOptionHints(
      lookup(f.ref),
      f.ref,
      Object.keys(f.options ?? {}),
    )) {
      if (!(h.envVar in seedVars)) seedVars[h.envVar] = '';
    }
  }
  for (const svc of composed.services) {
    if (svc.kind === 'curated') {
      Object.assign(seedVars, curatedServiceEnvDefaults(svc.name));
    }
  }
  await ensureEnvVars(envPath, opts.name, seedVars);

  // Persist the prompted identity AFTER the yml is on disk: scope
  // `g` writes the global monoceros-config; `c` mutates the freshly-
  // written container yml in place via the AST setter; `b` does both.
  // Persistence failures surface as warns — the yml itself is already
  // correct and the apply prompt will catch up if needed.
  if (promptedIdentity?.prompted) {
    const { name, email, scope } = promptedIdentity.prompted;
    if (scope === 'g' || scope === 'b') {
      try {
        const result = await writeGlobalDefaultGitUser(
          { name, email },
          { monocerosHome: home },
        );
        if (result.alreadySet) {
          logger.info(
            `monoceros-config.yml already had a defaults.git.user — left it alone.`,
          );
        } else if (result.created) {
          logger.info(
            `Saved identity globally — created ${prettyPath(result.filePath)} with defaults.git.user.`,
          );
        } else {
          logger.info(
            `Saved identity globally to ${prettyPath(result.filePath)}.`,
          );
        }
      } catch (err) {
        logger.info(
          `Could not persist identity to monoceros-config.yml: ${err instanceof Error ? err.message : String(err)}. \`monoceros apply\` will re-prompt.`,
        );
      }
    }
    if (scope === 'c' || scope === 'b') {
      try {
        const written = await fs.readFile(dest, 'utf8');
        const parsed = parseConfig(written, dest);
        const changed = setContainerGitUserInDoc(parsed.doc, { name, email });
        if (changed) {
          await fs.writeFile(dest, stringifyConfig(parsed.doc), 'utf8');
          logger.info(
            `Saved identity in ${prettyPath(dest)} (container-level git.user).`,
          );
        }
      } catch (err) {
        logger.info(
          `Could not persist identity into ${prettyPath(dest)}: ${err instanceof Error ? err.message : String(err)}. \`monoceros apply\` will re-prompt.`,
        );
      }
    }
  }

  const documented = !anyComposed;
  // Paths relative to MONOCEROS_HOME keep the line readable (the dev
  // .local home is deep under the project root).
  const ymlRel = path.relative(home, dest);
  const envRel = path.relative(home, envPath);
  if (documented) {
    logger.success(`Wrote documented default to ${ymlRel} and ${envRel}.`);
    logger.info(
      `Un-comment what you need, then \`monoceros apply ${opts.name}\`.`,
    );
  } else {
    logger.success(`Composed into ${ymlRel} and ${envRel}.`);
    logger.info(
      `Edit the files if you need to tweak, then \`monoceros apply ${opts.name}\`.`,
    );
  }

  return { configPath: dest, documented };
}

// ───── Composed-mode input resolution ─────────────────────────────

/**
 * Resolve the raw `--with-*` lists into the categorized, validated
 * shape the composed generator consumes. Curated vs. arbitrary handling
 * lives here:
 *   - languages → validated against the language catalog (`:version` ok)
 *   - features  → catalog short name OR full OCI ref
 *   - services  → curated name (expanded) OR any image (scaffolded)
 *   - aptPackages → arbitrary names (shape-checked only)
 */
function resolveComposedInit(
  catalog: Map<string, Component>,
  raw: {
    languages: string[];
    features: string[];
    services: string[];
    aptPackages: string[];
  },
): ComposedInit {
  return {
    languages: resolveInitLanguages(raw.languages),
    aptPackages: resolveInitAptPackages(raw.aptPackages),
    services: resolveInitServices(raw.services),
    features: resolveInitFeatures(catalog, raw.features),
  };
}

function resolveInitLanguages(entries: string[]): string[] {
  const known = new Set(knownLanguages());
  const out: string[] = [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const raw of entries) {
    const e = raw.trim();
    if (!e || seen.has(e)) continue;
    const spec = parseLanguageSpec(e);
    if (!spec || !known.has(spec.name)) {
      unknown.push(e);
      continue;
    }
    seen.add(e);
    out.push(e);
  }
  if (unknown.length > 0) {
    throw new Error(
      `Unknown language${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
        `Known: ${knownLanguages().join(', ')}.`,
    );
  }
  return out;
}

function resolveInitAptPackages(entries: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const bad: string[] = [];
  for (const raw of entries) {
    const e = raw.trim();
    if (!e || seen.has(e)) continue;
    if (!REGEX.aptPackage.test(e)) {
      bad.push(e);
      continue;
    }
    seen.add(e);
    out.push(e);
  }
  if (bad.length > 0) {
    throw new Error(
      `Invalid apt package name${bad.length > 1 ? 's' : ''}: ${bad.join(', ')}. ` +
        `Expected lowercase alphanumeric plus '.+-'.`,
    );
  }
  return out;
}

function resolveInitServices(entries: string[]): InitService[] {
  const out: InitService[] = [];
  const byName = new Map<string, InitService>();
  for (const raw of entries) {
    const e = raw.trim();
    if (!e) continue;
    const svc: InitService = isCuratedService(e)
      ? { kind: 'curated', name: e }
      : { kind: 'custom', name: deriveServiceName(e), image: e };
    const existing = byName.get(svc.name);
    if (existing) {
      // Same entry twice → no-op; a genuine name clash → error.
      if (existing.kind === svc.kind && existing.image === svc.image) continue;
      throw new Error(
        `Two --with-services entries resolve to the service name '${svc.name}'. ` +
          `Add one after init with \`monoceros add-service ${'<name>'} <image> --as=<other>\`.`,
      );
    }
    byName.set(svc.name, svc);
    out.push(svc);
  }
  return out;
}

function resolveInitFeatures(
  catalog: Map<string, Component>,
  entries: string[],
): Array<{ ref: string; options: Record<string, string | number | boolean> }> {
  const byRef = new Map<
    string,
    { ref: string; options: Record<string, string | number | boolean> }
  >();
  const unknown: string[] = [];
  for (const raw of entries) {
    const e = raw.trim();
    if (!e) continue;
    if (REGEX.featureRef.test(e)) {
      if (!byRef.has(e)) byRef.set(e, { ref: e, options: {} });
      continue;
    }
    const c = catalog.get(e);
    if (!c || c.file.category !== 'feature') {
      unknown.push(e);
      continue;
    }
    for (const f of c.file.contributes.features ?? []) {
      const existing = byRef.get(f.ref);
      if (!existing) {
        byRef.set(f.ref, { ref: f.ref, options: { ...(f.options ?? {}) } });
      } else {
        existing.options = mergeFeatureOptions(
          existing.options,
          f.options ?? {},
        );
      }
    }
  }
  if (unknown.length > 0) {
    const featureNames = [...catalog.values()]
      .filter((c) => c.file.category === 'feature')
      .map((c) => c.name)
      .sort();
    throw new Error(
      `Unknown feature${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.\n` +
        `Use a catalog short name (${featureNames.join(', ')}) or a full OCI ref (ghcr.io/…/<name>:<tag>).`,
    );
  }
  return [...byRef.values()];
}
