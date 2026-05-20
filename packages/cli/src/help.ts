import type { CommandDef } from 'citty';

/**
 * Custom help renderer. Citty's built-in `renderUsage` has two
 * issues for Monoceros:
 *
 *   1. It puts `[OPTIONS]` *before* the positional arguments in the
 *      USAGE line. We want positionals first, matching the
 *      `monoceros <command> <containername> [<args> …]` shape
 *      documented in konzept.md and docs/commands/README.md.
 *   2. It lists all subcommands in a flat pipe-separated USAGE line
 *      (`monoceros init|shell|run|…`) and a flat COMMANDS block.
 *      With 20+ commands that becomes unreadable.
 *
 * This module checks for `--help` / `-h` in argv before citty gets a
 * chance to print its own help. When triggered, it resolves the
 * matching subcommand and prints our own block: positional-first
 * USAGE, COMMANDS grouped by `meta.group`, and descriptions wrapped
 * to terminal width.
 */

interface ResolvedArg {
  name: string;
  type: 'positional' | 'string' | 'boolean' | 'number' | 'enum';
  required?: boolean;
  description?: string;
  default?: unknown;
  alias?: string | string[];
  valueHint?: string;
}

const ANSI_BOLD = '\x1b[1m';
const ANSI_UNDERLINE = '\x1b[4m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_GREY = '\x1b[90m';
const ANSI_RESET = '\x1b[0m';

function isTty(): boolean {
  return process.stdout.isTTY ?? false;
}

function color(text: string, ...codes: string[]): string {
  if (!isTty()) return text;
  return codes.join('') + text + ANSI_RESET;
}

const bold = (s: string) => color(s, ANSI_BOLD);
const underline = (s: string) => color(s, ANSI_UNDERLINE);
const cyan = (s: string) => color(s, ANSI_CYAN);
const grey = (s: string) => color(s, ANSI_GREY);

/**
 * Ordered list of command-group keys with a human-readable label.
 * Anything a command file tags via `meta.group` lands in the
 * matching bucket; anything ungrouped falls through to "Other".
 * The render order follows this array.
 */
const GROUPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'lifecycle', label: 'Container lifecycle' },
  { key: 'run', label: 'Run + inspect' },
  { key: 'edit', label: 'Edit container yml' },
  { key: 'discovery', label: 'Discovery' },
  { key: 'tooling', label: 'Tooling' },
];

function resolveArgs(
  argsDef: Record<string, unknown> | undefined,
): ResolvedArg[] {
  if (!argsDef) return [];
  const out: ResolvedArg[] = [];
  for (const [name, defRaw] of Object.entries(argsDef)) {
    const def = (defRaw ?? {}) as Partial<ResolvedArg>;
    out.push({
      name,
      type: (def.type as ResolvedArg['type']) ?? 'string',
      required: def.required,
      description: def.description,
      default: def.default,
      alias: def.alias,
      valueHint: def.valueHint,
    });
  }
  return out;
}

function renderValueHint(arg: ResolvedArg): string {
  if (arg.type === 'boolean') return '';
  const hint = arg.valueHint ?? arg.name;
  return `=<${hint}>`;
}

function renderArgDescription(arg: ResolvedArg, isRequired: boolean): string {
  const parts: string[] = [];
  if (arg.description) parts.push(arg.description);
  if (isRequired) parts.push(grey('(Required)'));
  if (arg.default !== undefined && arg.type !== 'boolean') {
    parts.push(grey(`(Default: ${JSON.stringify(arg.default)})`));
  }
  return parts.join(' ');
}

// Strip ANSI escape sequences so column-padding measurements use
// the visible width instead of the raw character count.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleLen(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

function terminalWidth(): number {
  return process.stdout.columns && process.stdout.columns > 40
    ? process.stdout.columns
    : 100;
}

/**
 * Wrap `text` (which may contain ANSI codes) to fit `width` columns,
 * with `continuationIndent` prepended to every wrapped line after
 * the first. Word-aware: breaks at spaces, falls back to hard breaks
 * only for individual tokens longer than `width`.
 */
