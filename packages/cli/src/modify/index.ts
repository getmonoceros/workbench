import { promises as fs } from 'node:fs';
import { consola } from 'consola';
import { createPatch } from 'diff';
import type { Document } from 'yaml';
import { parseConfig, stringifyConfig } from '../config/io.js';
import {
  containerConfigPath,
  monocerosHome as defaultMonocerosHome,
} from '../config/paths.js';
import { REGEX } from '../config/schema.js';
import {
  BUILTIN_LANGUAGES,
  LANGUAGE_CATALOG,
  SERVICE_CATALOG,
  knownLanguages,
  knownServices,
} from '../create/catalog.js';
import { deriveRepoName } from '../create/scaffold.js';
import type { FeatureOptions, RepoEntry } from '../create/types.js';
import {
  addAptPackagesToDoc,
  addFeatureToDoc,
  addInstallUrlToDoc,
  addLanguageToDoc,
  addRepoToDoc,
  addServiceToDoc,
  removeAptPackagesFromDoc,
  removeFeatureFromDoc,
  removeInstallUrlFromDoc,
  removeLanguageFromDoc,
  removeRepoFromDoc,
  removeServiceFromDoc,
} from './yml.js';

/**
 * `monoceros add-*` / `monoceros remove-*` — edit the yml at
 * `<MONOCEROS_HOME>/container-configs/<name>.yml` for one container.
 *
 * No cwd magic. The first positional argument is always the container
 * name; the command looks up the yml via convention. Comment-preserving
 * AST mutation; the builder then runs `monoceros apply <name>` to
 * materialize.
 */

export interface ModifyLogger {
  info: (message: string) => void;
  success: (message: string) => void;
  warn: (message: string) => void;
}

export type ConfirmFn = (prompt: string) => Promise<boolean>;

export interface ModifyOptions {
  /** Container name — resolves to `<home>/container-configs/<name>.yml`. */
  name: string;
  yes?: boolean;
  logger?: ModifyLogger;
  output?: (line: string) => void;
  confirm?: ConfirmFn;
  /** Override the resolved MONOCEROS_HOME. Tests inject a tmpdir. */
  monocerosHome?: string;
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
  repoName?: string;
  branch?: string;
}

export interface RemoveLanguageInput extends ModifyOptions {
  language: string;
}
export interface RemoveServiceInput extends ModifyOptions {
  service: string;
}
export interface RemoveAptPackagesInput extends ModifyOptions {
  packages: string[];
}
export interface RemoveFeatureInput extends ModifyOptions {
  ref: string;
}
export interface RemoveFromUrlInput extends ModifyOptions {
  url: string;
}
export interface RemoveRepoInput extends ModifyOptions {
  /** url or (effective) name — `monoceros remove-repo` accepts either. */
  target: string;
}

export type ModifyResult =
  | { status: 'no-change' }
  | { status: 'updated'; changedPaths: string[] }
  | { status: 'aborted' };

type YmlMutator = (doc: Document) => boolean;

// ─── add-* ────────────────────────────────────────────────────────

export function runAddLanguage(input: AddLanguageInput): Promise<ModifyResult> {
  if (
    !BUILTIN_LANGUAGES.has(input.language) &&
    !LANGUAGE_CATALOG[input.language]
  ) {
    throw new Error(
      `Unknown language: ${input.language}. Known: ${knownLanguages().join(', ')}.`,
    );
  }
  return mutate(input, (doc) => addLanguageToDoc(doc, input.language));
}

export function runAddService(input: AddServiceInput): Promise<ModifyResult> {
  if (!SERVICE_CATALOG[input.service]) {
    throw new Error(
      `Unknown service: ${input.service}. Known: ${knownServices().join(', ')}.`,
    );
  }
  return mutate(input, (doc) => addServiceToDoc(doc, input.service));
}

export function runAddAptPackages(
  input: AddAptPackagesInput,
): Promise<ModifyResult> {
  if (input.packages.length === 0) {
    throw new Error(
      'No package names given. Usage: monoceros add-apt-packages <containername> -- <pkg> [<pkg> …].',
    );
  }
  return mutate(input, (doc) => addAptPackagesToDoc(doc, input.packages));
}

export function runAddRepo(input: AddRepoInput): Promise<ModifyResult> {
  const url = input.url.trim();
  if (url.length === 0) {
    throw new Error(
      'Missing repo URL. Usage: monoceros add-repo <containername> <url>.',
    );
  }
  const name = (input.repoName ?? deriveRepoName(url)).trim();
  const entry: RepoEntry = {
    url,
    name,
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
  };
  return mutate(input, (doc) => addRepoToDoc(doc, entry));
}

