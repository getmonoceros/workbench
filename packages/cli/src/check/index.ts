import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readConfig } from '../config/io.js';
import { containerConfigPath, containerDir } from '../config/paths.js';
import {
  listApps,
  readLaunchConfig,
  type LaunchTarget,
} from '../config/launch-config.js';
import { solutionConfigToCreateOptions } from '../config/transform.js';
import {
  curatedServiceDeploy,
  curatedServiceExampleVolumes,
  runtimeSupportsReadyTimeout,
} from '../create/catalog.js';
import { RELAY_DIRNAME } from '../devcontainer/browser-bridge.js';
import { MARKER_BEGIN, MARKER_END } from '../briefing/markers.js';
import type { ResolvedService } from '../create/types.js';
import type { Palette } from '../util/format.js';

/**
 * `monoceros check <name>` — verifies, after the fact, the briefing rules
 * that can be verified at all.
 *
 * The briefing tells the in-container agent how to work in a workbench.
 * When it does not read it (see the shape decision in ADR 0039), the
 * result looks fine on the surface: files land at the wrong place, a
 * project never reaches the workspace file, a compose file carries
 * service config someone wrote from memory. The user only finds out by
 * reading the result closely.
 *
 * Some of those rules leave a trace on disk, so they can be checked
 * without an agent and without the user knowing what to look for:
 *
 *   - `workspace-registration` — a directory under `projects/` that is
 *     missing from `<name>.code-workspace`, so the editor never shows it.
 *   - `workspace-root` — project files at the workspace root instead of
 *     under `projects/`.
 *   - `compose-drift` — a project compose file whose service block
 *     differs from the catalog's `deploy.compose` (image tag, missing
 *     healthcheck, a required variable turned optional).
 *   - `launch-config` — a server without a launch-config entry, an entry
 *     on a port the container does not expose, one that pins the server to
 *     `127.0.0.1`, or a `readyTimeout` the pinned runtime is too old to
 *     honour.
 *
 * The language rule and "do not write service configuration from memory"
 * cannot be verified mechanically — that is why they sit in the first
 * lines of the briefing instead.
 *
 * Pure host-side filesystem read: no container, no docker, no agent. It
 * reports and changes nothing.
 */

export type CheckRule =
  | 'workspace-registration'
  | 'workspace-root'
  | 'compose-drift'
  | 'launch-config'
  | 'service-config'
  | 'ports'
  | 'briefing-markers';

export interface Finding {
  rule: CheckRule;
  /** Container-relative path the finding is about. */
  where: string;
  /** What is wrong, one sentence. */
  what: string;
  /** What to do about it, one sentence. */
  fix: string;
}

export interface CheckReport {
  name: string;
  findings: Finding[];
  /** What the run actually looked at, for the summary line. */
  scanned: { projects: number; composeFiles: number; apps: number };
}

export interface CheckOptions {
  home?: string;
}

/**
 * Entries at the container root that are not a misplaced project file:
 * the directories and files Monoceros owns, plus the tool caches that
 * legitimately land here.
 *
 * `.pnpm-store` is the second kind. pnpm keeps its store on the same
 * filesystem as the project, and in a dev container `/workspaces/<name>`
 * is the host bind while `$HOME` is the container's own layer — so pnpm
 * creates the store at the mount root, in every Node workbench where it
 * ran. Telling the builder to move it under `projects/` would be wrong
 * advice, every single time.
 */
const OWNED_ROOT_ENTRIES = new Set([
  '.devcontainer',
  '.monoceros',
  RELAY_DIRNAME,
  '.vscode',
  '.gitignore',
  '.git',
  '.DS_Store',
  '.pnpm-store',
  'projects',
  'home',
  'data',
  'logs',
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
]);

/** How deep under `projects/` we look for compose files and server markers. */
const SCAN_MAX_DEPTH = 4;

/** Directories never worth walking into. */
const SKIP_DIRS = new Set([
  'node_modules',
  'target',
  'dist',
  'build',
  'vendor',
]);

const COMPOSE_FILENAMES = new Set([
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
]);

