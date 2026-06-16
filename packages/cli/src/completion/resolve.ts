import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { monocerosHome } from '../config/paths.js';
import { loadComponentCatalog } from '../init/components.js';
import { loadFeatureManifestSummary } from '../init/manifest.js';
import { knownLanguages, knownServices } from '../create/catalog.js';
import { PROVIDER_VALUES, REGEX } from '../config/schema.js';
import { OPEN_TOOLS } from '../open/index.js';

/**
 * Shell-agnostic completion engine. Called by the `__complete`
 * internal CLI command and (in tests) directly via `resolveCompletions`.
 *
 * The caller hands us the full command-line buffer (`line`) plus the
 * cursor's byte offset within it (`point`). We tokenize the prefix,
 * figure out which positional / flag is being completed, and return
 * a list of candidate completions matching the current token fragment.
 *
 * Tokenization rules:
 *   - Whitespace separates tokens.
 *   - Double or single quotes group a run including whitespace; we
 *     return the un-quoted content as the token (the shell glue
 *     re-quotes when emitting).
 *   - A `--key=value` form is one token; the equals sign isn't a
 *     separator. Inside `--with-features=github,claude` we treat the part
 *     after `=` as the current value-fragment for the `--with-features` flag.
 *
 * Per-command suggestions live in `COMMAND_SPECS`. Adding a new
 * command means adding (or extending) one entry there — the engine
 * dispatches automatically.
 *
 * Source of truth is citty's command definitions; the spec table is
 * a thin mirror keyed by command name. A test (`completion.test.ts`)
 * pins the spec keys against the live command list.
 */

// ─── Public surface ───────────────────────────────────────────────

export interface ResolveOptions {
  /** Override of MONOCEROS_HOME (tests). */
  monocerosHome?: string;
}

export async function resolveCompletions(
  line: string,
  point: number,
  opts: ResolveOptions = {},
): Promise<string[]> {
  const { prev, current } = parseCompletionLine(line, point);
  const ctx: Ctx = { prev, current, opts };
  // prev[0] is the program name (usually "monoceros"); skip it.
  const head = prev[0];
  const afterProgram = head === undefined ? [] : prev.slice(1);
  // No subcommand typed yet → suggest the subcommand list.
  if (afterProgram.length === 0) {
    return filterPrefix(ALL_COMMANDS, current);
  }
  const command = afterProgram[0]!;
  const spec = COMMAND_SPECS[command];
  if (!spec) {
    // Unknown subcommand. We've already entered position 2+, but the
    // command isn't one we know — no useful suggestions.
    return [];
  }
  // Tokens that belong to the command's args (past `monoceros <cmd>`).
  const argTokens = afterProgram.slice(1);
  return dispatchCommand(spec, argTokens, ctx);
}

// ─── Tokenizer + cursor-context parser ────────────────────────────

interface CompletionContext {
  /** Tokens to the LEFT of the one being completed. */
  prev: string[];
  /** The token currently under the cursor (or `''` at a fresh word). */
  current: string;
}

interface Ctx extends CompletionContext {
  opts: ResolveOptions;
}

export function parseCompletionLine(
  line: string,
  point: number,
): CompletionContext {
  const before = line.slice(0, Math.max(0, Math.min(point, line.length)));
  const tokens = tokenize(before);
  // If the cursor sits right after whitespace, the user is starting a
  // fresh token — current is empty, all preceding tokens are "prev".
  const lastChar = before.length > 0 ? before[before.length - 1]! : '';
  if (tokens.length === 0 || isShellWhitespace(lastChar)) {
    return { prev: tokens, current: '' };
  }
  return {
    prev: tokens.slice(0, -1),
    current: tokens[tokens.length - 1]!,
  };
}

function tokenize(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && isShellWhitespace(text[i]!)) i++;
    if (i >= text.length) break;
    let token = '';
    let quote: '"' | "'" | null = null;
    while (i < text.length) {
      const ch = text[i]!;
      if (quote === null && isShellWhitespace(ch)) break;
      if (quote === null && (ch === '"' || ch === "'")) {
        quote = ch;
        i++;
        continue;
      }
      if (quote !== null && ch === quote) {
        quote = null;
        i++;
        continue;
      }
      token += ch;
      i++;
    }
    out.push(token);
  }
  return out;
}

function isShellWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t';
}

// ─── Per-command dispatch ─────────────────────────────────────────

type ValueSource = (ctx: Ctx) => Promise<string[]> | string[];

