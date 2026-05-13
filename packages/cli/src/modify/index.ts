import { promises as fs } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import { createPatch } from 'diff';
import {
  BUILTIN_LANGUAGES,
  LANGUAGE_CATALOG,
  SERVICE_CATALOG,
  knownLanguages,
  knownServices,
} from '../create/catalog.js';
import {
  buildComposeYaml,
  buildDevcontainerJson,
  buildPostCreateScript,
  needsCompose,
  normalizeOptions,
  validateOptions,
} from '../create/scaffold.js';
import type {
  CreateOptions,
  FeatureOptions,
  StackFile,
} from '../create/types.js';
import { findSolutionRoot } from '../devcontainer/locate.js';

export interface ModifyLogger {
  info: (message: string) => void;
  success: (message: string) => void;
  warn: (message: string) => void;
}

export type ConfirmFn = (prompt: string) => Promise<boolean>;

export interface ModifyOptions {
  cwd?: string;
  project?: string;
  yes?: boolean;
  cliVersion: string;
  logger?: ModifyLogger;
  output?: (line: string) => void;
  confirm?: ConfirmFn;
}

export interface AddLanguageInput extends ModifyOptions {
  language: string;
}

export interface AddServiceInput extends ModifyOptions {
  service: string;
}

export interface AddAptPackagesInput extends ModifyOptions {
  packages: string[];
}

export interface AddFeatureInput extends ModifyOptions {
  ref: string;
  options?: FeatureOptions;
}

export interface AddFromUrlInput extends ModifyOptions {
  url: string;
}

export type ModifyResult =
  | { status: 'no-change' }
  | { status: 'updated'; changedPaths: string[] }
  | { status: 'aborted' };

export async function runAddLanguage(
  input: AddLanguageInput,
): Promise<ModifyResult> {
  if (
    !BUILTIN_LANGUAGES.has(input.language) &&
    !LANGUAGE_CATALOG[input.language]
  ) {
    throw new Error(
      `Unknown language: ${input.language}. Known: ${knownLanguages().join(', ')}.`,
    );
  }
  return mutate(input, (stack) => ({
    ...stack,
    languages: [...new Set([...stack.languages, input.language])].sort(),
  }));
}

export async function runAddService(
  input: AddServiceInput,
): Promise<ModifyResult> {
  if (!SERVICE_CATALOG[input.service]) {
    throw new Error(
      `Unknown service: ${input.service}. Known: ${knownServices().join(', ')}.`,
    );
  }
  return mutate(input, (stack) => ({
    ...stack,
    services: [...new Set([...stack.services, input.service])].sort(),
  }));
}

export async function runAddAptPackages(
  input: AddAptPackagesInput,
): Promise<ModifyResult> {
  if (input.packages.length === 0) {
    throw new Error(
      'No package names given. Usage: monoceros add-apt-packages <pkg> [<pkg> …].',
    );
  }
  return mutate(input, (stack) => {
    const merged = [
      ...new Set([...(stack.aptPackages ?? []), ...input.packages]),
    ].sort();
    return {
      ...stack,
      aptPackages: merged,
    };
  });
}

export async function runAddFromUrl(
  input: AddFromUrlInput,
): Promise<ModifyResult> {
  const url = input.url.trim();
  if (url.length === 0) {
    throw new Error('Missing URL. Usage: monoceros add-from-url <url>.');
  }
  return mutate(input, (stack) => {
    // Preserve order: existing URLs stay where they are, new URL is
    // appended. Re-add of an existing URL is a no-op via the dedup in
    // normalizeOptions.
    const existing = stack.installUrls ?? [];
    if (existing.includes(url)) {
      return stack;
    }
    return {
      ...stack,
      installUrls: [...existing, url],
    };
  });
}