export async function runCheck(
  name: string,
  opts: CheckOptions = {},
): Promise<CheckReport> {
  const root = containerDir(name, opts.home);
  try {
    await fs.access(root);
  } catch {
    throw new Error(
      `No materialized container at ${root}. Run \`monoceros apply ${name}\` first.`,
    );
  }

  const parsed = await readConfig(containerConfigPath(name, opts.home));
  const createOpts = solutionConfigToCreateOptions(parsed.config);
  const declaredPorts = createOpts.ports ?? [];

  const projects = await topLevelProjects(root);
  const findings: Finding[] = [];

  findings.push(...(await checkWorkspaceRegistration(root, name, projects)));
  findings.push(...(await checkWorkspaceRoot(root, name, createOpts.services)));

  const composeFiles = await findComposeFiles(root);
  for (const rel of composeFiles) {
    findings.push(...(await checkComposeFile(root, rel, createOpts.services)));
  }

  findings.push(...(await checkServiceConfigFiles(root, createOpts.services)));

  const apps = await listApps(name, opts.home);
  findings.push(
    ...(await checkLaunchConfigs(
      name,
      apps,
      declaredPorts,
      createOpts.runtimeVersion,
      opts.home,
    )),
  );
  findings.push(...(await checkUndeclaredServers(root, projects, apps)));
  findings.push(...(await checkPorts(name, apps, declaredPorts, opts.home)));
  findings.push(...(await checkBriefingMarkers(root)));

  return {
    name,
    findings,
    scanned: {
      projects: projects.length,
      composeFiles: composeFiles.length,
      apps: apps.length,
    },
  };
}

/** Directory names directly under `projects/` (dotted entries skipped). */
async function topLevelProjects(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, 'projects'), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/**
 * Every directory directly under `projects/` needs a `folders` entry in
 * `<name>.code-workspace`; without it VS Code (opened on the host from
 * the workspace file) simply does not list the project. Clones are
 * registered by the apply, so what shows up here is what an agent
 * scaffolded and did not register.
 */
async function checkWorkspaceRegistration(
  root: string,
  name: string,
  projects: readonly string[],
): Promise<Finding[]> {
  const rel = `${name}.code-workspace`;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(root, rel), 'utf8');
  } catch {
    return [
      {
        rule: 'workspace-registration',
        where: rel,
        what: 'The workspace file is missing, so no project shows up in the editor.',
        fix: `Run \`monoceros apply ${name}\` to write it again.`,
      },
    ];
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return [
      {
        rule: 'workspace-registration',
        where: rel,
        what: `The workspace file is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
        fix: 'Fix the JSON by hand; the apply merges into this file and cannot repair it.',
      },
    ];
  }
  const folders = (doc as { folders?: unknown }).folders;
  const registered = new Set(
    (Array.isArray(folders) ? folders : [])
      .map((f) =>
        f && typeof f === 'object' ? (f as { path?: unknown }).path : undefined,
      )
      .filter((p): p is string => typeof p === 'string'),
  );
  const out: Finding[] = [];
  for (const project of projects) {
    if (registered.has(`projects/${project}`)) continue;
    out.push({
      rule: 'workspace-registration',
      where: `projects/${project}`,
      what: `Not listed in ${rel}, so it does not show up in the editor.`,
      fix: `Add { "path": "projects/${project}", "name": "${project}" } to the \`folders\` array.`,
    });
  }
  return out;
}

/**
 * The workspace root holds Monoceros-managed directories, not code.
 * Anything else there is a project file the agent put one level too
 * high. Host source directories the yml's service volumes point at are
 * legitimate, so they count as owned.
 */
async function checkWorkspaceRoot(
  root: string,
  name: string,
  services: readonly ResolvedService[],
): Promise<Finding[]> {
  const owned = new Set(OWNED_ROOT_ENTRIES);
  owned.add(`${name}.code-workspace`);
  for (const svc of services) {
    for (const spec of svc.volumes) {
      const source = spec.split(':')[0] ?? '';
      const top = source.split('/')[0];
      if (top && !path.isAbsolute(source)) owned.add(top);
    }
  }

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Finding[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (owned.has(entry.name)) continue;
    out.push({
      rule: 'workspace-root',
      where: entry.name,
      what: `Sits at the workspace root, which is Monoceros-managed, not a place for project files.`,
      fix: `Move it under \`projects/<app>/\` and register that project in ${name}.code-workspace.`,
    });
  }
  return out;
}

