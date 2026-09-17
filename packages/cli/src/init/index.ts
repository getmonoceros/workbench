import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import {
  containerConfigPath,
  containerConfigsDir,
  containerEnvPath,
  globalEnvPath,
  monocerosHome as defaultMonocerosHome,
  prettyPath,
  componentsRootDir,
} from '../config/paths.js';
import {
  ensureEnvGitignored,
  ensureEnvVars,
  readEnvFile,
  GIT_IDENTITY_VAR,
} from '../config/env-file.js';
import { readConfig } from '../config/io.js';
import {
  runAddAptPackages,
  runAddFeature,
  runAddLanguage,
  runAddMcpServer,
  runAddPort,
  runAddRepo,
  runAddService,
} from '../modify/index.js';
import {
  KNOWN_PROVIDER_HOSTS,
  PROVIDER_FEATURE_SELECTOR,
  REGEX,
  type RepoProvider,
} from '../config/schema.js';
import { buildComponentCatalog, mergeFeatureOptions } from './components.js';
import type { Component } from './components.js';
import {
  loadDescriptorCatalog,
  type CatalogComponent,
} from '../catalog/load.js';
import {
  buildMcpConnectorDoc,
  findMcpConnector,
  mcpConnectorNames,
} from './mcp-doc.js';
import {
  generateComposedYml,
  type ComposedInit,
  type InitService,
  type LanguageRender,
  type RenderableMcp,
} from './generator.js';
import { loadFeatureManifestSummary } from './manifest.js';
import { renderWorkbenchTemplate } from './templates.js';
import {
  collectEnvPromptCandidates,
  promptAndWriteEnvValues,
  shouldPromptForEnv,
} from './env-prompt.js';
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
   * MCP servers to register with the container's agents (`--with-mcp-servers`).
   * Curated catalog names only; a server the catalog does not carry is a
   * hand-written `mcpServers:` entry, because init has no syntax for a full
   * definition.
   */
  mcpServers?: string[];
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
  /**
   * Workbench template to start from (`--template=discovery-atlassian`). The
   * template is a prepared yml, so it carries what the `--with-*` flags
   * cannot say: a feature's nested `plugins:` block and its `surface: yml`
   * options. It is written first and the `--with-*` entries are added on top,
   * under the same rules an `add-*` would follow.
   */
  template?: string;
  /**
   * Skip the prompt for env-surfaced feature options and leave the keys
   * blank (`--yes`). Also implied by a non-TTY stdin or stdout.
   */
  yes?: boolean;
  /**
   * Override of the dir holding the SHIPPED workbench templates. Tests inject
   * one. The builder's own dir is derived from `monocerosHome`, so a test that
   * sets both gets the real two-place lookup.
   */
  templatesDir?: string;
  /** Force the env prompt on or off, bypassing the TTY check. Tests only. */
  promptEnv?: boolean;
  /** Injected answer source for the env prompt. Tests only. */
  askEnvValue?: (candidate: {
    envVar: string;
    feature: string;
    description: string;
  }) => Promise<string | undefined>;
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
  // Two views of the same tree: the selectable `Component` map the composed
  // resolution has always used, and the raw descriptors, which MCP servers
  // need because their whole definition lives in the descriptor.
  const descriptors = await loadDescriptorCatalog(componentsRoot);
  const catalog = buildComponentCatalog(descriptors);
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
  // A repo implies its provider's CLI feature: github/gitlab → their CLI,
  // bitbucket → the Atlassian `twg` preset (ADR 0035). Add it as its
  // catalog selector (NOT the raw ref — the selector path carries the
  // preset's option overrides, e.g. twg-only; a raw ref would seed empty
  // options). Deduped against explicit --with-features by selector. Repos
  // are validated canonical above, so the host lookup + URL parse are safe.
  const explicitFeatures = opts.features ?? [];
  const repoFeatures = [
    ...new Set(
      repos
        .map((u) => KNOWN_PROVIDER_HOSTS[new URL(u).hostname.toLowerCase()])
        .filter((p): p is RepoProvider => p !== undefined)
        .map((p) => PROVIDER_FEATURE_SELECTOR[p]),
    ),
  ]
    // Skip a provider whose feature isn't in the catalog (graceful, as the
    // ref-based lookup was before) — keeps a minimal test catalog working.
    .filter((sel) => catalog.has(sel))
    .filter((sel) => !explicitFeatures.includes(sel));

  const composed = resolveComposedInit(catalog, descriptors, {
    languages: opts.languages ?? [],
    features: [...explicitFeatures, ...repoFeatures],
    services: opts.services ?? [],
    aptPackages: opts.aptPackages ?? [],
    mcpServers: opts.mcpServers ?? [],
  });
  // Always lean: name + runtimeVersion, plus only the sections the
  // builder actually asked for (--with-* entries, repos, ports). No
  // commented-out catalog dump; `monoceros list-components` +
  // add-feature/add-service/add-repo are how you discover and add more.
  const text = opts.template
    ? await renderWorkbenchTemplate(opts.template, opts.name, {
        monocerosHome: home,
        ...(opts.templatesDir ? { bundledDir: opts.templatesDir } : {}),
      })
    : generateComposedYml(opts.name, composed, lookup, repos, ports);

  await fs.mkdir(containerConfigsDir(home), { recursive: true });
  await ensureEnvGitignored(containerConfigsDir(home));
  await fs.writeFile(dest, text, 'utf8');

  // A template is a whole yml, so the `--with-*` entries cannot be composed
  // into it — they are added to the written file the way `monoceros add-*`
  // would, which is also where their rules come from: a component already in
  // the template stays as the template set it, and a conflicting one is the
  // same error it is on the command line.
  if (opts.template) {
    // A rejected `--with-*` entry must not leave the half-written config
    // behind: the builder would fix their command line and hit "Config
    // already exists" for a file they never got to keep.
    const envExisted = existsSync(containerEnvPath(opts.name, home));
    try {
      await applyWithFlagsToTemplate(opts, home);
    } catch (err) {
      await fs.rm(dest, { force: true });
      if (!envExisted) {
        await fs.rm(containerEnvPath(opts.name, home), { force: true });
      }
      throw err;
    }
  }

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
  // Feature credentials come off the FINISHED yml rather than the in-memory
  // composition, so one pass covers a template, the `--with-*` flags, and the
  // two combined: by now they are all just entries in the same file. These are
  // also the values the prompt below asks for, so the keys exist either way.
  const finalConfig = await readConfig(dest);
  const envCandidates = collectEnvPromptCandidates(
    finalConfig.config.features ?? [],
    lookup,
  );
  for (const candidate of envCandidates) {
    if (!(candidate.envVar in seedVars)) seedVars[candidate.envVar] = '';
  }
  for (const svc of opts.template ? [] : composed.services) {
    if (svc.kind === 'curated') {
      Object.assign(seedVars, curatedServiceEnvDefaults(svc.name));
    }
  }
  // A template can carry services too, and they are not in `composed`. Read
  // them off the written file: every `${VAR}` a service references gets a key,
  // and a curated one brings the dev-defaults it ships with, so a postgres out
  // of a template comes up with credentials instead of an empty password. Not
  // prompt candidates: these are working defaults, not secrets only the builder
  // has, which is why `add-service` does not ask either.
  if (opts.template) {
    for (const svc of finalConfig.config.services ?? []) {
      for (const ref of collectServiceEnvRefs(svc)) {
        if (!(ref in seedVars)) seedVars[ref] = '';
      }
      if (isCuratedService(svc.name)) {
        Object.assign(seedVars, curatedServiceEnvDefaults(svc.name));
      }
    }
  }
  // MCP server credentials, blank for the builder to fill. Not optional
  // politeness: apply refuses a connector whose credential resolves empty
  // rather than registering a server that fails on first use, so the key has
  // to be waiting in the env file.
  for (const server of opts.template ? [] : composed.mcpServers) {
    for (const value of Object.values(server.options)) {
      if (typeof value !== 'string') continue;
      const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
      if (match && !(match[1]! in seedVars)) seedVars[match[1]!] = '';
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

  // Ask for the env-surfaced options the finished yml references. Reading the
  // written file rather than the in-memory `composed` is what makes one code
  // path cover a template, the `--with-*` flags, and the two combined: by now
  // they are all just entries in the same file. Seeding runs first, so every
  // key is present and the answers only fill in the blanks.
  // Every candidate whose value is still empty, which is not the same as the
  // keys this call seeded: an `add-*` run for a `--with-*` entry seeds its own,
  // and those need asking too. A value already in the file, from `restore` or
  // from the builder, is left alone and not asked about.
  const currentEnv = readEnvFile(envPath);
  await promptAndWriteEnvValues(
    envCandidates.filter((c) => (currentEnv[c.envVar] ?? '').trim() === ''),
    envPath,
    opts.name,
    {
      interactive: opts.promptEnv ?? shouldPromptForEnv(opts.yes),
      globalEnvPath: prettyPath(globalEnvPath(home)),
      containerEnvPath: prettyPath(envPath),
      ...(opts.askEnvValue ? { ask: opts.askEnvValue } : {}),
      output: (line) => logger.info(line),
    },
  );

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

/**
 * Every `${VAR}` a service block references, from wherever it sits: `env:`,
 * the healthcheck, `connectionEnv`. Walking the value tree rather than naming
 * the fields keeps this right when a service gains one.
 *
 * `connectionEnv` templates also carry `${host}` and `${port}`, which apply
 * substitutes per instance and which are not env keys, so they are skipped.
 */
function collectServiceEnvRefs(value: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const m of node.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        const name = m[1]!;
        if (name !== 'host' && name !== 'port') out.push(name);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node && typeof node === 'object') {
      for (const item of Object.values(node)) walk(item);
    }
  };
  walk(value);
  return [...new Set(out)];
}

