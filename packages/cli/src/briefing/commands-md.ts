import type { CommandDef } from 'citty';

/**
 * Generates `.monoceros/commands.md` — the per-subcommand reference
 * that `AGENTS.md` imports via `@.monoceros/commands.md` for any AI
 * tool inside the container that needs to know the exact shape of a
 * `monoceros` call before suggesting one.
 *
 * The data is read directly from the citty definitions in
 * `commands/*.ts` — those already carry `meta.description`,
 * `meta.group`, and per-arg `description`. No second source of truth.
 * `completion/resolve.ts`'s COMMAND_SPECS stays focused on completion
 * value sources only; descriptions live where citty needs them.
 *
 * Internal commands (`__complete`, `_dispatch`, `_stub`) are filtered
 * out — they're not user-facing.
 */

/** Mirrors help.ts's GROUPS ordering. Anything ungrouped goes to "Other". */
const GROUPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'lifecycle', label: 'Container lifecycle' },
  { key: 'run', label: 'Run + inspect' },
  { key: 'edit', label: 'Edit container yml' },
  { key: 'discovery', label: 'Discovery' },
  { key: 'tooling', label: 'Tooling' },
];

interface ArgSpec {
  name: string;
  type: 'positional' | 'string' | 'boolean' | 'number' | 'enum';
  required?: boolean;
  description?: string;
  default?: unknown;
  alias?: string | string[];
}

interface CommandEntry {
  name: string;
  group: string;
  description: string;
  positionals: ArgSpec[];
  flags: ArgSpec[];
}

export function generateCommandsMd(
  subCommands: Record<string, CommandDef | unknown>,
): string {
  const entries = collectEntries(subCommands);
  const grouped = groupEntries(entries);

  const lines: string[] = [];
  lines.push('# monoceros — Command reference');
  lines.push('');
  lines.push(
    'Auto-generated from the CLI definitions for the version of Monoceros',
    'that materialized this container. The host may have a newer version',
    '— if a flag listed here is not accepted, ask the user to run',
    '`monoceros --help` on the host for the live shape.',
  );
  lines.push('');

  for (const { label, items } of grouped) {
    if (items.length === 0) continue;
    lines.push(`## ${label}`);
    lines.push('');
    for (const entry of items) {
      lines.push(...renderEntry(entry));
    }
  }

  return lines.join('\n');
}

function collectEntries(
  subCommands: Record<string, CommandDef | unknown>,
): CommandEntry[] {
  const out: CommandEntry[] = [];
  for (const [name, raw] of Object.entries(subCommands)) {
    if (name.startsWith('_')) continue; // skip __complete, _dispatch, _stub
    const def = resolveCommandDef(raw);
    if (!def) continue;
    const meta = (def.meta ?? {}) as Record<string, unknown>;
    const description =
      typeof meta.description === 'string' ? meta.description : '';
    const group = typeof meta.group === 'string' ? meta.group : 'other';
    const args = (def.args ?? {}) as Record<string, unknown>;
    const { positionals, flags } = resolveArgs(args);
    out.push({ name, group, description, positionals, flags });
  }
  return out;
}

function groupEntries(
  entries: CommandEntry[],
): Array<{ label: string; items: CommandEntry[] }> {
  const byGroup = new Map<string, CommandEntry[]>();
  for (const entry of entries) {
    const bucket = byGroup.get(entry.group) ?? [];
    bucket.push(entry);
    byGroup.set(entry.group, bucket);
  }
  for (const bucket of byGroup.values()) {
    bucket.sort((a, b) => a.name.localeCompare(b.name));
  }

  const out: Array<{ label: string; items: CommandEntry[] }> = [];
  for (const { key, label } of GROUPS) {
    out.push({ label, items: byGroup.get(key) ?? [] });
    byGroup.delete(key);
  }
  // Anything leftover (e.g. ungrouped commands) goes under "Other".
  const leftover: CommandEntry[] = [];
  for (const bucket of byGroup.values()) leftover.push(...bucket);
  if (leftover.length > 0) {
    leftover.sort((a, b) => a.name.localeCompare(b.name));
    out.push({ label: 'Other', items: leftover });
  }
  return out;
}

function resolveCommandDef(raw: unknown): CommandDef | null {
  // citty's defineCommand can return either a CommandDef object or a
  // function returning one (lazy form). We only see the eager form in
  // the codebase today; guard for both just in case.
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'function') return null; // not used today; skip
  if (typeof raw === 'object') return raw as CommandDef;
  return null;
}

function resolveArgs(argsDef: Record<string, unknown>): {
  positionals: ArgSpec[];
  flags: ArgSpec[];
} {
  const positionals: ArgSpec[] = [];
  const flags: ArgSpec[] = [];
  for (const [name, defRaw] of Object.entries(argsDef)) {
    const def = (defRaw ?? {}) as Partial<ArgSpec>;
    const spec: ArgSpec = {
      name,
      type: (def.type as ArgSpec['type']) ?? 'string',
      ...(def.required !== undefined ? { required: def.required } : {}),
      ...(def.description ? { description: def.description } : {}),
      ...(def.default !== undefined ? { default: def.default } : {}),
      ...(def.alias ? { alias: def.alias } : {}),
    };
    if (spec.type === 'positional') {
      positionals.push(spec);
    } else {
      flags.push(spec);
    }
  }
  return { positionals, flags };
}

function renderEntry(entry: CommandEntry): string[] {
  const sig = signature(entry);
  const lines: string[] = [];
  lines.push(`### \`${sig}\``);
  lines.push('');
  if (entry.description) {
    lines.push(entry.description);
    lines.push('');
  }
  if (entry.positionals.length > 0) {
    lines.push('Arguments:');
    lines.push('');
    for (const p of entry.positionals) {
      lines.push(
        `- \`${p.name}\`${p.required ? '' : ' (optional)'}` +
          (p.description ? ` — ${p.description}` : ''),
      );
    }
    lines.push('');
  }
  if (entry.flags.length > 0) {
    lines.push('Flags:');
    lines.push('');
    for (const f of entry.flags) {
      lines.push(renderFlagBullet(f));
    }
    lines.push('');
  }
  return lines;
}

function signature(entry: CommandEntry): string {
  const parts: string[] = [`monoceros ${entry.name}`];
  for (const p of entry.positionals) {
    parts.push(p.required ? `<${p.name}>` : `[${p.name}]`);
  }
  if (entry.flags.length > 0) {
    parts.push('[flags]');
  }
  return parts.join(' ');
}

function renderFlagBullet(flag: ArgSpec): string {
  const names = [`--${flag.name}`];
  if (flag.alias) {
    const aliases = Array.isArray(flag.alias) ? flag.alias : [flag.alias];
    for (const a of aliases) names.push(`-${a}`);
  }
  const head = names.map((n) => `\`${n}\``).join(' / ');
  const value =
    flag.type === 'boolean'
      ? ''
      : flag.type === 'number'
        ? ' <number>'
        : ' <value>';
  const desc = flag.description ? ` — ${flag.description}` : '';
  return `- ${head}${value}${desc}`;
}
