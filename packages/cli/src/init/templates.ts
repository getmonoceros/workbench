import { existsSync, readdirSync, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  monocerosHome as defaultMonocerosHome,
  userWorkbenchTemplatesDir,
  workbenchTemplatesDir,
} from '../config/paths.js';
import { DEFAULT_RUNTIME_VERSION } from '../create/catalog.js';

/**
 * Workbench templates: prepared ymls `monoceros init --template=<name>`
 * starts from.
 *
 * A template exists for what the `--with-*` flags cannot express. A plugin is
 * a nested block under its feature entry, and options marked `surface: yml`
 * (the permission mode, the `twg`/`rovodev`/`forge` switches) live in the file
 * too. The flags carry neither, so a setup that needs them would otherwise be
 * a docs page the builder retypes. The template is that setup as a yml, and
 * what lands in `container-configs/` is an ordinary config file, edited and
 * re-applied like any other.
 *
 * Two placeholders are substituted on init, nothing else: the container name
 * and the runtime version. Keeping the file a real, complete yml is the
 * point: it can be read, diffed and hand-edited in the repo, and what the
 * builder gets is what they saw.
 *
 * Two places hold them: `<MONOCEROS_HOME>/templates/workbenches/` first, then
 * the ones shipped with the CLI. A builder's own template therefore wins over
 * a shipped one of the same name, which is what makes the shipped set a
 * starting point rather than a fixed list. There is nothing to write for this:
 * a template is a workbench yml, so the way to make one is to copy a config
 * that works, put the two placeholders back in, and drop it in that directory.
 */
const NAME_PLACEHOLDER = /__MONOCEROS_NAME__/g;
const RUNTIME_PLACEHOLDER = /__MONOCEROS_RUNTIME_VERSION__/g;

/**
 * The directories a template is looked for in, in order. The builder's own
 * first, then the shipped set.
 */
export function workbenchTemplateDirs(opts: TemplateLookup = {}): string[] {
  const dirs: string[] = [];
  const user = opts.userDir ?? safeUserTemplatesDir(opts.monocerosHome);
  if (user) dirs.push(user);
  const bundled = opts.bundledDir ?? safeTemplatesDir();
  if (bundled) dirs.push(bundled);
  return dirs;
}

export interface TemplateLookup {
  /** Override the builder's template dir. Tests inject one. */
  userDir?: string | undefined;
  /** Override the shipped template dir. Tests inject one. */
  bundledDir?: string | undefined;
  /** Override the resolved MONOCEROS_HOME the user dir is derived from. */
  monocerosHome?: string | undefined;
}

/**
 * Template names from both directories, sorted and deduplicated. A name in
 * both appears once, and it is the builder's file that `renderWorkbenchTemplate`
 * will read.
 */
export function listWorkbenchTemplates(opts: TemplateLookup = {}): string[] {
  const names = new Set<string>();
  for (const dir of workbenchTemplateDirs(opts)) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.yml')) names.add(file.slice(0, -'.yml'.length));
    }
  }
  return [...names].sort();
}

/**
 * Read a template and substitute the two placeholders. Throws with the
 * available names when the template does not exist, the same shape as an
 * unknown `--with-features` value.
 */
export async function renderWorkbenchTemplate(
  template: string,
  containerName: string,
  opts: TemplateLookup = {},
): Promise<string> {
  // Reject a name that would escape a template dir before touching the
  // filesystem, the value comes straight off the command line.
  const traverses =
    template.includes('/') ||
    template.includes('\\') ||
    template.includes('..');
  const file = traverses
    ? undefined
    : workbenchTemplateDirs(opts)
        .map((dir) => path.join(dir, `${template}.yml`))
        .find((candidate) => existsSync(candidate));
  if (!file) {
    const known = listWorkbenchTemplates(opts).join(', ') || '(none)';
    throw new Error(
      `Unknown template: ${JSON.stringify(template)}. Available: ${known}.`,
    );
  }
  const text = await fs.readFile(file, 'utf8');
  return text
    .replace(NAME_PLACEHOLDER, containerName)
    .replace(RUNTIME_PLACEHOLDER, DEFAULT_RUNTIME_VERSION);
}

/**
 * The templates dir, or undefined when the CLI-bundle root cannot be
 * resolved. Only the listing swallows that: completion and error messages ask
 * for the names outside a workbench checkout too, and an empty list there is
 * better than a crash.
 */
function safeTemplatesDir(): string | undefined {
  try {
    return workbenchTemplatesDir();
  } catch {
    return undefined;
  }
}

/**
 * The builder's template dir, or undefined when MONOCEROS_HOME cannot be
 * resolved. Same reasoning as above: completion asks for the names in places
 * where a home may not exist yet.
 */
function safeUserTemplatesDir(home?: string): string | undefined {
  try {
    return userWorkbenchTemplatesDir(home ?? defaultMonocerosHome());
  } catch {
    return undefined;
  }
}