/**
 * A service config file the agent wrote that nothing mounts. The trap is
 * structural: the agent can write `projects/<app>/keycloak/realm.json`
 * from inside, but the bind that feeds it to the service lives in the yml
 * on the host, which it cannot edit. The file then sits there and the
 * service never sees it.
 *
 * Deliberately narrow, and only where the answer is unambiguous: the
 * descriptor's own `exampleVolumes` give the standard directory
 * (`projects/<app>/keycloak/`), we look at the `*.json` files in exactly
 * that directory, and peek inside to say what the file is. A file the
 * agent put somewhere else is out of scope - guessing at any JSON under
 * `projects/` would report more than it finds.
 */
export interface UnmountedServiceConfig {
  /** Compose service the file was written for. */
  service: string;
  /** Project it belongs to (the `<app>` of the descriptor's pattern). */
  project: string;
  /** Container-relative path of the file nothing mounts. */
  file: string;
  /** The volume spec that would feed it to the service. */
  mountSpec: string;
  /** What the file says it is, read from the file. */
  describes: string;
}

/**
 * The detector behind the `service-config` rule, shared with `monoceros
 * status`: status marks the service, check spells the finding out, and
 * both work from this one pass so they can never disagree.
 */
export async function findUnmountedServiceConfigs(
  root: string,
  services: readonly ResolvedService[],
): Promise<UnmountedServiceConfig[]> {
  const projects = await topLevelProjects(root);
  const out: UnmountedServiceConfig[] = [];
  for (const svc of services) {
    // Directories the descriptor points at, `<app>` still in them.
    const dirs = new Set(
      curatedServiceExampleVolumes(svc.name)
        .map((spec) => spec.split(':')[0] ?? '')
        .filter((source) => source.endsWith('.json'))
        .map((source) => source.slice(0, source.lastIndexOf('/'))),
    );
    const mounted = new Set(
      svc.volumes.map((spec) => spec.split(':')[0] ?? ''),
    );
    for (const project of projects) {
      for (const pattern of dirs) {
        const rel = pattern.replace('<app>', project);
        let entries;
        try {
          entries = await fs.readdir(path.join(root, rel), {
            withFileTypes: true,
          });
        } catch {
          continue; // the standard directory does not exist here
        }
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
          const fileRel = `${rel}/${entry.name}`;
          if (mounted.has(fileRel)) continue;
          out.push({
            service: svc.name,
            project,
            file: fileRel,
            mountSpec: `${fileRel}:${mountTargetFor(svc.name, project, pattern)}`,
            describes: await describeJson(path.join(root, fileRel)),
          });
        }
      }
    }
  }
  return out;
}

async function checkServiceConfigFiles(
  root: string,
  services: readonly ResolvedService[],
): Promise<Finding[]> {
  const found = await findUnmountedServiceConfigs(root, services);
  return found.map((f) => ({
    rule: 'service-config' as const,
    where: f.file,
    what: `${f.describes}, but no volume in the yml mounts it, so ${f.service} never reads it.`,
    fix: `Add \`${f.mountSpec}\` to the \`${f.service}\` service's \`volumes:\` in the yml, then re-apply.`,
  }));
}

/**
 * What the file is, read from the file itself rather than from its name:
 * a Keycloak realm export names its realm, and quoting it makes the
 * finding checkable at a glance.
 */
async function describeJson(file: string): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    const realm =
      parsed && typeof parsed === 'object'
        ? (parsed as { realm?: unknown }).realm
        : undefined;
    if (typeof realm === 'string' && realm.length > 0) {
      return `Declares the realm \`${realm}\``;
    }
  } catch {
    // Unreadable or not JSON after all — fall through to the plain wording.
  }
  return 'Sits at the standard location for this service';
}

/**
 * The container path the descriptor's example maps this file to, with
 * `<app>` filled in — so the fix line is a volume spec the builder can
 * paste rather than a shape to work out.
 */
function mountTargetFor(
  service: string,
  project: string,
  sourceDir: string,
): string {
  const example = curatedServiceExampleVolumes(service).find((spec) =>
    (spec.split(':')[0] ?? '').startsWith(sourceDir),
  );
  const target = example?.split(':').slice(1).join(':') ?? '';
  return target.replaceAll('<app>', project);
}