function wrapText(
  text: string,
  width: number,
  continuationIndent: string,
): string {
  if (visibleLen(text) <= width) return text;
  // `width` is the budget for the actual text on each line — it does
  // not include the continuation indent (caller already accounted for
  // it when computing width). Continuation-line indent gets prefixed
  // at join time, so every line gets the same text-column budget.
  const words = text.split(/(\s+)/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (visibleLen(current) + visibleLen(w) <= width) {
      current += w;
      continue;
    }
    if (current.length > 0) lines.push(current.replace(/\s+$/, ''));
    current = w.replace(/^\s+/, '');
  }
  if (current.length > 0) lines.push(current.replace(/\s+$/, ''));
  return lines.map((l, i) => (i === 0 ? l : continuationIndent + l)).join('\n');
}

/**
 * Render a left-aligned label column next to wrapped descriptions.
 * Column gutter is four spaces. Description wraps within the
 * remaining terminal width.
 */
function alignTable(rows: Array<[string, string]>, indent: string): string {
  if (rows.length === 0) return '';
  const labelWidth = Math.max(...rows.map((r) => visibleLen(r[0])));
  const gutter = '    ';
  const descWidth =
    terminalWidth() - indent.length - labelWidth - gutter.length;
  const continuationIndent = ' '.repeat(
    indent.length + labelWidth + gutter.length,
  );
  return rows
    .map(([left, right]) => {
      const pad = ' '.repeat(labelWidth - visibleLen(left));
      const wrapped = wrapText(right, descWidth, continuationIndent);
      return `${indent}${left}${pad}${gutter}${wrapped}`;
    })
    .join('\n');
}

interface SubCommandEntry {
  name: string;
  description: string;
  group: string;
}

function collectSubCommands(cmd: CommandDef): SubCommandEntry[] {
  const subs = (cmd.subCommands ?? {}) as Record<string, CommandDef>;
  const out: SubCommandEntry[] = [];
  for (const [name, sub] of Object.entries(subs)) {
    const meta = (sub?.meta ?? {}) as {
      hidden?: boolean;
      description?: string;
      group?: string;
    };
    if (meta.hidden) continue;
    out.push({
      name,
      description: meta.description ?? '',
      group: meta.group ?? 'other',
    });
  }
  return out;
}

function renderCommandsBlock(entries: SubCommandEntry[]): string[] {
  if (entries.length === 0) return [];
  const lines: string[] = [];
  lines.push(underline(bold('COMMANDS')));

  // Group entries while preserving GROUPS' declared order. Anything
  // tagged with an unknown group (or no group) falls into "Other"
  // and renders last.
  const byGroup = new Map<string, SubCommandEntry[]>();
  for (const entry of entries) {
    const arr = byGroup.get(entry.group) ?? [];
    arr.push(entry);
    byGroup.set(entry.group, arr);
  }

  const renderSection = (label: string, items: SubCommandEntry[]) => {
    if (items.length === 0) return;
    lines.push('');
    lines.push(`  ${grey(label)}`);
    const rows: Array<[string, string]> = items.map((e) => [
      cyan(e.name),
      e.description,
    ]);
    lines.push(alignTable(rows, '    '));
  };

  for (const { key, label } of GROUPS) {
    renderSection(label, byGroup.get(key) ?? []);
    byGroup.delete(key);
  }
  // Anything left over (ungrouped or unknown-group) lands in a
  // catch-all section so nothing silently disappears.
  for (const [groupKey, items] of byGroup) {
    const label = groupKey === 'other' ? 'Other' : groupKey;
    renderSection(label, items);
  }

  lines.push('');
  return lines;
}