export async function runAddFeature(
  input: AddFeatureInput,
): Promise<ModifyResult> {
  const ref = input.ref.trim();
  if (ref.length === 0) {
    throw new Error('Missing feature ref. Usage: monoceros add-feature <ref>.');
  }
  return mutate(input, (stack) => {
    const existing = stack.features?.[ref];
    if (existing !== undefined) {
      // We treat re-adding a known feature as an explicit error rather
      // than silently overwriting its options. Builder must
      // `remove-feature` (future) or edit stack.json directly to change
      // option values. The no-options re-add is still caught as
      // "no-change" later because the regenerated stack/devcontainer
      // bytes are byte-identical.
      const sameOptions =
        JSON.stringify(existing) === JSON.stringify(input.options ?? {});
      if (!sameOptions) {
        throw new Error(
          `Feature ${ref} is already configured with different options. Edit stack.json directly or remove it first.`,
        );
      }
    }
    const features: Record<string, FeatureOptions> = {
      ...(stack.features ?? {}),
      [ref]: input.options ?? {},
    };
    return {
      ...stack,
      features,
    };
  });
}

interface PlannedChange {
  relPath: string;
  absPath: string;
  before: string | null;
  after: string | null;
  /** When true, applyChanges chmods the file to 0o755 after writing. */
  executable?: boolean;
}

async function mutate(
  opts: ModifyOptions,
  apply: (stack: StackFile) => StackFile,
): Promise<ModifyResult> {
  const cwd = opts.cwd ?? process.cwd();
  const startDir = opts.project ? path.resolve(cwd, opts.project) : cwd;
  const root = findSolutionRoot(startDir);
  if (!root) {
    throw new Error(
      `No .devcontainer/ found at or above ${startDir}. Run \`monoceros create\` first or change into a solution directory.`,
    );
  }

  const stackPath = path.join(root, '.monoceros', 'stack.json');
  const oldStackContent = await readUtf8OrThrow(
    stackPath,
    `No .monoceros/stack.json at ${stackPath}. The directory was not created by \`monoceros create\` and cannot be safely modified.`,
  );
  const oldStack = JSON.parse(oldStackContent) as StackFile;
  const draftStack = apply(oldStack);

  const draftOptions: CreateOptions = {
    name: draftStack.name,
    languages: draftStack.languages,
    services: draftStack.services,
    postgresUrl: draftStack.externalServices.postgres,
    ...(draftStack.aptPackages && draftStack.aptPackages.length > 0
      ? { aptPackages: draftStack.aptPackages }
      : {}),
    ...(draftStack.features && Object.keys(draftStack.features).length > 0
      ? { features: draftStack.features }
      : {}),
    ...(draftStack.installUrls && draftStack.installUrls.length > 0
      ? { installUrls: draftStack.installUrls }
      : {}),
  };
  validateOptions(draftOptions);
  const normalized = normalizeOptions(draftOptions);

  const newStack: StackFile = {
    ...oldStack,
    languages: normalized.languages,
    services: normalized.services,
    externalServices: normalized.postgresUrl
      ? { postgres: normalized.postgresUrl }
      : {},
    monocerosCliVersion: opts.cliVersion,
    ...(normalized.aptPackages && normalized.aptPackages.length > 0
      ? { aptPackages: normalized.aptPackages }
      : {}),
    ...(normalized.features && Object.keys(normalized.features).length > 0
      ? { features: normalized.features }
      : {}),
    ...(normalized.installUrls && normalized.installUrls.length > 0
      ? { installUrls: normalized.installUrls }
      : {}),
  };

  const devcontainerPath = path.join(
    root,
    '.devcontainer',
    'devcontainer.json',
  );
  const composePath = path.join(root, '.devcontainer', 'compose.yaml');
  const postCreatePath = path.join(root, '.devcontainer', 'post-create.sh');

  const oldDevcontainer = await readUtf8(devcontainerPath);
  const oldCompose = await readUtf8(composePath);
  const oldPostCreate = await readUtf8(postCreatePath);

  const newDevcontainer =
    JSON.stringify(buildDevcontainerJson(normalized), null, 2) + '\n';
  const newCompose = needsCompose(normalized)
    ? buildComposeYaml(normalized)
    : null;
  const newPostCreate = buildPostCreateScript(normalized);
  const newStackContent = JSON.stringify(newStack, null, 2) + '\n';

  const planned: PlannedChange[] = [];
  if (oldDevcontainer !== newDevcontainer) {
    planned.push({
      relPath: path.relative(root, devcontainerPath),
      absPath: devcontainerPath,
      before: oldDevcontainer,
      after: newDevcontainer,
    });
  }
  if (newCompose !== null) {
    if (oldCompose !== newCompose) {
      planned.push({
        relPath: path.relative(root, composePath),
        absPath: composePath,
        before: oldCompose,
        after: newCompose,
      });
    }
  } else if (oldCompose !== null) {
    planned.push({
      relPath: path.relative(root, composePath),
      absPath: composePath,
      before: oldCompose,
      after: null,
    });
  }
  if (oldPostCreate !== newPostCreate) {
    planned.push({
      relPath: path.relative(root, postCreatePath),
      absPath: postCreatePath,
      before: oldPostCreate,
      after: newPostCreate,
      executable: true,
    });
  }
  if (oldStackContent !== newStackContent) {
    planned.push({
      relPath: path.relative(root, stackPath),
      absPath: stackPath,
      before: oldStackContent,
      after: newStackContent,
    });
  }

  const logger = opts.logger ?? defaultLogger();
  if (planned.length === 0) {
    logger.info('No changes — solution is already in the desired state.');
    return { status: 'no-change' };
  }

  const out = opts.output ?? ((line) => process.stdout.write(line + '\n'));
  for (const change of planned) {
    out(renderPatch(change));
  }

  if (!opts.yes) {
    const confirm = opts.confirm ?? defaultConfirm;
    const ok = await confirm('Apply these changes?');
    if (!ok) {
      logger.warn('Aborted by user. No files were written.');
      return { status: 'aborted' };
    }
  }

  await applyChanges(root, planned);
  logger.success(`Updated solution at ${root}.`);
  logger.info(
    'Run `monoceros apply` to rebuild the container and pick up the change.',
  );
  return {
    status: 'updated',
    changedPaths: planned.map((c) => c.relPath),
  };
}

