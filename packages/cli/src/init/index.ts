import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import { Scalar } from 'yaml';
import { parseConfig, stringifyConfig } from '../config/io.js';
import {
  configPath,
  configsDir,
  templatePath,
  templatesDir,
  workbenchRoot as defaultWorkbenchRoot,
} from '../config/paths.js';
import { REGEX } from '../config/schema.js';

/**
 * Copies a shipped template from `templates/yml/<template>.yml` to
 * `.local/container-configs/<name>.yml`, rewriting the `name:` field
 * to `<name>` and preserving every comment in the template.
 *
 * Errors loudly if:
 *   - the requested template doesn't exist
 *   - the target config already exists (idempotency: builder must
 *     delete it manually before re-init'ing — protects hand-edits)
 *   - the chosen name is shape-invalid
 *   - the template itself fails to validate (catches PR-time
 *     regressions in shipped templates that the templates.test.ts
 *     suite already covers, but a runtime check is cheap and gives
 *     a clear error)
 */

export interface RunInitOptions {
  template: string;
  name: string;
  /** Optional override of the workbench root. Tests inject a tmpdir. */
  workbenchRoot?: string;
  logger?: {
    success: (msg: string) => void;
    info: (msg: string) => void;
  };
}

export interface RunInitResult {
  templatePath: string;
  configPath: string;
}

export async function runInit(opts: RunInitOptions): Promise<RunInitResult> {
  const root = opts.workbenchRoot ?? defaultWorkbenchRoot();
  const logger = opts.logger ?? {
    success: (msg) => consola.success(msg),
    info: (msg) => consola.info(msg),
  };

  if (!REGEX.solutionName.test(opts.name)) {
    throw new Error(
      `Invalid config name: ${JSON.stringify(opts.name)}. Use letters, digits, '.', '_' or '-'.`,
    );
  }
  if (!REGEX.solutionName.test(opts.template)) {
    throw new Error(
      `Invalid template name: ${JSON.stringify(opts.template)}. Use letters, digits, '.', '_' or '-'.`,
    );
  }

  const src = templatePath(opts.template, root);
  if (!existsSync(src)) {
    const dir = templatesDir(root);
    const available = existsSync(dir)
      ? (await fs.readdir(dir))
          .filter((f) => f.endsWith('.yml'))
          .map((f) => f.replace(/\.yml$/, ''))
          .sort()
      : [];
    const hint =
      available.length > 0
        ? ` Available: ${available.join(', ')}.`
        : ' No templates installed.';
    throw new Error(`Unknown template: ${opts.template}.${hint}`);
  }

  const dest = configPath(opts.name, root);
  if (existsSync(dest)) {
    throw new Error(
      `Config already exists: ${dest}. Delete it manually before re-running \`monoceros init\` — this protects any hand-edits.`,
    );
  }

  const text = await fs.readFile(src, 'utf8');
  // Re-parse (instead of plain copy) so we catch a malformed template
  // at init time with a clear error, *and* so we can rewrite `name`
  // through the AST — preserves the comment block and surrounding
  // structure verbatim.
  const parsed = parseConfig(text, src);
  const nameNode = parsed.doc.get('name', true);
  if (nameNode instanceof Scalar) {
    nameNode.value = opts.name;
  } else {
    // Defensive: the template lacks a scalar `name` (e.g. someone
    // wrote `name: [demo]`). Schema parse would already have thrown,
    // but keep the branch so a future schema change doesn't silently
    // skip the rename.
    parsed.doc.set('name', opts.name);
  }

  await fs.mkdir(configsDir(root), { recursive: true });
  await fs.writeFile(dest, stringifyConfig(parsed.doc), 'utf8');

  logger.success(
    `Copied template '${opts.template}' to ${path.relative(root, dest)}`,
  );
  logger.info(
    `Edit the file, then run \`monoceros apply ${opts.name} <dir>\` to materialize a dev-container.`,
  );

  return { templatePath: src, configPath: dest };
}