// ───── Template mode ──────────────────────────────────────────────

/**
 * Apply the `--with-*` entries to a config that came from a template.
 *
 * Each category goes through the very `runAdd*` the matching `monoceros
 * add-*` command uses, in the order the flags are documented in. That is the
 * whole point of doing it this way: there is no second merge implementation
 * to keep in step, so a component the template already carries behaves
 * exactly as it does when you add it by hand afterwards.
 */
async function applyWithFlagsToTemplate(
  opts: RunInitOptions,
  home: string,
): Promise<void> {
  const common = { name: opts.name, monocerosHome: home };
  // Silent, and no questions of their own. init asks for every credential in
  // one block once the file is final: an `add-*` prompting mid-run put the
  // github token question before init had even said what it was asking for,
  // with the rest of the questions arriving after. The keys are still seeded,
  // so the block at the end picks them up.
  const quiet = {
    logger: { info: () => {}, success: () => {}, warn: () => {} },
    yes: true,
  };
  for (const language of opts.languages ?? []) {
    await runAddLanguage({ ...common, ...quiet, language });
  }
  for (const service of opts.services ?? []) {
    await runAddService({ ...common, ...quiet, service });
  }
  for (const ref of opts.features ?? []) {
    await runAddFeature({ ...common, ...quiet, ref });
  }
  for (const connector of opts.mcpServers ?? []) {
    await runAddMcpServer({ ...common, ...quiet, connector });
  }
  const aptPackages = opts.aptPackages ?? [];
  if (aptPackages.length > 0) {
    await runAddAptPackages({ ...common, ...quiet, packages: aptPackages });
  }
  for (const url of opts.withRepo ?? []) {
    // `containerLookupDocker` finds a RUNNING container to clone into, which
    // `add-repo` does so the builder need not re-apply. init has no container
    // to speak of: it just created this config, so anything running under the
    // same name is an older workbench, and cloning into it is wrong. A lookup
    // that reports nothing keeps the yml write and skips the clone.
    await runAddRepo({
      ...common,
      ...quiet,
      url,
      containerLookupDocker: async () => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }),
    });
  }
  const ports = opts.withPorts ?? [];
  if (ports.length > 0) {
    await runAddPort({ ...common, ...quiet, ports });
  }
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
  descriptors: Map<string, CatalogComponent>,
  raw: {
    languages: string[];
    features: string[];
    services: string[];
    aptPackages: string[];
    mcpServers: string[];
  },
): ComposedInit {
  return {
    languages: resolveInitLanguages(raw.languages),
    aptPackages: resolveInitAptPackages(raw.aptPackages),
    services: resolveInitServices(raw.services),
    features: resolveInitFeatures(catalog, raw.features),
    mcpServers: resolveInitMcpServers(descriptors, raw.mcpServers),
  };
}

/**
 * `--with-mcp-servers` names → renderable entries. Curated connectors only: init has
 * no syntax for a full server definition, and a pasted one is a hand-edit or a
 * later `--from-json`. Unknown names are reported together, with the catalog.
 */
function resolveInitMcpServers(
  descriptors: Map<string, CatalogComponent>,
  entries: string[],
): RenderableMcp[] {
  const out: RenderableMcp[] = [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const raw of entries) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    const descriptor = findMcpConnector(descriptors, name);
    if (!descriptor) {
      unknown.push(name);
      continue;
    }
    seen.add(name);
    const doc = buildMcpConnectorDoc(descriptor);
    out.push({
      name: doc.name,
      options: doc.options,
      headerLines: doc.headerLines,
    });
  }
  if (unknown.length > 0) {
    const known = mcpConnectorNames(descriptors).join(', ') || '(none)';
    throw new Error(
      `Unknown MCP server${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
        `Catalog connectors: ${known}.`,
    );
  }
  return out;
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
