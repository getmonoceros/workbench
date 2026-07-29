import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readConfig } from '../config/io.js';
import { containerConfigPath, containerDir } from '../config/paths.js';
import { listApps, readLaunchConfig } from '../config/launch-config.js';
import { solutionConfigToCreateOptions } from '../config/transform.js';
import { curatedServiceDeploy } from '../create/catalog.js';
import { RELAY_DIRNAME } from '../devcontainer/browser-bridge.js';
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
 *     on a port the container does not expose, or one that pins the
 *     server to `127.0.0.1`.
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
  | 'launch-config';

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

/** Entries at the container root that Monoceros itself owns. */
const OWNED_ROOT_ENTRIES = new Set([
  '.devcontainer',
  '.monoceros',
  RELAY_DIRNAME,
  '.vscode',
  '.gitignore',
  '.git',
  '.DS_Store',
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

  const apps = await listApps(name, opts.home);
  findings.push(
    ...(await checkLaunchConfigs(name, apps, declaredPorts, opts.home)),
  );
  findings.push(...(await checkUndeclaredServers(root, projects, apps)));

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
      if (!actualValue.includes(`\${${variable}:?`)) {
        out.push({
          rule: 'compose-drift',
          where: `${rel} → services.${key}`,
          what: `\`${envKey}\` is \`${actualValue}\` instead of \`\${${variable}:?…}\`, so the pipeline starts with a value nobody set on purpose.`,
          fix: `Write \`${envKey}: \${${variable}:?…}\` and provide the value as a pipeline secret.`,
        });
      }
    }
  }
  return out;
}

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
  home?: string,
): Promise<Finding[]> {
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
          fix: `Run \`monoceros add-port ${name} ${target.port}\` and \`monoceros apply ${name}\`, or move the target to an exposed port.`,
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
    }
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
  'launch-config': 'Launch config',
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
