import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import {
  containerConfigPath,
  containerConfigsDir,
  containerEnvPath,
  monocerosHome as defaultMonocerosHome,
  componentsRootDir,
} from '../config/paths.js';
import {
  ensureEnvGitignored,
  ensureEnvVars,
  GIT_IDENTITY_VAR,
} from '../config/env-file.js';
import { featureOptionHints } from './feature-doc.js';
import { KNOWN_PROVIDER_HOSTS, REGEX } from '../config/schema.js';
import { loadComponentCatalog, mergeFeatureOptions } from './components.js';
import type { Component } from './components.js';
import {
  generateComposedYml,
  type ComposedInit,
  type InitService,
  type LanguageRender,
} from './generator.js';
import { loadFeatureManifestSummary } from './manifest.js';
import {
  curatedServiceEnvDefaults,
  deriveServiceName,
  isCuratedService,
  knownLanguages,
  parseLanguageSpec,
  LANGUAGE_CATALOG,
} from '../create/catalog.js';

/**
 * `monoceros init <name> [--with-languages=… --with-features=… …]` —
 * produce a fresh container-config yml at
 * `<MONOCEROS_HOME>/container-configs/<name>.yml`.
 *
 * Always lean: the yml carries `name` + `runtimeVersion` and only the
 * sections the builder actually asked for. Per-category flags
 * (`--with-languages=node`, `--with-services=postgres`,
 * `--with-features=github,claude`, `--with-repos=…`; each a comma-list)
 * add active, immediately-applyable blocks; a bare `monoceros init <name>`
 * writes just the basics. No commented-out catalog dump:
 * `monoceros list-components` + add-feature/add-service/add-repo are how
 * you discover and add more. Per-feature option hints (auth/credentials)
 * still appear as commented lines next to an active feature's options.
 *
 * Errors loudly if:
 *
 *   - the target config already exists (delete it first if you want
 *     to start over — protects hand-edits)
 *   - a `--with-*` name is not in the catalog (the error message
 *     lists what *is* available)
 *   - the chosen container name is shape-invalid
 */

export interface RunInitOptions {
  name: string;
  /**
   * Explicit per-category inputs (from `--with-languages`,
   * `--with-features`, `--with-services`, `--with-apt-packages`).
   * Each adds an active block; all empty just yields the lean basics.
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
  logger?: {
    success: (msg: string) => void;
    info: (msg: string) => void;
  };
}

export interface RunInitResult {
  configPath: string;
}

export async function runInit(opts: RunInitOptions): Promise<RunInitResult> {
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

  // Component descriptors live under `<root>/components/` (ADR 0020). In tests
  // the fixture sets `workbenchRoot` to a dir holding the descriptors; honour
  // that. In real use we resolve checkout-first, bundled-copy fallback.
  const componentsRoot = opts.workbenchRoot
    ? path.join(opts.workbenchRoot, 'components')
    : componentsRootDir();
  const catalog = await loadComponentCatalog(componentsRoot);
  if (catalog.size === 0) {
    throw new Error(
      `No components found under ${componentsRoot}. The workbench checkout is incomplete.`,
    );
  }

  // Feature manifest data is derived from the same descriptors (ADR 0020), so
  // the lookup reads from the same components root — no separate manifest
  // tree. Unknown/third-party refs yield undefined and init renders without
  // optionHints.
  const lookup = (ref: string) =>
    loadFeatureManifestSummary(ref, componentsRoot);

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

  // Identity is NOT resolved at init. When repos are present, the
  // generators render a container-level `git.user` with `${VAR}`
  // placeholders and we seed the matching blank keys into `<name>.env`
  // (below). Identity then resolves at apply time from that env file,
  // falling through the cascade (monoceros-config defaults → host →
  // prompt) when the keys are left blank — no init-time prompt.

  // Both generators take the URL + port lists directly — no AST
  // round-trip after the fact. That lets each generator decide how
  // to render the routing/repos block (commented hints in documented
  // mode, active entries in composed mode), keeping the "all
  // available options visible" rule consistent across sections.
  // A repo implies its provider's CLI feature (github/gitlab): add it like
  // any other feature so it lands in the yml and its credential
  // placeholder gets seeded. Resolve each provider to its feature ref via
  // the catalog and pass the ref (init accepts full refs). Deduped against
  // explicit --with-features (by provider short name and by ref). Repos
  // are validated canonical above, so the host lookup + URL parse are safe.
  const explicitFeatures = opts.features ?? [];
  const repoFeatures = [
    ...new Set(
      repos
        .map((u) => KNOWN_PROVIDER_HOSTS[new URL(u).hostname.toLowerCase()])
        .filter(
          (p): p is 'github' | 'gitlab' => p === 'github' || p === 'gitlab',
        )
        .filter((p) => !explicitFeatures.includes(p))
        .map((p) => catalog.get(p)?.file.contributes.features?.[0]?.ref)
        .filter((ref): ref is string => !!ref),
    ),
  ].filter((ref) => !explicitFeatures.includes(ref));

  const composed = resolveComposedInit(catalog, {
    languages: opts.languages ?? [],
    features: [...explicitFeatures, ...repoFeatures],
    services: opts.services ?? [],
    aptPackages: opts.aptPackages ?? [],
  });
  // Always lean: name + runtimeVersion, plus only the sections the
  // builder actually asked for (--with-* entries, repos, ports). No
  // commented-out catalog dump; `monoceros list-components` +
  // add-feature/add-service/add-repo are how you discover and add more.
  const text = generateComposedYml(opts.name, composed, lookup, repos, ports);

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
  // When repos are present, the yml carries a container-level
  // `git.user: ${GIT_USER_NAME}/${GIT_USER_EMAIL}` — seed the matching
  // keys BLANK so the builder either fills them or leaves them empty
  // (→ apply climbs the identity cascade). Blank, not host-derived: the
  // builder asked for a shareable, env-managed identity.
  if (repos.length > 0) {
    seedVars[GIT_IDENTITY_VAR.name] = '';
    seedVars[GIT_IDENTITY_VAR.email] = '';
  }
  await ensureEnvVars(envPath, opts.name, seedVars);

  // Paths relative to MONOCEROS_HOME keep the line readable (the dev
  // .local home is deep under the project root).
  const ymlRel = path.relative(home, dest);
  const envRel = path.relative(home, envPath);
  logger.success(`Wrote ${ymlRel} and ${envRel}.`);
  logger.info(
    `Add components with \`monoceros add-feature/add-service/add-repo ${opts.name}\` (see \`monoceros list-components\`), then \`monoceros apply ${opts.name}\`.`,
  );

  return { configPath: dest };
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

function resolveInitLanguages(entries: string[]): LanguageRender[] {
  const known = new Set(knownLanguages());
  const out: LanguageRender[] = [];
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
    const entry = LANGUAGE_CATALOG[spec.name];
    // Always surface the version inline (`name:<defaultVersion>`) so the
    // builder sees where to edit it; an explicit `:version` from the flag
    // wins. Plus the language's `surface: yml` option defaults (e.g. java ->
    // installMaven/installGradle) as the object form.
    const renderedSpec =
      spec.version === undefined && entry?.defaultVersion
        ? `${spec.name}:${entry.defaultVersion}`
        : e;
    if (out.some((o) => o.spec === renderedSpec)) continue;
    const ymlOptions = entry?.ymlOptions;
    out.push({
      spec: renderedSpec,
      ...(ymlOptions && Object.keys(ymlOptions).length > 0
        ? { options: ymlOptions }
        : {}),
    });
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