interface FlagSpec {
  /** `boolean` = no value; `value` = `--flag <X>` or `--flag=<X>`. */
  type: 'boolean' | 'value';
  /** Short forms, e.g. `['-y']`. */
  aliases?: string[];
  /** Value suggestions for `value`-typed flags. Optional → freeform. */
  values?: ValueSource;
}

interface CommandSpec {
  /**
   * Suggestion sources for positional args, indexed by position
   * (0 = arg right after the command name). Missing entries mean
   * the slot exists but has no completion source (e.g. `init`'s
   * fresh-name positional — we don't suggest existing container
   * names there, that would invite collisions).
   */
  positionals?: ValueSource[];
  /**
   * How many positionals the command expects. Defaults to
   * `positionals.length`. Set this explicitly when the command has
   * MORE positional slots than entries in `positionals` (= "this
   * slot exists but has no suggestion source"). Once the cursor sits
   * past `positionalCount`, completion falls back to flag names so
   * the builder discovers `--with-*` / `--yes` etc. via Tab.
   */
  positionalCount?: number;
  /** Flag table. Keys include the leading `--`. */
  flags?: Record<string, FlagSpec>;
  /**
   * Suggestion source for tokens after `--` (inner args). Used by
   * `add-feature -- key=value` and `add-apt-packages -- pkg pkg …`.
   */
  innerArgs?: ValueSource;
}

function dispatchCommand(
  spec: CommandSpec,
  argTokens: string[],
  ctx: Ctx,
): Promise<string[]> | string[] {
  // Split argTokens at the `--` separator: tokens after it are inner
  // args (consumed by `innerArgs`); tokens before it are positionals
  // and flags consumed by `resolvePreDash`. We only need preDash —
  // the post-dash tokens are read directly off ctx.prev by per-command
  // innerArgs sources that care (see listFeatureOptionInnerArgs).
  const dashDashIdx = argTokens.indexOf('--');
  const preDash = dashDashIdx < 0 ? argTokens : argTokens.slice(0, dashDashIdx);
  const inPostDash = dashDashIdx >= 0;

  if (inPostDash && spec.innerArgs) {
    return resolveValues(spec.innerArgs, ctx, ctx.current);
  }

  // Post-dash but no inner-arg source (e.g. `run`, where everything
  // after `--` is a freeform inner command): suggest nothing and let the
  // shell complete the inner command itself. Without this guard the
  // command's own flags (e.g. run's `--in`) would leak into the
  // inner-command slot.
  if (inPostDash) return [];

  // Pre-dash: figure out whether `current` is a value for a flag we
  // started typing, or a fresh positional / flag-name slot.
  return resolvePreDash(spec, preDash, ctx);
}

async function resolvePreDash(
  spec: CommandSpec,
  preDash: string[],
  ctx: Ctx,
): Promise<string[]> {
  const current = ctx.current;

  // Case A: current looks like `--flag=…` → suggest values for that flag.
  if (current.startsWith('--') && current.includes('=')) {
    const eqIdx = current.indexOf('=');
    const flagName = current.slice(0, eqIdx);
    const valueFragment = current.slice(eqIdx + 1);
    const flag = spec.flags?.[flagName];
    if (!flag || flag.type !== 'value' || !flag.values) return [];
    const completions = await resolveValues(flag.values, ctx, valueFragment);
    // Re-emit with the `--flag=` prefix attached so the shell inserts
    // the full token in place.
    return completions.map((v) => `${flagName}=${v}`);
  }

  // Case B: current starts with `-` (incomplete flag name).
  if (current.startsWith('-')) {
    return listFlagNames(spec.flags ?? {}, current);
  }

  // Case C: previous token was `--flag` (no `=`) expecting a value.
  const lastPrev = preDash[preDash.length - 1];
  if (lastPrev && lastPrev.startsWith('--') && !lastPrev.includes('=')) {
    const flag = spec.flags?.[lastPrev];
    if (flag && flag.type === 'value' && flag.values) {
      return resolveValues(flag.values, ctx, current);
    }
  }

  // Case D: positional. Count how many positionals have been completed
  // already — that's any preDash token that isn't itself a flag or a
  // flag-value pair we passed through.
  const positionalIdx = countCompletedPositionals(preDash, spec.flags ?? {});
  const positionals = spec.positionals ?? [];
  const expectedPositionalCount = spec.positionalCount ?? positionals.length;

  // Still inside a defined positional slot → use its source.
  if (positionalIdx < positionals.length) {
    const positional = positionals[positionalIdx];
    if (positional) return resolveValues(positional, ctx, current);
  }
  // Past all expected positionals → surface available flags so Tab
  // discovers them without the builder having to know they exist
  // (and without having to start with a `-`).
  if (positionalIdx >= expectedPositionalCount) {
    return listFlagNames(spec.flags ?? {}, current);
  }
  // Slot is expected but has no completion source (e.g. `init`'s
  // fresh-name positional, `restore`'s backup-path). Don't suggest
  // anything — let the shell fall through to its built-in handling.
  return [];
}