/** Compose files under `projects/`, container-relative, sorted. */
async function findComposeFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(path.join(root, 'projects'), 'projects', 0, async (dir, rel) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && COMPOSE_FILENAMES.has(e.name)) {
        out.push(`${rel}/${e.name}`);
      }
    }
  });
  return out.sort();
}

async function walk(
  dir: string,
  rel: string,
  depth: number,
  visit: (dir: string, rel: string) => Promise<void>,
): Promise<void> {
  await visit(dir, rel);
  if (depth >= SCAN_MAX_DEPTH) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    await walk(path.join(dir, e.name), `${rel}/${e.name}`, depth + 1, visit);
  }
}

/**
 * Compare a project's compose services against the catalog blocks the
 * briefing hands over in `.monoceros/deploy.md`. Only service keys that
 * name a catalog service are compared — a block copied under a different
 * key is out of reach, and guessing by image would flag more than it
 * finds.
 *
 * Three drifts, the ones the live test produced: a different image tag,
 * a dropped healthcheck, and a required variable turned optional (a
 * default, or a hardcoded value, instead of `${VAR:?…}`).
 */
async function checkComposeFile(
  root: string,
  rel: string,
  services: readonly ResolvedService[],
): Promise<Finding[]> {
  let doc: unknown;
  try {
    doc = parseYaml(await fs.readFile(path.join(root, rel), 'utf8'));
  } catch (err) {
    return [
      {
        rule: 'compose-drift',
        where: rel,
        what: `Not parseable as YAML (${err instanceof Error ? err.message : String(err)}).`,
        fix: 'Fix the syntax, then check again.',
      },
    ];
  }
  const composeServices = (doc as { services?: unknown })?.services;
  if (!composeServices || typeof composeServices !== 'object') return [];

  const out: Finding[] = [];
  for (const [key, blockRaw] of Object.entries(
    composeServices as Record<string, unknown>,
  )) {
    const catalogText = curatedServiceDeploy(key);
    if (!catalogText) continue;
    if (!blockRaw || typeof blockRaw !== 'object') continue;
    const block = blockRaw as Record<string, unknown>;
    let expected: Record<string, unknown>;
    try {
      expected = (parseYaml(catalogText) ?? {}) as Record<string, unknown>;
    } catch {
      continue;
    }

    // The container's own image wins over the catalog default, because
    // that is the tag deploy.md printed for this service.
    const configured = services.find((s) => s.name === key)?.image;
    const expectedImage = configured ?? expected.image;
    if (
      typeof expectedImage === 'string' &&
      typeof block.image === 'string' &&
      block.image !== expectedImage
    ) {
      out.push({
        rule: 'compose-drift',
        where: `${rel} → services.${key}`,
        what: `image is \`${block.image}\`, the block in .monoceros/deploy.md has \`${expectedImage}\`.`,
        fix: `Use \`${expectedImage}\`, or say in the repo why this pipeline needs a different version.`,
      });
    }

    if (expected.healthcheck && !block.healthcheck) {
      out.push({
        rule: 'compose-drift',
        where: `${rel} → services.${key}`,
        what: 'No healthcheck, so anything depending on it starts before it is ready.',
        fix: `Copy the \`healthcheck\` block for ${key} from .monoceros/deploy.md.`,
      });
    }

    const expectedEnv = envMap(expected.environment);
    const actualEnv = envMap(block.environment);
    for (const [envKey, expectedValue] of Object.entries(expectedEnv)) {
      const required = /\$\{([A-Za-z_][A-Za-z0-9_]*):\?/.exec(expectedValue);
      if (!required) continue;
      const variable = required[1]!;
      const actualValue = actualEnv[envKey];
      if (actualValue === undefined) {
        out.push({
          rule: 'compose-drift',
          where: `${rel} → services.${key}`,
          what: `Does not set \`${envKey}\`, which the block in .monoceros/deploy.md requires.`,
          fix: `Add \`${envKey}: \${${variable}:?…}\` and provide the value as a pipeline secret.`,
        });
        continue;
      }
      // What the catalog block requires is a value that FAILS FAST, not
      // one that carries the catalog's variable name: a project reading
      // `${PG_PASSWORD:?…}` is doing exactly the right thing under its
      // own name.
      if (FAIL_FAST_VAR.test(actualValue)) continue;
      // Two mistakes remain, and neither is about the name. A variable
      // without `:?` starts the service on an empty value when the
      // pipeline forgets the secret; a literal value ships the value in
      // the repo, and there the catalog's variable is the better hint.
      const own = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$/.exec(
        actualValue.trim(),
      );
      out.push(
        own
          ? {
              rule: 'compose-drift',
              where: `${rel} → services.${key}`,
              what: `\`${envKey}\` reads \`${actualValue}\`, which has no \`:?\` — a forgotten pipeline secret starts the service on an empty value instead of failing.`,
              fix: `Write \`${envKey}: \${${own[1]}:?…}\` (your own variable name is fine, the \`:?\` is what matters).`,
            }
          : {
              rule: 'compose-drift',
              where: `${rel} → services.${key}`,
              what: `\`${envKey}\` is the literal \`${actualValue}\`, so the value lives in the repo instead of in a pipeline secret.`,
              fix: `Write \`${envKey}: \${${variable}:?…}\` and provide the value as a pipeline secret.`,
            },
      );
    }
  }
  return out;
}

/**
 * A compose value that refuses to start without its variable:
 * `${VAR:?…}`. Any variable name counts — the requirement is the
 * fail-fast, not the catalog's spelling.
 */
const FAIL_FAST_VAR = /\$\{[A-Za-z_][A-Za-z0-9_]*:\?/;

/** Compose `environment:` as a map, from either the map or the `K=V` list form. */
function envMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const idx = item.indexOf('=');
      if (idx <= 0) continue;
      out[item.slice(0, idx)] = item.slice(idx + 1);
    }
    return out;
  }
  if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      out[k] = String(v);
    }
  }
  return out;
}

