// Shared terminal-formatting helpers for CLI output. Same palette
// as install.sh and packages/cli/src/help.ts:
//
//   cyan      = identifiers you type (commands, refs, component names)
//   grey      = supplementary metadata (paths, version notes, hints)
//   bold+und. = structural section markers
//
// Status semantics (green ✓, red ✗, yellow !) live in consola for
// log-level lines and aren't duplicated here.
//
// Two flavours of consumer:
//   - status output (install.sh, apply) goes to stderr — use the
//     top-level helpers below; they gate on process.stderr.isTTY.
//   - data output (list-components) goes to stdout — use
//     `colorsFor(process.stdout)` to get the same helpers gated
//     against the right stream, so colours drop out cleanly when
//     the user pipes the output into grep/less/etc.

const ESC = '\x1b[';
const ANSI_BOLD = `${ESC}1m`;
const ANSI_UNDERLINE = `${ESC}4m`;
const ANSI_CYAN = `${ESC}36m`;
const ANSI_GREEN = `${ESC}32m`;
const ANSI_GREY = `${ESC}90m`;
const ANSI_RESET = `${ESC}0m`;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Visible character count, ANSI escape sequences stripped. Used
 * for column-padding so coloured labels still line up.
 */
export function visibleLen(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

/**
 * Remove ANSI colour/style escape sequences from a string. Used by
 * the apply log sink so log files stay readable in plain `cat`.
 */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export interface Palette {
  bold: (s: string) => string;
  underline: (s: string) => string;
  cyan: (s: string) => string;
  /** Green — a "running / up" status marker (`✓`). */
  green: (s: string) => string;
  dim: (s: string) => string;
  /**
   * Section marker — bold + underlined with a `▸` chevron prefix.
   * Same visual treatment as install.sh's section headers.
   */
  sectionLine: (label: string) => string;
}

function makeWrap(isTty: boolean): (s: string, ...codes: string[]) => string {
  return (s, ...codes) => (isTty ? codes.join('') + s + ANSI_RESET : s);
}

function makePalette(isTty: boolean): Palette {
  const wrap = makeWrap(isTty);
  return {
    bold: (s) => wrap(s, ANSI_BOLD),
    underline: (s) => wrap(s, ANSI_UNDERLINE),
    cyan: (s) => wrap(s, ANSI_CYAN),
    green: (s) => wrap(s, ANSI_GREEN),
    dim: (s) => wrap(s, ANSI_GREY),
    sectionLine: (label) => wrap(`▸ ${label}`, ANSI_BOLD, ANSI_UNDERLINE),
  };
}

/**
 * Resolve a stream-specific palette. Pass `process.stdout` for
 * commands whose payload goes to stdout (so colours drop out when
 * piped); `process.stderr` for status output that stays on stderr
 * regardless of stdout's destination.
 */
export function colorsFor(stream: NodeJS.WriteStream): Palette {
  return makePalette(stream.isTTY ?? false);
}

// Top-level convenience helpers — gated on stderr, matching the
// install-/apply-style status output that's always written to
// stderr. Existing call sites keep working unchanged.
const stderrPalette = makePalette(process.stderr.isTTY ?? false);
export const bold = stderrPalette.bold;
export const underline = stderrPalette.underline;
export const cyan = stderrPalette.cyan;
export const green = stderrPalette.green;
export const dim = stderrPalette.dim;
export const sectionLine = stderrPalette.sectionLine;
