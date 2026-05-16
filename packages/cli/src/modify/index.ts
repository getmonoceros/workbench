import { promises as fs } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import { createPatch } from 'diff';
import type { Document } from 'yaml';
import { parseConfig, stringifyConfig } from '../config/io.js';
import { configPath } from '../config/paths.js';
import { readStateFile } from '../config/state.js';
import {
  BUILTIN_LANGUAGES,
  LANGUAGE_CATALOG,
  SERVICE_CATALOG,
  knownLanguages,
  knownServices,
} from '../create/catalog.js';
import {
  buildCodeWorkspaceJson,
  buildComposeYaml,
  buildDevcontainerJson,
  buildPostCreateScript,
  deriveRepoName,
  needsCompose,
  normalizeOptions,
  validateOptions,
} from '../create/scaffold.js';
import type {
  CreateOptions,
  FeatureOptions,
  RepoEntry,
  StackFile,
} from '../create/types.js';
import { findSolutionRoot } from '../devcontainer/locate.js';
import {
  addAptPackagesToDoc,
  addFeatureToDoc,
  addInstallUrlToDoc,
  addLanguageToDoc,
  addRepoToDoc,
  addServiceToDoc,
} from './yml.js';

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
  /** Override workbench root (used by Phase-3 yml lookup). Tests inject. */
  workbenchRoot?: string;
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

export interface AddRepoInput extends ModifyOptions {
  url: string;
  name?: string;
  branch?: string;
}

export type ModifyResult =
  | { status: 'no-change' }
  | { status: 'updated'; changedPaths: string[] }
  | { status: 'aborted' };

/**
 * Mutator pair: one operates on the yml Document (Phase 3 path), one
 * on the legacy StackFile. Each `runAdd*` provides both so `mutate()`
 * can dispatch on whether `.monoceros/state.json` exists.
 */
interface Mutators {
  yml: (doc: Document) => boolean;
  stack: (stack: StackFile) => StackFile;
}

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
  return mutate(input, {
    yml: (doc) => addLanguageToDoc(doc, input.language),
    stack: (stack) => ({
      ...stack,
      languages: [...new Set([...stack.languages, input.language])].sort(),
    }),
  });
}

export async function runAddService(
  input: AddServiceInput,
): Promise<ModifyResult> {
  if (!SERVICE_CATALOG[input.service]) {
    throw new Error(
      `Unknown service: ${input.service}. Known: ${knownServices().join(', ')}.`,
    );
  }
  return mutate(input, {
    yml: (doc) => addServiceToDoc(doc, input.service),
    stack: (stack) => ({
      ...stack,
      services: [...new Set([...stack.services, input.service])].sort(),
    }),
  });
}

export async function runAddAptPackages(
  input: AddAptPackagesInput,
): Promise<ModifyResult> {
  if (input.packages.length === 0) {
    throw new Error(
      'No package names given. Usage: monoceros add-apt-packages <pkg> [<pkg> …].',
    );
  }
  return mutate(input, {
    yml: (doc) => addAptPackagesToDoc(doc, input.packages),
    stack: (stack) => {
      const merged = [
        ...new Set([...(stack.aptPackages ?? []), ...input.packages]),
      ].sort();
      return {
        ...stack,
        aptPackages: merged,
      };
    },
  });
}

export async function runAddRepo(input: AddRepoInput): Promise<ModifyResult> {
  const url = input.url.trim();
  if (url.length === 0) {
    throw new Error('Missing repo URL. Usage: monoceros add-repo <url>.');
  }
  // URL syntax check happens later via validateOptions; the name we
  // derive here only matters if it isn't overridden. Empty derived
  // name falls through to validateOptions' REPO_NAME_RE check.
  const name = (input.name ?? deriveRepoName(url)).trim();
  const entry: RepoEntry = {
    url,
    name,
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
  };
  return mutate(input, {
    yml: (doc) => addRepoToDoc(doc, entry),
    stack: (stack) => {
      const existing = stack.repos ?? [];
      // Idempotent: same name + url + branch → no change. Different
      // signature with the same name → validation error downstream
      // (handled by validateOptions in mutate's draftOptions pass).
      const same = existing.find(
        (r) =>
          r.name === entry.name &&
          r.url === entry.url &&
          (r.branch ?? undefined) === (entry.branch ?? undefined),
      );
      if (same) {
        return stack;
      }
      return {
        ...stack,
        repos: [...existing, entry],
      };
    },
  });
}

export async function runAddFromUrl(
  input: AddFromUrlInput,
): Promise<ModifyResult> {
  const url = input.url.trim();
  if (url.length === 0) {
    throw new Error('Missing URL. Usage: monoceros add-from-url <url>.');
  }
  return mutate(input, {
    yml: (doc) => addInstallUrlToDoc(doc, url),
    stack: (stack) => {
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
    },
  });
}