function renderPatch(change: PlannedChange): string {
  if (change.before === null && change.after !== null) {
    return [
      `--- ${change.relPath}\t(missing)`,
      `+++ ${change.relPath}\t(new)`,
      ...change.after.split('\n').map((line) => `+${line}`),
    ].join('\n');
  }
  if (change.before !== null && change.after === null) {
    return [
      `--- ${change.relPath}\t(existing)`,
      `+++ ${change.relPath}\t(removed)`,
      ...change.before.split('\n').map((line) => `-${line}`),
    ].join('\n');
  }
  return createPatch(
    change.relPath,
    change.before ?? '',
    change.after ?? '',
    'before',
    'after',
  );
}

async function applyChanges(
  _root: string,
  planned: PlannedChange[],
): Promise<void> {
  for (const change of planned) {
    if (change.after === null) {
      await fs.unlink(change.absPath);
    } else {
      await fs.mkdir(path.dirname(change.absPath), { recursive: true });
      await fs.writeFile(change.absPath, change.after);
      if (change.executable) {
        await fs.chmod(change.absPath, 0o755);
      }
    }
  }
}

async function readUtf8(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function readUtf8OrThrow(
  filePath: string,
  errorMessage: string,
): Promise<string> {
  const content = await readUtf8(filePath);
  if (content === null) throw new Error(errorMessage);
  return content;
}

function defaultLogger(): ModifyLogger {
  return {
    info: (m) => consola.info(m),
    success: (m) => consola.success(m),
    warn: (m) => consola.warn(m),
  };
}

const defaultConfirm: ConfirmFn = async (message) => {
  const result = await consola.prompt(message, {
    type: 'confirm',
    initial: false,
  });
  return result === true;
};