/**
 * The launch-config entries themselves: a port the container does not
 * expose is unreachable through the proxy, and a server pinned to
 * `127.0.0.1` is unreachable even on an exposed port.
 */
async function checkLaunchConfigs(
  name: string,
  apps: readonly string[],
  declaredPorts: readonly number[],
  runtimeVersion?: string,
  home?: string,
): Promise<Finding[]> {
  // A `readyTimeout` the pinned runtime does not understand is dropped in
  // silence, and the target keeps the 20s window it was written to escape.
  // Only decidable on a pinned runtime; unpinned resolves to the major tag,
  // whose runner may well support it.
  const readyTimeoutIgnored =
    runtimeVersion !== undefined &&
    !runtimeSupportsReadyTimeout(runtimeVersion);
  const out: Finding[] = [];
  for (const app of apps) {
    const rel = `projects/${app}/.monoceros/launch.json`;
    let config;
    try {
      config = await readLaunchConfig(name, app, home);
    } catch (err) {
      out.push({
        rule: 'launch-config',
        where: rel,
        what: `Unusable (${err instanceof Error ? err.message : String(err)}).`,
        fix: 'Fix the file; `monoceros start` reads the same parser and fails the same way.',
      });
      continue;
    }
    if (!config) continue;
    for (const target of config.configurations) {
      if (
        typeof target.port === 'number' &&
        !declaredPorts.includes(target.port)
      ) {
        out.push({
          rule: 'launch-config',
          where: `${rel} → ${target.name}`,
          what: `Port ${target.port} is not exposed on the container, so the proxy cannot reach it.`,
          // `add-port` syncs the routes to the proxy itself, so this needs
          // no apply (ADR 0007).
          fix: `Run \`monoceros add-port ${name} ${target.port}\`, or move the target to an exposed port.`,
        });
      }
      const pinned = LOOPBACK_BINDING.exec(target.command);
      if (pinned) {
        out.push({
          rule: 'launch-config',
          where: `${rel} → ${target.name}`,
          what: `The start command binds \`${pinned[0]}\`, so only the container itself can reach the server.`,
          fix: 'Bind `0.0.0.0` instead.',
        });
      }
      if (readyTimeoutIgnored && typeof target.readyTimeout === 'number') {
        out.push({
          rule: 'launch-config',
          where: `${rel} → ${target.name}`,
          what: `\`readyTimeout: ${target.readyTimeout}\` is ignored by runtime ${runtimeVersion}, so the target still fails after 20s.`,
          fix: `Run \`monoceros upgrade ${name}\` to move to a runtime that honours it.`,
        });
      }
      out.push(...(await checkTargetCommand(name, app, rel, target, home)));
    }
  }
  return out;
}