export async function runAddFeature(
  input: AddFeatureInput,
): Promise<ModifyResult> {
  const ref = input.ref.trim();
  if (ref.length === 0) {
    throw new Error('Missing feature ref. Usage: monoceros add-feature <ref>.');
  }
  return mutate(input, {
    yml: (doc) => addFeatureToDoc(doc, ref, input.options ?? {}),
    stack: (stack) => {
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
    },
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
  mutators: Mutators,
): Promise<ModifyResult> {
  const cwd = opts.cwd ?? process.cwd();
  const startDir = opts.project ? path.resolve(cwd, opts.project) : cwd;
  const root = findSolutionRoot(startDir);
  if (!root) {
    throw new Error(
      `No .devcontainer/ found at or above ${startDir}. Run \`monoceros create\` first or change into a solution directory.`,
    );
  }

  // Phase-3 solutions carry a `.monoceros/state.json` with an `origin`
  // pointing at the yml that owns this dev-container. When present,
  // mutate the yml directly (the yml is the wahrheit; container files
  // regenerate on `monoceros apply`). Legacy stack.json-only solutions
  // fall through to the old in-place rewrite — Task 7 migrates them.
  const state = await readStateFile(root);
  if (state) {
    return mutateYml(root, state.origin, opts, mutators.yml);
  }
  return mutateStack(root, opts, mutators.stack);
}

async function mutateYml(
  root: string,
  origin: string,
  opts: ModifyOptions,
  apply: (doc: Document) => boolean,
): Promise<ModifyResult> {
  const ymlPath = configPath(origin, opts.workbenchRoot);
  const oldText = await readUtf8OrThrow(
    ymlPath,
    `state.json on ${root} points at config '${origin}' but no yml at ${ymlPath}. Run \`monoceros init <template> ${origin}\` (with the original template) or remove the state file.`,
  );
  // Parse the doc twice: the live one we mutate, and a baseline kept
  // pristine for the diff render. Mutators may bail out (return false)
  // when the change is a no-op.
  const parsed = parseConfig(oldText, ymlPath);
  const changed = apply(parsed.doc);
  const logger = opts.logger ?? defaultLogger();

  if (!changed) {
    logger.info('No changes — yml is already in the desired state.');
    return { status: 'no-change' };
  }

  // Re-validate via a round-trip so schema violations introduced by the
  // mutation surface here with the regular field-path error, not later
  // at apply time.
  const newText = stringifyConfig(parsed.doc);
  parseConfig(newText, ymlPath);

  const out = opts.output ?? ((line) => process.stdout.write(line + '\n'));
  out(
    createPatch(
      path.relative(root, ymlPath) || ymlPath,
      oldText,
      newText,
      'before',
      'after',
    ),
  );

  if (!opts.yes) {
    const confirm = opts.confirm ?? defaultConfirm;
    const ok = await confirm('Apply these changes to the yml?');
    if (!ok) {
      logger.warn('Aborted by user. The yml was not modified.');
      return { status: 'aborted' };
    }
  }

  await fs.writeFile(ymlPath, newText, 'utf8');
  logger.success(`Updated ${ymlPath}.`);
  logger.info(
    'Run `monoceros apply` to rebuild the dev-container and pick up the change.',
  );
  return { status: 'updated', changedPaths: [ymlPath] };
}

async function mutateStack(
  root: string,
  opts: ModifyOptions,
  apply: (stack: StackFile) => StackFile,
): Promise<ModifyResult> {
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
    ...(draftStack.repos && draftStack.repos.length > 0
      ? { repos: draftStack.repos }
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
    ...(normalized.repos && normalized.repos.length > 0
      ? { repos: normalized.repos }
      : {}),
  };

  const devcontainerPath = path.join(
    root,
    '.devcontainer',
    'devcontainer.json',
  );
  const composePath = path.join(root, '.devcontainer', 'compose.yaml');
  const postCreatePath = path.join(root, '.devcontainer', 'post-create.sh');
  const codeWorkspacePath = path.join(
    root,
    `${normalized.name}.code-workspace`,
  );

  const oldDevcontainer = await readUtf8(devcontainerPath);
  const oldCompose = await readUtf8(composePath);
  const oldPostCreate = await readUtf8(postCreatePath);
  const oldCodeWorkspace = await readUtf8(codeWorkspacePath);

  const newDevcontainer =
    JSON.stringify(buildDevcontainerJson(normalized), null, 2) + '\n';
  const newCompose = needsCompose(normalized)
    ? buildComposeYaml(normalized)
    : null;
  const newPostCreate = buildPostCreateScript(normalized);
  const newCodeWorkspace =
    JSON.stringify(buildCodeWorkspaceJson(normalized), null, 2) + '\n';
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
  if (oldCodeWorkspace !== newCodeWorkspace) {
    planned.push({
      relPath: path.relative(root, codeWorkspacePath),
      absPath: codeWorkspacePath,
      before: oldCodeWorkspace,
      after: newCodeWorkspace,
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