/**
 * Flag-name suggestion list filtered against the partial token under
 * the cursor. Includes long names (`--with-features`) and short aliases (`-y`).
 *
 * Value-flags are emitted WITH a trailing `=` (`--with-features=`) so the shell
 * wrappers can use `compopt -o nospace` (bash) / `compadd -S ''` (zsh)
 * to suppress the auto-added trailing space — without that, picking
 * `--with-ports` via Tab and typing `=3000` afterwards produces the
 * broken `--with-ports =3000` (space between flag and value).
 *
 * Boolean flags (no value expected) stay as bare names so the shell's
 * normal trailing-space behaviour applies — after `--yes` you really
 * do want a space.
 */
function listFlagNames(
  flags: Record<string, FlagSpec>,
  fragment: string,
): string[] {
  const names: string[] = [];
  for (const [name, spec] of Object.entries(flags)) {
    names.push(spec.type === 'value' ? `${name}=` : name);
    for (const alias of spec.aliases ?? []) names.push(alias);
  }
  return filterPrefix(names, fragment);
}

function countCompletedPositionals(
  preDash: string[],
  flags: Record<string, FlagSpec>,
): number {
  let count = 0;
  for (let i = 0; i < preDash.length; i++) {
    const t = preDash[i]!;
    if (t.startsWith('--') && t.includes('=')) continue; // `--flag=value` — a flag, not a positional
    if (t.startsWith('-')) {
      // Boolean flag → 1 token, value flag → 2 tokens (consume next).
      const flag = flags[t] ?? aliasFlag(flags, t);
      if (flag && flag.type === 'value' && i + 1 < preDash.length) {
        i++; // skip the value
      }
      continue;
    }
    count++;
  }
  return count;
}

function aliasFlag(
  flags: Record<string, FlagSpec>,
  token: string,
): FlagSpec | undefined {
  for (const f of Object.values(flags)) {
    if (f.aliases?.includes(token)) return f;
  }
  return undefined;
}

async function resolveValues(
  source: ValueSource,
  ctx: Ctx,
  fragment: string,
): Promise<string[]> {
  const values = await source(ctx);
  // For comma-separated value flags (`--with-features=github,claude`) the
  // user may have typed `github,cl` — the fragment to filter against is the
  // part AFTER the last comma.
  const commaIdx = fragment.lastIndexOf(',');
  if (commaIdx < 0) {
    return filterPrefix(values, fragment);
  }
  const prefix = fragment.slice(0, commaIdx + 1);
  const tail = fragment.slice(commaIdx + 1);
  return filterPrefix(values, tail).map((v) => `${prefix}${v}`);
}

function filterPrefix(values: readonly string[], fragment: string): string[] {
  if (fragment.length === 0) return [...values];
  return values.filter((v) => v.startsWith(fragment));
}

// ─── Value sources ────────────────────────────────────────────────

async function listContainerNames(ctx: Ctx): Promise<string[]> {
  const home = ctx.opts.monocerosHome ?? monocerosHome();
  const dir = path.join(home, 'container-configs');
  if (!existsSync(dir)) return [];
  const entries = await fs.readdir(dir);
  return entries
    .filter((e) => e.endsWith('.yml'))
    .map((e) => e.slice(0, -'.yml'.length))
    .sort();
}

async function listFeatureComponents(): Promise<string[]> {
  const catalog = await loadComponentCatalog();
  return [...catalog.values()]
    .filter((c) => c.file.category === 'feature')
    .map((c) => c.name)
    .sort();
}

function listLanguageNames(): string[] {
  return knownLanguages().sort();
}

function listServiceNames(): string[] {
  return knownServices().sort();
}

function listProviders(): string[] {
  return [...PROVIDER_VALUES];
}

function listShellNames(): string[] {
  return ['bash', 'zsh', 'pwsh'];
}