export function runAddFromUrl(input: AddFromUrlInput): Promise<ModifyResult> {
  const url = input.url.trim();
  if (url.length === 0) {
    throw new Error(
      'Missing URL. Usage: monoceros add-from-url <containername> <url>.',
    );
  }
  return mutate(input, (doc) => addInstallUrlToDoc(doc, url));
}

export function runAddFeature(input: AddFeatureInput): Promise<ModifyResult> {
  const ref = input.ref.trim();
  if (ref.length === 0) {
    throw new Error(
      'Missing feature ref. Usage: monoceros add-feature <containername> <ref>.',
    );
  }
  return mutate(input, (doc) => addFeatureToDoc(doc, ref, input.options ?? {}));
}

// ─── remove-* ─────────────────────────────────────────────────────

export function runRemoveLanguage(
  input: RemoveLanguageInput,
): Promise<ModifyResult> {
  return mutate(input, (doc) => removeLanguageFromDoc(doc, input.language));
}

export function runRemoveService(
  input: RemoveServiceInput,
): Promise<ModifyResult> {
  return mutate(input, (doc) => removeServiceFromDoc(doc, input.service));
}

export function runRemoveAptPackages(
  input: RemoveAptPackagesInput,
): Promise<ModifyResult> {
  if (input.packages.length === 0) {
    throw new Error(
      'No package names given. Usage: monoceros remove-apt-packages <containername> -- <pkg> [<pkg> …].',
    );
  }
  return mutate(input, (doc) => removeAptPackagesFromDoc(doc, input.packages));
}

export function runRemoveFeature(
  input: RemoveFeatureInput,
): Promise<ModifyResult> {
  const ref = input.ref.trim();
  if (ref.length === 0) {
    throw new Error(
      'Missing feature ref. Usage: monoceros remove-feature <containername> <ref>.',
    );
  }
  return mutate(input, (doc) => removeFeatureFromDoc(doc, ref));
}

export function runRemoveFromUrl(
  input: RemoveFromUrlInput,
): Promise<ModifyResult> {
  const url = input.url.trim();
  if (url.length === 0) {
    throw new Error(
      'Missing URL. Usage: monoceros remove-from-url <containername> <url>.',
    );
  }
  return mutate(input, (doc) => removeInstallUrlFromDoc(doc, url));
}

export function runRemoveRepo(input: RemoveRepoInput): Promise<ModifyResult> {
  const target = input.target.trim();
  if (target.length === 0) {
    throw new Error(
      'Missing repo identifier. Usage: monoceros remove-repo <containername> <url-or-name>.',
    );
  }
  return mutate(input, (doc) => removeRepoFromDoc(doc, target));
}

// ─── core mutate skeleton ─────────────────────────────────────────

async function mutate(
  opts: ModifyOptions,
  apply: YmlMutator,
): Promise<ModifyResult> {
  if (!REGEX.solutionName.test(opts.name)) {
    throw new Error(
      `Invalid container name: ${JSON.stringify(opts.name)}. Use letters, digits, '.', '_' or '-'.`,
    );
  }
  const home = opts.monocerosHome ?? defaultMonocerosHome();
  const ymlPath = containerConfigPath(opts.name, home);
  const logger = opts.logger ?? defaultLogger();

  let oldText: string;
  try {
    oldText = await fs.readFile(ymlPath, 'utf8');
  } catch {
    throw new Error(
      `No such config: ${ymlPath}. Run \`monoceros init <template> ${opts.name}\` first.`,
    );
  }

  const parsed = parseConfig(oldText, ymlPath);
  const changed = apply(parsed.doc);

  if (!changed) {
    logger.info('No changes — yml is already in the desired state.');
    return { status: 'no-change' };
  }

  // Re-validate via a round-trip so schema violations introduced by
  // the mutation surface here with the regular field-path error, not
  // later at apply time.
  const newText = stringifyConfig(parsed.doc);
  parseConfig(newText, ymlPath);

  const out = opts.output ?? ((line) => process.stdout.write(line + '\n'));
  out(createPatch(ymlPath, oldText, newText, 'before', 'after'));

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
    `Run \`monoceros apply ${opts.name}\` to rebuild the dev-container and pick up the change.`,
  );
  return { status: 'updated', changedPaths: [ymlPath] };
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