/**
 * Can this target even start? Two things are decidable without knowing a
 * single framework:
 *
 *   - a `cwd` that does not exist;
 *   - a package-manager script the project does not define. The agent
 *     writes `npm run dev` where the script is called `start` often
 *     enough, and today that surfaces as an npm error out of the
 *     container on the first `monoceros start`.
 *
 * Everything else is left alone. `./mvnw spring-boot:run`, `python
 * manage.py runserver`, `go run .` would each need their own tooling
 * knowledge, and a wrong finding costs more than a missing one.
 */
async function checkTargetCommand(
  name: string,
  app: string,
  rel: string,
  target: LaunchTarget,
  home?: string,
): Promise<Finding[]> {
  const appDir = path.join(containerDir(name, home), 'projects', app);
  const out: Finding[] = [];

  const cwd = target.cwd?.trim();
  if (cwd && cwd !== '.') {
    try {
      const stat = await fs.stat(path.join(appDir, cwd));
      if (!stat.isDirectory()) throw new Error('not a directory');
    } catch {
      out.push({
        rule: 'launch-config',
        where: `${rel} → ${target.name}`,
        what: `\`cwd: ${cwd}\` does not exist under projects/${app}/, so the target cannot start.`,
        fix: 'Point `cwd` at a directory that exists, relative to the app directory.',
      });
      return out; // no point looking for a package.json under a missing cwd
    }
  }

  const script = packageScriptOf(target.command);
  if (!script) return out;
  const pkgPath = path.join(appDir, cwd ?? '.', 'package.json');
  let scripts: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    const raw =
      parsed && typeof parsed === 'object'
        ? (parsed as { scripts?: unknown }).scripts
        : undefined;
    if (raw && typeof raw === 'object') {
      scripts = raw as Record<string, unknown>;
    }
  } catch {
    return out; // no package.json to check against
  }
  if (scripts && typeof scripts[script] !== 'string') {
    const have = Object.keys(scripts);
    out.push({
      rule: 'launch-config',
      where: `${rel} → ${target.name}`,
      what: `Runs the \`${script}\` script, which ${path.posix.join(`projects/${app}`, cwd ?? '.', 'package.json')} does not define.`,
      fix:
        have.length > 0
          ? `Use one of its scripts (${have.join(', ')}), or add \`${script}\` to the package.`
          : `Add a \`${script}\` script to the package.`,
    });
  }
  return out;
}

/**
 * The script name a package-manager command runs, or `undefined` when the
 * command is not one we can resolve. Deliberately gives up on anything
 * ambiguous:
 *
 *   - a compound command (`cd web && npm run dev`) - which package.json
 *     would even apply;
 *   - a workspace flag (`npm run dev --workspace @acme/backend`) - the
 *     script lives in that workspace's package, not this one, and
 *     resolving the workspace globs to find it is more guessing than the
 *     finding is worth;
 *   - a package-manager subcommand that is not a script (`npm ci`,
 *     `pnpm dlx …`).
 *
 * Leading environment assignments (`PORT=3000 npm run dev`) are skipped,
 * since they say nothing about the script.
 */
function packageScriptOf(command: string): string | undefined {
  if (/[&;|]/.test(command)) return undefined;
  if (/(^|\s)(--workspaces?|-w)(\s|=)/.test(command)) return undefined;
  const tokens = command.trim().split(/\s+/);
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) {
    tokens.shift();
  }
  const manager = tokens.shift();
  if (!manager || !['npm', 'pnpm', 'yarn'].includes(manager)) return undefined;
  let candidate = tokens.shift();
  if (candidate === 'run') candidate = tokens.shift();
  if (!candidate || candidate.startsWith('-')) return undefined;
  if (NON_SCRIPT_SUBCOMMANDS.has(candidate)) return undefined;
  return candidate;
}

/**
 * Package-manager subcommands that are not scripts. `start` and `test`
 * are deliberately absent: both run the same-named script when the
 * package defines one, and that is exactly what we are checking.
 */
