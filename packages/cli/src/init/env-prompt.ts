import { consola } from 'consola';
import { setEnvVarRef } from '../config/env-file.js';
import type { FeatureManifestSummary } from './manifest.js';

/**
 * One env value to ask the builder for. These are the options a feature marks
 * `surface: env`, the credentials and per-site settings that cannot be
 * guessed and that `apply` needs. Until now init seeded them as blank keys and
 * the builder found out they existed from the docs, or from a command inside
 * the container failing on its first call.
 */
export interface EnvPromptCandidate {
  /** The `${VAR}` name as it appears in the yml and the env file. */
  envVar: string;
  /** Feature display name, so the builder knows who is asking. */
  feature: string;
  /** The option's own description from the descriptor, shown as the hint. */
  description: string;
}

export interface FeatureRefWithOptions {
  ref: string;
  options?: Record<string, unknown> | undefined;
}

/**
 * The `${VAR}` placeholders the given features carry, in file order and
 * deduplicated. Read off the option VALUES rather than off the descriptor's
 * env-surfaced option list: a template is curated and may leave an option out
 * (`discovery-atlassian` ships twg without the Rovo Dev and Bitbucket tokens),
 * and asking for a variable the yml never references would be asking for
 * nothing. Works for a template, for `--with-*` flags, and for the two
 * combined alike, because by then they are all just entries in the file.
 */
export function collectEnvPromptCandidates(
  features: readonly FeatureRefWithOptions[],
  lookup: (ref: string) => FeatureManifestSummary | undefined,
): EnvPromptCandidate[] {
  const out: EnvPromptCandidate[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    const summary = lookup(f.ref);
    for (const [key, value] of Object.entries(f.options ?? {})) {
      if (typeof value !== 'string') continue;
      const match = ENV_PLACEHOLDER.exec(value);
      if (!match) continue;
      const envVar = match[1]!;
      if (seen.has(envVar)) continue;
      seen.add(envVar);
      out.push({
        envVar,
        feature: summary?.name ?? f.ref,
        description: summary?.optionDescriptions[key] ?? '',
      });
    }
  }
  return out;
}

/** A whole-value `${VAR}` reference, the shape init and add-feature write. */
const ENV_PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export interface PromptEnvValuesOptions {
  /** Skipped entirely when false, `--yes`, a pipe, CI. */
  interactive: boolean;
  /**
   * The two files an answer can live in, for the intro line: the shared
   * `monoceros-config.env` a value may already be in, and this container's own
   * env file. Named in full, because a builder who has never opened either one
   * cannot act on "the env file".
   */
  globalEnvPath: string;
  containerEnvPath: string;
  /** Injected by tests; defaults to a consola text prompt. */
  ask?: (candidate: EnvPromptCandidate) => Promise<string | undefined>;
  output?: (line: string) => void;
}

/**
 * Ask for each candidate and return the answers, skipping the blanks.
 *
 * Empty stays a valid answer throughout: a subscription login needs no API
 * key, and every value can be filled in later in the env file. So a blank
 * reply is not an error and not a re-prompt, it just leaves the key empty,
 * which is what init wrote before this prompt existed.
 */
export async function promptForEnvValues(
  candidates: readonly EnvPromptCandidate[],
  opts: PromptEnvValuesOptions,
): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  if (!opts.interactive || candidates.length === 0) return answers;

  const out = opts.output ?? ((line: string) => consola.info(line));
  out(
    `${candidates.length} value${candidates.length > 1 ? 's' : ''} the selected features need. ` +
      `Leave one empty if it is already in ${opts.globalEnvPath}, ` +
      `or to fill it in later in ${opts.containerEnvPath}.`,
  );

  const ask = opts.ask ?? defaultAsk;
  for (const candidate of candidates) {
    const answer = await ask(candidate);
    const value = typeof answer === 'string' ? answer.trim() : '';
    if (value.length > 0) answers[candidate.envVar] = value;
  }
  return answers;
}

/**
 * Whether to prompt at all. Both streams have to be a terminal: stdin because
 * the answer is typed, stdout because a prompt nobody sees is a hang. That
 * covers CI, `| cat`, and the e2e suite without a flag of their own.
 */
export function shouldPromptForEnv(yes: boolean | undefined): boolean {
  if (yes) return false;
  return (process.stdin.isTTY ?? false) && (process.stdout.isTTY ?? false);
}

const defaultAsk = async (
  candidate: EnvPromptCandidate,
): Promise<string | undefined> => {
  const answer = await consola.prompt(
    `${candidate.envVar}${candidate.description ? `, ${candidate.description}` : ''}`,
    { type: 'text', placeholder: 'leave empty to skip' },
  );
  return typeof answer === 'string' ? answer : undefined;
};

/**
 * Ask for the given values and write the answers into `<name>.env`. Returns
 * the keys that got one.
 *
 * Shared by `init` and the `add-*` commands, so a credential is asked for the
 * same way whether it arrives with the first config or three commands later.
 * The keys are seeded blank before this runs, so `setEnvVarRef` fills the
 * empty line rather than appending a second one, and it leaves a value the
 * builder already typed alone.
 */
export async function promptAndWriteEnvValues(
  candidates: readonly EnvPromptCandidate[],
  envPath: string,
  name: string,
  opts: PromptEnvValuesOptions,
): Promise<string[]> {
  const answers = await promptForEnvValues(candidates, opts);
  const written: string[] = [];
  for (const [key, value] of Object.entries(answers)) {
    await setEnvVarRef(envPath, name, key, value);
    written.push(key);
  }
  return written;
}

/**
 * Candidates for a set of env var names, with each one's description looked up
 * through `describe`. Used by the `add-*` commands, which know which vars they
 * just seeded but not the prose behind them.
 */
export function envCandidatesForVars(
  vars: readonly string[],
  feature: string,
  describe: (envVar: string) => string,
): EnvPromptCandidate[] {
  return vars.map((envVar) => ({
    envVar,
    feature,
    description: describe(envVar),
  }));
}
