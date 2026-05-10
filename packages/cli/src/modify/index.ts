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
  copyPostCreateScript,
  needsCompose,
  normalizeOptions,
  validateOptions,
} from '../create/scaffold.js';
import type { CreateOptions, StackFile } from '../create/types.js';
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

interface PlannedChange {
  relPath: string;
  absPath: string;
  before: string | null;
  after: string | null;
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
  };

  const devcontainerPath = path.join(
    root,
    '.devcontainer',
    'devcontainer.json',
  );
  const composePath = path.join(root, '.devcontainer', 'compose.yaml');

  const oldDevcontainer = await readUtf8(devcontainerPath);
  const oldCompose = await readUtf8(composePath);

  const newDevcontainer =
    JSON.stringify(buildDevcontainerJson(normalized), null, 2) + '\n';
  const newCompose = needsCompose(normalized)
    ? buildComposeYaml(normalized)
    : null;
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
  root: string,
  planned: PlannedChange[],
): Promise<void> {
  for (const change of planned) {
    if (change.after === null) {
      await fs.unlink(change.absPath);
    } else {
      await fs.mkdir(path.dirname(change.absPath), { recursive: true });
      await fs.writeFile(change.absPath, change.after);
    }
  }
  // post-create.sh is generated from the template each time; rerunning the
  // copy is idempotent and ensures the file stays in sync with whatever
  // the current CLI version ships.
  await copyPostCreateScript(path.join(root, '.devcontainer'));
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
