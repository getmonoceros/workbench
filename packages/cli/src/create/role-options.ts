import { matchMonocerosFeature } from '../util/ref.js';
import type { CreateOptions } from './types.js';

/**
 * Validate the model and effort options on the two roles components at APPLY,
 * before anything is built.
 *
 * Why this exists: a role's model lands verbatim in the agent's frontmatter,
 * and nothing between the yml and the running agent looks at it. A real run
 * had `implementModel: "sonet"` and the failure surfaced only when the chain
 * was already underway: the subagent refused to start, the session picked its
 * own replacement, and the run finished on a model nobody had chosen - at
 * roughly twice the cost. The yml was wrong for the whole run and said so
 * nowhere.
 *
 * Catching a typo here costs a second. Catching it at run time costs the run.
 *
 * What is checked and what deliberately is not:
 *   - **Claude models** are a closed set of aliases plus full ids, so an
 *     unknown value is a typo and is rejected with a suggestion.
 *   - **Claude effort** is a closed set of five levels. Same treatment.
 *   - **OpenCode models** are `provider/model-id` against a provider universe
 *     Monoceros does not own, so only the shape is enforced. A wrong id is the
 *     provider's error message, not ours to predict.
 *   - **OpenCode effort** maps to a model variant, and which variants exist
 *     comes from the model. There is nothing to validate against, so it is
 *     passed through untouched.
 */

/** Model aliases Claude Code accepts, beyond a full `claude-…` id. */
const CLAUDE_MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/** Effort levels Claude Code accepts. */
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const CLAUDE_MODEL_OPTIONS = [
  'plannerModel',
  'implementModel',
  'reviewModel',
] as const;
const EFFORT_OPTIONS = [
  'plannerEffort',
  'implementEffort',
  'reviewEffort',
] as const;
const OPENCODE_MODEL_OPTIONS = CLAUDE_MODEL_OPTIONS;

/**
 * Levenshtein distance, capped at what a "did you mean" is worth. Small and
 * local: this is the only place in the CLI that needs one.
 */
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(
        prev[j]! + 1,
        prev[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = prev[j]!;
      prev[j] = next;
    }
  }
  return prev[b.length]!;
}

/** The closest candidate, when one is close enough to be worth naming. */
function suggest(value: string, candidates: readonly string[]): string {
  let best = '';
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = distance(value.toLowerCase(), c);
    if (d < bestDistance) {
      bestDistance = d;
      best = c;
    }
  }
  // Two edits on a short word is still recognisably the same word; beyond
  // that a suggestion is noise ("did you mean sonnet?" for "gpt-4").
  return bestDistance <= 2 ? ` Did you mean '${best}'?` : '';
}

function optionsFor(
  features: CreateOptions['features'],
  name: string,
): Record<string, unknown> | undefined {
  if (!features) return undefined;
  const entry = Object.entries(features).find(
    ([ref]) => matchMonocerosFeature(ref)?.name === name,
  );
  return entry ? (entry[1] ?? {}) : undefined;
}

function value(
  options: Record<string, unknown> | undefined,
  key: string,
): string {
  const raw = options?.[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

export function validateRoleOptions(features: CreateOptions['features']): void {
  const claude = optionsFor(features, 'claude-code-roles');
  if (claude) {
    for (const key of CLAUDE_MODEL_OPTIONS) {
      const model = value(claude, key);
      if (!model) continue;
      // A full id is anything the API would take; we only know it starts with
      // the family name, and pinning the exact list here would age badly.
      if (model.startsWith('claude-')) continue;
      if ((CLAUDE_MODEL_ALIASES as readonly string[]).includes(model)) continue;
      throw new Error(
        `claude-code-roles: unknown model '${model}' for ${key}.` +
          `${suggest(model, CLAUDE_MODEL_ALIASES)}` +
          ` Use one of ${CLAUDE_MODEL_ALIASES.join(', ')}, or a full model id like 'claude-opus-5'.`,
      );
    }
    for (const key of EFFORT_OPTIONS) {
      const effort = value(claude, key);
      if (!effort) continue;
      if ((CLAUDE_EFFORTS as readonly string[]).includes(effort)) continue;
      throw new Error(
        `claude-code-roles: unknown effort '${effort}' for ${key}.` +
          `${suggest(effort, CLAUDE_EFFORTS)}` +
          ` Use one of ${CLAUDE_EFFORTS.join(', ')}.`,
      );
    }
  }

  const opencode = optionsFor(features, 'opencode-roles');
  if (opencode) {
    for (const key of OPENCODE_MODEL_OPTIONS) {
      const model = value(opencode, key);
      if (!model) continue;
      // Shape only: `provider/model-id`, where the id may itself contain
      // slashes (openrouter/moonshotai/kimi-k3). Which ids exist is the
      // provider's business.
      if (/^[a-z0-9][a-z0-9._-]*\/\S+$/i.test(model)) continue;
      throw new Error(
        `opencode-roles: '${model}' for ${key} is not a 'provider/model-id' reference.` +
          ` Write it the way OpenCode does, e.g. 'anthropic/claude-sonnet-5' or 'openrouter/moonshotai/kimi-k3'.`,
      );
    }
    // Effort maps to a model variant here, and the accepted values come from
    // the model rather than from us. Nothing to check.
  }
}