/**
 * Inner-arg completion for `monoceros add-feature <name> <feature> --
 * key=value …`. The `<feature>` token can be either a catalog short
 * name (`atlassian`, `atlassian/twg`) or a full OCI ref; in both cases
 * we resolve to the feature manifest and return the option keys.
 *
 * Behaviour with the current token:
 *   - Token is empty or contains no `=` → suggest the option NAMES
 *     (filtered against the partial token prefix).
 *   - Token is `<key>=<fragment>` AND the key is a boolean → suggest
 *     `<key>=true` / `<key>=false` matching `<fragment>`. For string
 *     options we have no useful default suggestion list (it's
 *     freeform credentials / URLs).
 *   - Already-typed `key=value` pairs (before the current token) drop
 *     the same `key=` from the suggestion list so the builder doesn't
 *     get duplicates.
 */
async function listFeatureOptionInnerArgs(ctx: Ctx): Promise<string[]> {
  // Locate the feature token. ctx.prev[0] is the program name, [1] is
  // `add-feature`, [2] is the container name, [3] is the feature.
  // The user could have added flags like `--yes` before the feature,
  // but flag tokens always start with `-`. So the feature is the
  // SECOND non-flag positional after the command.
  const after = ctx.prev.slice(2); // drop "monoceros", "add-feature"
  let positionalCount = 0;
  let featureToken: string | undefined;
  for (let i = 0; i < after.length; i++) {
    const t = after[i]!;
    if (t === '--') break; // stop at the inner-args separator
    if (t.startsWith('-')) continue; // flag
    positionalCount++;
    if (positionalCount === 2) {
      featureToken = t;
      break;
    }
  }
  if (!featureToken) return [];
  const ref = await resolveFeatureRefForCompletion(featureToken);
  if (!ref) return [];
  const summary = loadFeatureManifestSummary(ref);
  if (!summary) return [];

  // Which keys has the builder already set in earlier inner-args?
  const dashDash = ctx.prev.indexOf('--');
  const innerSoFar = dashDash >= 0 ? ctx.prev.slice(dashDash + 1) : [];
  const usedKeys = new Set<string>();
  for (const t of innerSoFar) {
    const eq = t.indexOf('=');
    if (eq > 0) usedKeys.add(t.slice(0, eq));
  }

  // Current token: `key=value` or just `key`?
  const eqIdx = ctx.current.indexOf('=');
  if (eqIdx >= 0) {
    const key = ctx.current.slice(0, eqIdx);
    const valueFragment = ctx.current.slice(eqIdx + 1);
    const type = summary.optionTypes[key];
    if (type === 'boolean') {
      return ['true', 'false']
        .filter((v) => v.startsWith(valueFragment))
        .map((v) => `${key}=${v}`);
    }
    // String options: no useful suggestion list. Return [] so the
    // shell falls back to its own filename / nothing handling.
    return [];
  }

  // Plain key fragment — suggest the still-unused option keys WITH a
  // trailing `=` so the shell wrappers' nospace logic kicks in (same
  // shape as `--with-features=` etc. on the flag side). Without that, the
  // user gets `instance =foo` instead of `instance=foo` after Tab +
  // manual `=foo`.
  return summary.optionNames
    .filter((n) => !usedKeys.has(n))
    .map((n) => `${n}=`);
}

/**
 * Bridge between the short-name / full-ref formats the user types
 * for `add-feature <feature>` and the OCI ref the manifest loader
 * needs. A no-op for full OCI refs; a single catalog lookup for short
 * names. Returns `undefined` for unknown short-names (no completions).
 */
async function resolveFeatureRefForCompletion(
  token: string,
): Promise<string | undefined> {
  if (REGEX.featureRef.test(token)) return token;
  const catalog = await loadComponentCatalog();
  const c = catalog.get(token);
  if (!c || c.file.category !== 'feature') return undefined;
  const f = c.file.contributes.features?.[0];
  return f?.ref;
}

// ─── Static command list (mirrors completion.ts) ──────────────────

const ALL_COMMANDS = [
  'init',
  'list-components',
  'shell',
  'open',
  'run',
  'logs',
  'start',
  'stop',
  'status',
  'apply',
  'upgrade',
  'remove',
  'restore',
  'add-service',
  'add-language',
  'add-apt-packages',
  'add-feature',
  'add-from-url',
  'add-repo',
  'add-port',
  'remove-service',
  'remove-language',
  'remove-apt-packages',
  'remove-feature',
  'remove-from-url',
  'remove-repo',
  'remove-port',
  'port',
  'tunnel',
  'completion',
] as const;

// ─── Command specs ────────────────────────────────────────────────

const containerName: ValueSource = (ctx) => listContainerNames(ctx);