const NON_SCRIPT_SUBCOMMANDS = new Set([
  'install',
  'i',
  'ci',
  'add',
  'remove',
  'rm',
  'update',
  'up',
  'exec',
  'dlx',
  'x',
  'create',
  'init',
  'link',
  'unlink',
  'publish',
  'pack',
  'audit',
  'why',
  'list',
  'ls',
  'outdated',
  'config',
  'cache',
  'store',
  'dedupe',
  'prune',
  'rebuild',
  'licenses',
]);

/**
 * Ports across the whole workbench, which no single launch config can
 * see: two targets on the same port cannot both come up (the second
 * fails to bind, and `start` waits for a port that is already answering
 * from the wrong process), and an exposed port that nothing declares is
 * a route into the void.
 *
 * The dead-route half only runs once at least one app declares a launch
 * config. On a workbench where the apps are still to be built, every
 * exposed port would show up, and that is the normal state right after
 * `init --with-ports`.
 */
async function checkPorts(
  name: string,
  apps: readonly string[],
  declaredPorts: readonly number[],
  home?: string,
): Promise<Finding[]> {
  const byPort = new Map<number, string[]>();
  let anyConfig = false;
  for (const app of apps) {
    let config;
    try {
      config = await readLaunchConfig(name, app, home);
    } catch {
      continue; // reported by checkLaunchConfigs
    }
    if (!config) continue;
    anyConfig = true;
    for (const target of config.configurations) {
      if (typeof target.port !== 'number') continue;
      const holders = byPort.get(target.port) ?? [];
      holders.push(`${app} → ${target.name}`);
      byPort.set(target.port, holders);
    }
  }

  const out: Finding[] = [];
  for (const [port, holders] of [...byPort].sort((a, b) => a[0] - b[0])) {
    if (holders.length < 2) continue;
    out.push({
      rule: 'ports',
      where: `port ${port}`,
      what: `Claimed by ${holders.length} targets (${holders.join(', ')}), and only one of them can bind it.`,
      fix: 'Give each server its own port, and expose the new one.',
    });
  }
  if (anyConfig) {
    for (const port of declaredPorts) {
      if (byPort.has(port)) continue;
      out.push({
        rule: 'ports',
        where: `port ${port}`,
        what: `Exposed in the yml, but no launch config declares it, so the route answers nothing.`,
        fix: `Point a target at it, or drop it with \`monoceros remove-port ${name} ${port}\`.`,
      });
    }
  }
  return out;
}

/**
 * The marker pair in `AGENTS.md` / `CLAUDE.md`. Without it, apply treats
 * the file as Monoceros-owned and rewrites it whole, so notes the builder
 * added to it are gone on the next apply - silently, which is the reason
 * this is worth a finding at all.
 */
async function checkBriefingMarkers(root: string): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    let content: string;
    try {
      content = await fs.readFile(path.join(root, file), 'utf8');
    } catch {
      continue; // a workbench applied before the briefing existed
    }
    if (
      content.includes(MARKER_BEGIN) &&
      content.includes(MARKER_END) &&
      content.indexOf(MARKER_BEGIN) < content.indexOf(MARKER_END)
    ) {
      continue;
    }
    out.push({
      rule: 'briefing-markers',
      where: file,
      what: 'The Monoceros marker pair is gone, so the next apply rewrites this file whole and anything you added to it is lost.',
      fix: `Move your own notes out of the way, then let \`monoceros apply\` write the file again and keep your notes below \`${MARKER_END}\`.`,
    });
  }
  return out;
}

/**
 * A start command that pins the listen address to the loopback
 * interface. Matches the flag forms the common dev servers use; a bare
 * `127.0.0.1` somewhere in the command (a database URL, a curl) is not
 * enough, or every backend would be flagged.
 */
const LOOPBACK_BINDING =
  /(?:--host[= ]|--hostname[= ]|-b[= ]|--bind[= ]|--address[= ]|HOST=|server\.address=)(?:127\.0\.0\.1|localhost)/;

/**
 * A project that serves a port but declares no launch config: it starts
 * in the foreground and dies with the agent's session. Only strong
 * markers count (a dev/serve script, Django's `manage.py`, a Spring Boot
 * build) so a library project is not flagged for having a `start`
 * script.
 */
