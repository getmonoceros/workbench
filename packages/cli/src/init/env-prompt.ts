import { createInterface } from 'node:readline/promises';
import { consola } from 'consola';
import { readEnvFile, setEnvVarRef } from '../config/env-file.js';
import { colorsFor } from '../util/format.js';
import { optionHintNeeded } from './feature-doc.js';
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
 * A placeholder only a switched-off sub-tool reads is skipped too: a yml from
 * before that rule still carries the Rovo Dev token on a twg-only entry.
 */
export function collectEnvPromptCandidates(
  features: readonly FeatureRefWithOptions[],
  lookup: (ref: string) => FeatureManifestSummary | undefined,
): EnvPromptCandidate[] {
  const out: EnvPromptCandidate[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    const summary = lookup(f.ref);
    const options = f.options ?? {};
    for (const [key, value] of Object.entries(options)) {
      if (typeof value !== 'string') continue;
      if (!optionHintNeeded(summary, key, options)) continue;
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
   * What the two files already hold. A value that is already set, here or in
   * the shared file, is not asked again: the builder filled it in once, and
   * a question for every key they keep in `monoceros-config.env` was noise.
   * The summary still says where each one comes from.
   */
  globalValues?: Record<string, string>;
  containerValues?: Record<string, string>;
  /** Injected by tests; defaults to a readline prompt on stdout. */
  ask?: (candidate: EnvPromptCandidate) => Promise<string | undefined>;
  output?: (line: string) => void;
  /** The summary line for a value that ends up set. Falls back to `output`. */
  success?: (line: string) => void;
}

/** Where a value already is, before the builder answers. */
export type EnvValueState = { source: 'container' | 'global' | 'none' };

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
  if ((containerValues[envVar] ?? '').trim()) return { source: 'container' };
  if ((globalValues[envVar] ?? '').trim()) return { source: 'global' };
  return { source: 'none' };
}

/** What one prompt shows: the question, and the hint. */
export function envPromptText(
  candidate: EnvPromptCandidate,
  opts: { containerEnvPath: string },
): { message: string; placeholder: string } {
  const who = candidate.feature ? ` (${candidate.feature})` : '';
  const lines = [`${candidate.envVar}${who} is not set yet`];
  if (candidate.description) lines.push(`ℹ ${candidate.description}`);
  const placeholder = `Enter skips it, fill it in later in ${opts.containerEnvPath}`;
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
  const states = candidates.map((candidate) => ({
    candidate,
    state: envValueState(
      candidate.envVar,
      opts.globalValues,
      opts.containerValues,
    ),
  }));
  const open = states.filter((s) => s.state.source === 'none').length;
  if (open > 0) out(`${opts.name} needs ${open} value${open > 1 ? 's' : ''}.`);

  const ask = opts.ask ?? ((c) => defaultAsk(c, opts));
  const summary: Array<{ set: boolean; line: string }> = [];
  for (const { candidate, state } of states) {
    let value = '';
    if (state.source === 'none') {
      const answer = await ask(candidate);
      value = typeof answer === 'string' ? answer.trim() : '';
      if (value.length > 0) answers[candidate.envVar] = value;
    }
    summary.push(summaryLine(candidate.envVar, value, state, opts));
  }
  // The summary starts a block of its own, apart from the last question.
  if (open > 0) process.stdout.write('\n');
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
  opts: PromptEnvValuesOptions,
): Promise<string | undefined> => {
  const c = colorsFor(process.stdout);
  const { message, placeholder } = envPromptText(candidate, opts);
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
