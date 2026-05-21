// Shared terminal-formatting helpers for CLI output. Same palette
// as install.sh and packages/cli/src/help.ts:
//
//   cyan      = identifiers you type (commands, refs)
//   grey      = supplementary metadata (paths, version notes, hints)
//   bold+und. = structural section markers
//
// Status semantics (green ✓, red ✗, yellow !) live in consola for
// log-level lines and aren't duplicated here.
//
// All helpers gate on `process.stderr.isTTY` — when piped or
// captured, the ANSI codes drop out and the strings stay plain so
// downstream tooling (grep, log files) sees readable text.

const ESC = '\x1b[';
const ANSI_BOLD = `${ESC}1m`;
const ANSI_UNDERLINE = `${ESC}4m`;
const ANSI_CYAN = `${ESC}36m`;
const ANSI_GREY = `${ESC}90m`;
const ANSI_RESET = `${ESC}0m`;

function isTty(): boolean {
  return process.stderr.isTTY ?? false;
}

function wrap(s: string, ...codes: string[]): string {
  if (!isTty()) return s;
  return codes.join('') + s + ANSI_RESET;
}

export const bold = (s: string): string => wrap(s, ANSI_BOLD);
export const underline = (s: string): string => wrap(s, ANSI_UNDERLINE);
export const cyan = (s: string): string => wrap(s, ANSI_CYAN);
export const dim = (s: string): string => wrap(s, ANSI_GREY);

/**
 * Format a section marker — bold + underlined with a `▸` chevron
 * prefix. Same visual treatment as install.sh's section headers.
 * Caller is responsible for surrounding blank lines.
 */
export function sectionLine(label: string): string {
  return wrap(`▸ ${label}`, ANSI_BOLD, ANSI_UNDERLINE);
}