async function checkUndeclaredServers(
  root: string,
  projects: readonly string[],
  apps: readonly string[],
): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const project of projects) {
    // Covered when the project itself, or anything below it, declares one.
    if (apps.some((a) => a === project || a.startsWith(`${project}/`)))
      continue;
    const marker = await serverMarker(
      path.join(root, 'projects', project),
      `projects/${project}`,
    );
    if (!marker) continue;
    out.push({
      rule: 'launch-config',
      where: marker.where,
      what: `${marker.why}, but no \`.monoceros/launch.json\` declares how to start it.`,
      fix: `Add \`projects/${project}/.monoceros/launch.json\` with a target per server, then start it with \`monoceros-ctl start ${project}\`.`,
    });
  }
  return out;
}

/**
 * Look for a server marker in a project directory and one level below
 * it (the `backend/` + `frontend/` layout), and report the first hit.
 */
async function serverMarker(
  dir: string,
  rel: string,
  depth = 0,
): Promise<{ where: string; why: string } | null> {
  const pkg = await readIfPresent(path.join(dir, 'package.json'));
  if (pkg) {
    try {
      const scripts = (JSON.parse(pkg) as { scripts?: Record<string, unknown> })
        .scripts;
      const script = ['dev', 'serve', 'start:dev'].find(
        (s) => typeof scripts?.[s] === 'string',
      );
      if (script) {
        return {
          where: `${rel}/package.json`,
          why: `Has a \`${script}\` script, so it serves something`,
        };
      }
    } catch {
      // Malformed package.json is not this check's business.
    }
  }
  if (await readIfPresent(path.join(dir, 'manage.py'))) {
    return {
      where: `${rel}/manage.py`,
      why: 'A Django project, so it serves something',
    };
  }
  for (const build of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
    const content = await readIfPresent(path.join(dir, build));
    if (content?.includes('spring-boot')) {
      return {
        where: `${rel}/${build}`,
        why: 'A Spring Boot project, so it serves something',
      };
    }
  }
  if (depth > 0) return null;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const nested = await serverMarker(
      path.join(dir, e.name),
      `${rel}/${e.name}`,
      depth + 1,
    );
    if (nested) return nested;
  }
  return null;
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Human-readable label per rule, for the report headings. */
const RULE_LABEL: Record<CheckRule, string> = {
  'workspace-registration': 'Workspace registration',
  'workspace-root': 'Files at the workspace root',
  'compose-drift': 'Compose drift',
  'service-config': 'Service config nothing mounts',
  'launch-config': 'Launch config',
  ports: 'Ports',
  'briefing-markers': 'Briefing markers',
};

/**
 * Render the report: findings grouped by rule, each with what is wrong
 * and what to do. The summary line names what was looked at, so an empty
 * report does not read as "nothing was checked".
 */
export function renderCheckReport(report: CheckReport, p: Palette): string {
  const { projects, composeFiles, apps } = report.scanned;
  const scanned = `${count(projects, 'project')}, ${count(composeFiles, 'compose file')}, ${count(apps, 'launch config')}`;

  if (report.findings.length === 0) {
    return [
      p.sectionLine(`Briefing check: ${report.name}`),
      '',
      `${p.green('✓')} Nothing to report. ${p.dim(`Checked ${scanned}.`)}`,
    ].join('\n');
  }

  const out = [p.sectionLine(`Briefing check: ${report.name}`), ''];
  for (const rule of Object.keys(RULE_LABEL) as CheckRule[]) {
    const group = report.findings.filter((f) => f.rule === rule);
    if (group.length === 0) continue;
    out.push(p.bold(RULE_LABEL[rule]));
    // Several findings on the same place (a compose block usually drifts in
    // more than one way) share one header line instead of repeating the path.
    let lastWhere = '';
    for (const f of group) {
      if (f.where !== lastWhere) {
        out.push(`  ${p.yellow('⚠')} ${p.cyan(f.where)}`);
        lastWhere = f.where;
      }
      out.push(`      ${f.what}`);
      out.push(`      ${p.dim(`→ ${f.fix}`)}`);
    }
    out.push('');
  }
  out.push(
    `${count(report.findings.length, 'finding')} in ${scanned}. ${p.dim('Nothing was changed.')}`,
  );
  return out.join('\n');
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