const COMMAND_SPECS: Record<string, CommandSpec> = {
  init: {
    // First positional is a FRESH name → no suggestion source, but
    // the slot exists. Once the cursor is past it (after the name +
    // space), `--with` / `--with-repo` / `--with-ports` surface as
    // flag suggestions.
    positionalCount: 1,
    flags: {
      '--with-languages': { type: 'value', values: () => listLanguageNames() },
      '--with-features': {
        type: 'value',
        values: () => listFeatureComponents(),
      },
      '--with-services': { type: 'value', values: () => listServiceNames() },
      '--with-apt-packages': { type: 'value' },
      '--with-repos': { type: 'value' },
      '--with-ports': { type: 'value' },
    },
  },
  apply: {
    positionals: [containerName],
    flags: {
      '--yes': { type: 'boolean', aliases: ['-y'] },
      '--open': { type: 'value', values: () => [...OPEN_TOOLS] },
    },
  },
  upgrade: {
    // First positional is a container name; the second is a version
    // string (no suggestions — versions live in the registry).
    positionals: [containerName, () => []],
    flags: { '--list': { type: 'boolean' } },
  },
  remove: {
    positionals: [containerName],
    flags: {
      '--yes': { type: 'boolean', aliases: ['-y'] },
      '--no-backup': { type: 'boolean' },
    },
  },
  shell: { positionals: [containerName] },
  open: { positionals: [containerName, () => [...OPEN_TOOLS]] },
  run: {
    positionals: [containerName],
    flags: { '--in': { type: 'value' } },
  },
  logs: { positionals: [containerName] },
  start: {
    positionals: [containerName],
    flags: { '--open': { type: 'value', values: () => [...OPEN_TOOLS] } },
  },
  stop: { positionals: [containerName] },
  status: { positionals: [containerName] },
  'add-language': {
    positionals: [containerName, () => listLanguageNames()],
  },
  'add-service': {
    positionals: [containerName, () => listServiceNames()],
  },
  'add-apt-packages': {
    positionals: [containerName],
    innerArgs: () => [], // freeform package names — no useful suggestion list
  },
  'add-feature': {
    positionals: [containerName, () => listFeatureComponents()],
    flags: { '--yes': { type: 'boolean', aliases: ['-y'] } },
    innerArgs: (ctx) => listFeatureOptionInnerArgs(ctx),
  },
  'add-from-url': { positionals: [containerName] },
  'add-repo': {
    positionals: [containerName],
    flags: {
      '--path': { type: 'value' },
      '--git-name': { type: 'value' },
      '--git-email': { type: 'value' },
      '--provider': { type: 'value', values: () => listProviders() },
      '--yes': { type: 'boolean', aliases: ['-y'] },
    },
  },
  'add-port': {
    positionals: [containerName],
    flags: {
      '--default': { type: 'boolean' },
      '--yes': { type: 'boolean', aliases: ['-y'] },
    },
    innerArgs: () => [],
  },
  'remove-language': {
    positionals: [containerName, () => listLanguageNames()],
  },
  'remove-service': {
    positionals: [containerName, () => listServiceNames()],
  },
  'remove-apt-packages': {
    positionals: [containerName],
    innerArgs: () => [],
  },
  'remove-feature': {
    positionals: [containerName, () => listFeatureComponents()],
    flags: { '--yes': { type: 'boolean', aliases: ['-y'] } },
  },
  'remove-from-url': { positionals: [containerName] },
  'remove-repo': { positionals: [containerName] },
  'remove-port': {
    positionals: [containerName],
    flags: { '--yes': { type: 'boolean', aliases: ['-y'] } },
    innerArgs: () => [],
  },
  port: {
    positionals: [containerName],
    flags: { '--default': { type: 'boolean' } },
    innerArgs: () => [],
  },
  tunnel: {
    positionals: [containerName, () => listServiceNames()],
    flags: {
      '--local-port': { type: 'value' },
      '--local-address': { type: 'value' },
    },
  },
  completion: {
    positionals: [() => listShellNames()],
  },
  'list-components': {},
  restore: {
    // First positional is a backup-path; no value suggestions today
    // (could plug filesystem completion later). Slot still exists so
    // Tab is silent inside it rather than offering flags prematurely.
    positionalCount: 1,
  },
};

/** Exposed for tests so the command list stays in sync with main.ts. */
export const COMPLETION_ALL_COMMANDS = ALL_COMMANDS;
export const COMPLETION_COMMAND_SPEC_KEYS = Object.keys(COMMAND_SPECS);