export function renderUsageBlock(
  cmd: CommandDef,
  commandPath: string[],
): string {
  const meta = (cmd.meta ?? {}) as {
    name?: string;
    description?: string;
    version?: string;
  };
  const args = resolveArgs((cmd.args ?? {}) as Record<string, unknown>);
  const subCommandEntries = collectSubCommands(cmd);

  const fullName = commandPath.join(' ') || meta.name || 'monoceros';

  const positionals = args.filter((a) => a.type === 'positional');
  const flags = args.filter((a) => a.type !== 'positional');

  // USAGE line: positionals come first, then [OPTIONS]. When the
  // command has subcommands, render a single `<command>` placeholder
  // instead of a pipe-separated list — anything more than a couple
  // of subcommands makes the pipe list unreadable, and the COMMANDS
  // block below carries the actual menu.
  const usageTokens: string[] = [];
  for (const p of positionals) {
    const isRequired = p.required !== false && p.default === undefined;
    const t = p.name.toUpperCase();
    usageTokens.push(isRequired ? `<${t}>` : `[${t}]`);
  }
  if (subCommandEntries.length > 0) usageTokens.push('<command>');
  if (flags.length > 0) usageTokens.push('[OPTIONS]');

  const lines: string[] = [];
  const version = meta.version;
  const header = `${meta.description ?? ''} (${fullName}${version ? ` v${version}` : ''})`;
  lines.push(grey(wrapText(header, terminalWidth(), '')));
  lines.push('');
  lines.push(
    `${underline(bold('USAGE'))} ${cyan([fullName, ...usageTokens].join(' '))}`,
  );
  lines.push('');

  if (positionals.length > 0) {
    lines.push(underline(bold('ARGUMENTS')));
    lines.push('');
    const rows: Array<[string, string]> = positionals.map((p) => {
      const isRequired = p.required !== false && p.default === undefined;
      return [cyan(p.name.toUpperCase()), renderArgDescription(p, isRequired)];
    });
    lines.push(alignTable(rows, '  '));
    lines.push('');
  }

  if (flags.length > 0) {
    lines.push(underline(bold('OPTIONS')));
    lines.push('');
    const rows: Array<[string, string]> = flags.map((f) => {
      const isRequired = f.required === true && f.default === undefined;
      const aliases = (
        Array.isArray(f.alias) ? f.alias : f.alias ? [f.alias] : []
      ).map((a) => `-${a}`);
      const label = [...aliases, `--${f.name}`].join(', ') + renderValueHint(f);
      return [cyan(label), renderArgDescription(f, isRequired)];
    });
    lines.push(alignTable(rows, '  '));
    lines.push('');
  }

  if (subCommandEntries.length > 0) {
    for (const line of renderCommandsBlock(subCommandEntries)) {
      lines.push(line);
    }
    lines.push(
      `Use ${cyan(`${fullName} <command> --help`)} for more information about a command.`,
    );
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Detect `--help` / `-h` somewhere in argv that's *not* preceded by
 * a separator `--`. Returns the command path so the caller can render
 * the right subcommand's help.
 *
 * Returns `null` when help wasn't requested at all.
 */
export function detectHelpRequest(
  argv: string[],
  main: CommandDef,
): { path: string[]; cmd: CommandDef } | null {
  const helpIdx = argv.findIndex((a) => a === '--help' || a === '-h');
  const separatorIdx = argv.indexOf('--');
  if (helpIdx === -1) return null;
  if (separatorIdx !== -1 && separatorIdx < helpIdx) return null;

  // Walk subcommands by matching argv tokens (in order, before --)
  // against the current command's `subCommands` map.
  const path: string[] = [];
  const tokens = argv.slice(
    0,
    separatorIdx === -1 ? argv.length : separatorIdx,
  );
  let cursor: CommandDef = main;
  const mainName = ((main.meta ?? {}) as { name?: string }).name ?? 'monoceros';
  path.push(mainName);
  for (const tok of tokens) {
    if (tok.startsWith('-')) continue;
    const subs = (cursor.subCommands ?? {}) as Record<string, CommandDef>;
    if (tok in subs) {
      cursor = subs[tok]!;
      path.push(tok);
      continue;
    }
    // Token isn't a subcommand name — stop walking. Any further
    // tokens are positionals/values for the current command, not
    // routing hints.
    break;
  }
  return { path, cmd: cursor };
}

/**
 * If argv requests --help, print our own usage block and tell the
 * caller to exit. Returns true when help was rendered.
 */
export async function maybeRenderHelp(
  argv: string[],
  main: CommandDef,
): Promise<boolean> {
  const hit = detectHelpRequest(argv, main);
  if (!hit) return false;
  // Resolve cmd's lazy fields (citty allows them to be functions)
  // before we render. We don't currently use lazy fields, so a
  // simple pass-through suffices.
  process.stdout.write(renderUsageBlock(hit.cmd, hit.path) + '\n');
  return true;
}
