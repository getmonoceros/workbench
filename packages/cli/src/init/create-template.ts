import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  containerConfigPath,
  monocerosHome as defaultMonocerosHome,
  userWorkbenchTemplatesDir,
} from '../config/paths.js';
import { wrapToComment } from './feature-doc.js';
import { templateDescription } from './templates.js';

/**
 * `monoceros create-template <containername> <template>` (#142): a workbench
 * that works, turned into a template (ADR 0057).
 *
 * Every place the workbench's name stands as a word becomes
 * `__MONOCEROS_NAME__`: the top-level `name:` and the comments init and the
 * add-* commands write (`monoceros apply shop`, `shop.env`,
 * `shop-3000.localhost`). Other values stay as they are, so a repository
 * URL like `…/acme/shop-web.git` is never touched, and neither is a name
 * glued into a longer word. The pinned `runtimeVersion` becomes
 * `__MONOCEROS_RUNTIME_VERSION__`. Rendering the template under the original
 * name gives the original yml back.
 *
 * Only the yml is copied. The values in `<name>.env` stay behind; the yml
 * keeps its `${VAR}` references, which `init --template` asks for.
 */

const NAME_PLACEHOLDER = '__MONOCEROS_NAME__';
const RUNTIME_PLACEHOLDER = '__MONOCEROS_RUNTIME_VERSION__';
const TEMPLATE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMENT_WIDTH = 76;

export interface CreateTemplateInput {
  name: string;
  template: string;
  description?: string;
  monocerosHome?: string;
}

export interface CreateTemplateResult {
  file: string;
  /** The template's description, or undefined when it has none. */
  description: string | undefined;
}

export async function runCreateTemplate(
  input: CreateTemplateInput,
): Promise<CreateTemplateResult> {
  const home = input.monocerosHome ?? defaultMonocerosHome();
  if (!TEMPLATE_NAME_RE.test(input.template)) {
    throw new Error(
      `Invalid template name ${JSON.stringify(input.template)}. Use letters, digits, '.', '_' or '-' (must start with a letter or digit).`,
    );
  }
  const source = containerConfigPath(input.name, home);
  if (!existsSync(source)) {
    throw new Error(
      `There is no workbench '${input.name}': ${source} does not exist.`,
    );
  }
  const dir = userWorkbenchTemplatesDir(home);
  const file = path.join(dir, `${input.template}.yml`);

  let text = toTemplate(await fs.readFile(source, 'utf8'), input.name);
  if (input.description !== undefined && input.description.trim() !== '') {
    text = withDescription(text, input.description.trim());
  }

  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(file, text, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `${file} already exists. Pick another template name, or remove that file first.`,
      );
    }
    throw err;
  }
  return { file, description: templateDescription(text) };
}

/** The workbench yml with its name and runtime replaced by the placeholders. */
export function toTemplate(text: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The name as a word of its own: not after a letter, digit, `.`, `-` or `/`
  // (so not inside a URL or a longer name), not before a letter or digit.
  const word = new RegExp(
    `(^|[^A-Za-z0-9_.\\-/])${escaped}(?![A-Za-z0-9_])`,
    'g',
  );
  const nameLine = new RegExp(`^(name:[ \\t]*)${escaped}([ \\t]*)$`);
  return text
    .split('\n')
    .map((line) => {
      if (nameLine.test(line))
        return line.replace(nameLine, `$1${NAME_PLACEHOLDER}$2`);
      if (/^runtimeVersion:/.test(line)) {
        return line.replace(
          /^(runtimeVersion:[ \t]*)\S+/,
          `$1${RUNTIME_PLACEHOLDER}`,
        );
      }
      if (/^\s*#/.test(line))
        return line.replace(word, `$1${NAME_PLACEHOLDER}`);
      return line;
    })
    .join('\n');
}

/**
 * Put the description under the header comment init writes: as the paragraph
 * after `The workbench …`, replacing the one a template-made workbench
 * already carries. A yml without a leading comment gets it on top.
 */
export function withDescription(text: string, description: string): string {
  const lines = text.split('\n');
  const desc = wrapToComment(description, COMMENT_WIDTH).map((l) => `# ${l}`);
  let end = 0;
  while (end < lines.length && lines[end]!.startsWith('#')) end++;
  if (end === 0) return [...desc, '', ...lines].join('\n');

  // Paragraphs of the leading comment block, as [start, end) line ranges.
  const paragraphs: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i <= end; i++) {
    const blank = i === end || lines[i]!.replace(/^#\s?/, '').trim() === '';
    if (!blank) continue;
    if (i > start) paragraphs.push([start, i]);
    start = i + 1;
  }
  const isHeader = (p: [number, number]): boolean =>
    lines[p[0]]!.replace(/^#\s?/, '').startsWith('The workbench `');
  const header = paragraphs.find(isHeader);
  if (!header) return [...desc, '#', ...lines].join('\n');
  const after = paragraphs.find((p) => p[0] > header[0]);
  if (after) {
    return [
      ...lines.slice(0, after[0]),
      ...desc,
      ...lines.slice(after[1]),
    ].join('\n');
  }
  return [
    ...lines.slice(0, header[1]),
    '#',
    ...desc,
    ...lines.slice(header[1]),
  ].join('\n');
}
