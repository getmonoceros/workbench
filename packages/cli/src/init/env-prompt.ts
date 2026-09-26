import { createInterface } from 'node:readline/promises';
import { consola } from 'consola';
import { readEnvFile, setEnvVarRef } from '../config/env-file.js';
import { colorsFor } from '../util/format.js';
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
  /** The workbench name, for "acme needs 2 values" and "for acme only". */
  name: string;
  /**
   * What the two files already hold, so each prompt can say whether its value
   * is set and where. Without this the builder sees the same bare question for
   * a key they filled in months ago and one they have never heard of, and the
   * intro line that explained the difference went unread.
   */
  globalValues?: Record<string, string>;
  containerValues?: Record<string, string>;
  /** Injected by tests; defaults to a readline prompt on stdout. */
  ask?: (
    candidate: EnvPromptCandidate,
    state: EnvValueState,
  ) => Promise<string | undefined>;
  output?: (line: string) => void;
  /** The summary line for a value that ends up set. Falls back to `output`. */
  success?: (line: string) => void;
}

/** Where a value already is, before the builder answers. */
export type EnvValueState =
  | { source: 'container'; tail: string }
  | { source: 'global'; tail: string }
  | { source: 'none' };

/**
 * The container file wins over the global one, blanks fall through: the same
 * order `mergeEnvLayers` resolves at apply, so what the prompt says is what
 * apply will do.
 */
export function envValueState(
  envVar: string,
  globalValues: Record<string, string> = {},
  containerValues: Record<string, string> = {},
): EnvValueState {
  const container = (containerValues[envVar] ?? '').trim();
  if (container) return { source: 'container', tail: maskedTail(container) };
  const global = (globalValues[envVar] ?? '').trim();
  if (global) return { source: 'global', tail: maskedTail(global) };
  return { source: 'none' };
}

/**
 * The last four characters, enough to tell two keys apart. Only for a value
 * long enough that four characters give nothing away; a short value, a site
 * name or a flag, shows no tail at all.
 */
function maskedTail(value: string): string {
  return value.length >= 12 ? ` (…${value.slice(-4)})` : '';
}

/** What one prompt shows: the question with its status, and the hint. */
export function envPromptText(
  candidate: EnvPromptCandidate,
  state: EnvValueState,
  opts: { name: string; globalEnvPath: string; containerEnvPath: string },
): { message: string; placeholder: string } {
  const who = candidate.feature ? ` (${candidate.feature})` : '';
  const status =
    state.source === 'container'
      ? `is set for ${opts.name}${state.tail}`
      : state.source === 'global'
        ? `is set in ${opts.globalEnvPath}${state.tail}`
        : 'is not set yet';
  const lines = [`${candidate.envVar}${who} ${status}`];
  if (candidate.description) lines.push(`ℹ ${candidate.description}`);
  const placeholder =
    state.source === 'none'
      ? `Enter skips it, fill it in later in ${opts.containerEnvPath}`
      : `Enter keeps it, or type a different value for ${opts.name} only`;
  return { message: lines.join('\n'), placeholder };
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
  const ok = opts.success ?? out;
  out(
    `${opts.name} needs ${candidates.length} value${candidates.length > 1 ? 's' : ''}.`,
  );

  const ask = opts.ask ?? ((c, state) => defaultAsk(c, state, opts));
  const summary: Array<{ set: boolean; line: string }> = [];
  for (const candidate of candidates) {
    const state = envValueState(
      candidate.envVar,
      opts.globalValues,
      opts.containerValues,
    );
    const answer = await ask(candidate, state);
    const value = typeof answer === 'string' ? answer.trim() : '';
    if (value.length > 0) answers[candidate.envVar] = value;
    summary.push(summaryLine(candidate.envVar, value, state, opts));
  }
  // The summary starts a block of its own, apart from the last question.
  process.stdout.write('\n');
  const width = Math.max(...candidates.map((c) => c.envVar.length));
  for (const { set, line } of summary) {
    const [key, rest] = line.split('\t') as [string, string];
    (set ? ok : out)(`${key.padEnd(width)}  ${rest}`);
  }
  return answers;
}

/** Where the value ended up, one line per key, after all were asked. */
function summaryLine(
  envVar: string,
  answer: string,
  state: EnvValueState,
  opts: { name: string; globalEnvPath: string; containerEnvPath: string },
): { set: boolean; line: string } {
  if (answer || state.source === 'container')
    return {
      set: true,
      line: `${envVar}\tfor ${opts.name} (${opts.containerEnvPath})`,
    };
  if (state.source === 'global')
    return { set: true, line: `${envVar}\tglobal (${opts.globalEnvPath})` };
  return {
    set: false,
    line: `${envVar}\tempty, fill it in later in ${opts.containerEnvPath}`,
  };
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

/**
 * A plain readline prompt, not `consola.prompt`: consola draws a fixed `❯`
 * while asking and a green `✔` once answered, and a check mark next to "is not
 * set yet" read as done. The yellow `?` says the opposite, that this line wants
 * the builder, and it stays that way after Enter.
 */
const defaultAsk = async (
  candidate: EnvPromptCandidate,
  state: EnvValueState,
  opts: PromptEnvValuesOptions,
): Promise<string | undefined> => {
  const c = colorsFor(process.stdout);
  const { message, placeholder } = envPromptText(candidate, state, opts);
  const [first, ...rest] = message.split('\n');
  process.stdout.write(
    `\n${c.bold(c.yellow('?'))} ${c.bold(first ?? '')}\n` +
      rest.map((line) => `${line}\n`).join(''),
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(`  ${c.dim(placeholder)}\n  ${c.yellow('›')} `);
  } finally {
    rl.close();
  }
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
  const answers = await promptForEnvValues(candidates, {
    containerValues: readEnvFile(envPath),
    ...opts,
  });
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
