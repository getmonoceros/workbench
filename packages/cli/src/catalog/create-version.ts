import { constants, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  componentsRootDir,
  monocerosHome as defaultMonocerosHome,
  userTemplatesDir,
} from '../config/paths.js';
import { loadDescriptorCatalog, parseOwnDescriptor } from './load.js';

/**
 * `monoceros create-version <service>` (#141): the first two steps of
 * changing a service a workbench was built from (ADR 0066). The current
 * `<id>.yml` is kept byte for byte as `<id>@<n>.yml`, and `<id>.yml` moves
 * to version n+1, ready for the change.
 *
 * The version is edited in the text rather than by re-serialising the yml,
 * so comments, quoting and line breaks stay exactly as the builder wrote
 * them.
 */

export interface CreateVersionInput {
  service: string;
  monocerosHome?: string;
}

export interface CreateVersionResult {
  /** The older version, `<id>@<n>.yml`. */
  kept: string;
  /** The current file, now at `version`. */
  current: string;
  /** The version the current file has now. */
  version: number;
}

const VERSION_LINE = /^version:[ \t]*\d+[ \t]*$/m;
const CATEGORY_LINE = /^category:.*$/m;

export async function runCreateVersion(
  input: CreateVersionInput,
): Promise<CreateVersionResult> {
  const id = input.service.trim();
  const dir = path.join(
    userTemplatesDir(input.monocerosHome ?? defaultMonocerosHome()),
    'services',
  );
  const current = path.join(dir, `${id}.yml`);

  if (!existsSync(current)) {
    const shipped = await loadDescriptorCatalog(componentsRootDir());
    const isShipped = [...shipped.values()].some(
      (c) =>
        c.category === 'service' &&
        (c.descriptor.name ?? c.descriptor.id) === id,
    );
    throw new Error(
      isShipped
        ? `'${id}' is a shipped service: its versions come with the CLI. To change it for yourself, keep your own copy in ${current} first.`
        : `There is no own service '${id}': ${current} does not exist.`,
    );
  }

  const text = await fs.readFile(current, 'utf8');
  // Validates the file the way every loader does, and reads its version.
  const { descriptor } = parseOwnDescriptor(
    text,
    current,
    `${id}.yml`,
    'service',
  );
  const n = descriptor.version;
  const kept = path.join(dir, `${id}@${n}.yml`);

  try {
    await fs.copyFile(current, kept, constants.COPYFILE_EXCL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `${kept} already exists, so ${id}.yml was not changed. A version that was kept once is never overwritten.`,
      );
    }
    throw err;
  }

  const next = n + 1;
  const updated = VERSION_LINE.test(text)
    ? text.replace(VERSION_LINE, `version: ${next}`)
    : text.replace(CATEGORY_LINE, (line) => `${line}\nversion: ${next}`);
  await fs.writeFile(current, updated, 'utf8');

  return { kept, current, version: next };
}
