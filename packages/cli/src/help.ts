import type { CommandDef } from 'citty';

/**
 * Custom help renderer. Citty's built-in `renderUsage` puts
 * `[OPTIONS]` *before* the positional arguments in the USAGE line:
 *
 *   monoceros status [OPTIONS] <NAME>
 *
 * For Monoceros we want positionals first — that matches how the
 * commands are actually invoked, and stays consistent with the
 * `monoceros <command> <containername> [<args> …]` shape documented
 * in konzept.md and docs/commands/README.md:
 *
 *   monoceros status <NAME> [OPTIONS]
 *
 * This module checks for `--help` / `-h` in argv before citty gets a
 * chance to print its own help. When triggered, it resolves the
 * matching subcommand and prints our own block (similar layout to
 * citty's, just with the positional/options order swapped). Citty
 * never sees the help flag, so its rendering doesn't fire.
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

function alignTable(rows: Array<[string, string]>, indent: string): string {
  if (rows.length === 0) return '';
  const visibleLen = (s: string) => s.replace(ANSI_RE, '').length;
  const width = Math.max(...rows.map((r) => visibleLen(r[0])));
  return rows
    .map(([left, right]) => {
      const pad = ' '.repeat(width - visibleLen(left));
      return `${indent}${left}${pad}    ${right}`;
    })
    .join('\n');
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
  const subCommands = (cmd.subCommands ?? {}) as Record<string, CommandDef>;

  const fullName = commandPath.join(' ') || meta.name || 'monoceros';

  const positionals = args.filter((a) => a.type === 'positional');
  const flags = args.filter((a) => a.type !== 'positional');

  // USAGE line: positionals come first, then [OPTIONS], then a hint
  // for subcommands when applicable. A positional is "required" iff
  // it's marked required and has no default.
  const usageTokens: string[] = [];
  for (const p of positionals) {
    const isRequired = p.required !== false && p.default === undefined;
    const t = p.name.toUpperCase();
    usageTokens.push(isRequired ? `<${t}>` : `[${t}]`);
  }
  const subCommandNames = Object.keys(subCommands).filter((n) => {
    const sub = subCommands[n];
    const subMeta = (sub?.meta ?? {}) as { hidden?: boolean };
    return !subMeta.hidden;
  });
  if (subCommandNames.length > 0) usageTokens.push(subCommandNames.join('|'));
  if (flags.length > 0) usageTokens.push('[OPTIONS]');

  const lines: string[] = [];
  const version = meta.version;
  const header = `${meta.description ?? ''} (${fullName}${version ? ` v${version}` : ''})`;
  lines.push(grey(header));
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

  if (subCommandNames.length > 0) {
    lines.push(underline(bold('COMMANDS')));
    lines.push('');
    const rows: Array<[string, string]> = [];
    for (const n of subCommandNames) {
      const sub = subCommands[n];
      const subMeta = (sub?.meta ?? {}) as { description?: string };
      rows.push([cyan(n), subMeta.description ?? '']);
    }
    lines.push(alignTable(rows, '  '));
    lines.push('');
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
