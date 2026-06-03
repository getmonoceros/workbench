import { defineCommand } from 'citty';

/**
 * `monoceros completion <shell>` — prints a shell-completion script
 * for bash, zsh or PowerShell to stdout. The user pipes the output
 * into a file their shell sources at startup.
 *
 * Architecture: the printed script is a THIN wrapper. The actual
 * completion logic lives in the CLI itself behind
 * `monoceros __complete --line "<buffer>" --point <N>`, which reads
 * the cursor's view of the line and returns one candidate per line
 * on stdout. The shell script's only job is:
 *
 *   1. Capture the current line + cursor position from the shell's
 *      completion variables (COMP_LINE/COMP_POINT, BUFFER/CURSOR,
 *      $commandAst/$cursorPosition).
 *   2. Pipe them to `monoceros __complete`.
 *   3. Hand the resulting lines back to the shell's completion
 *      mechanism.
 *
 * That keeps the SoT in citty's command definitions + the spec table
 * in `completion/resolve.ts`. Adding a new command or flag means
 * extending the resolver, not editing per-shell scripts.
 */

const SHELLS = ['bash', 'zsh', 'pwsh'] as const;
type Shell = (typeof SHELLS)[number];

export function renderCompletionScript(shell: Shell): string {
  if (shell === 'bash') {
    return [
      '# bash completion for monoceros',
      '# install: source this file from .bashrc, e.g.',
      '#   monoceros completion bash > ~/.bash_completion.d/monoceros',
      '#   echo "source ~/.bash_completion.d/monoceros" >> ~/.bashrc',
      '#',
      '# The work is done by `monoceros __complete --line --point`; this',
      '# shell wrapper only forwards the cursor view.',
      '',
      '_monoceros() {',
      "  local IFS=$'\\n'",
      '  local candidates',
      '  candidates=$(monoceros __complete --line "$COMP_LINE" --point "$COMP_POINT" 2>/dev/null)',
      '  local cur="${COMP_WORDS[COMP_CWORD]}"',
      '  COMPREPLY=( $(compgen -W "$candidates" -- "$cur") )',
      '  # Suppress the trailing space when bash narrowed the candidate',
      '  # set to a single token that ends with `=` — those are value-',
      '  # flags (`--with-features=`, `--with-ports=`, …) where the user types the',
      '  # value immediately after.',
      '  if [[ ${#COMPREPLY[@]} -eq 1 && "${COMPREPLY[0]}" == *= ]]; then',
      '    compopt -o nospace',
      '  fi',
      '}',
      'complete -F _monoceros monoceros',
      '',
    ].join('\n');
  }

  if (shell === 'pwsh') {
    return [
      '# PowerShell completion for monoceros',
      '# install: dot-source this file from your $PROFILE, e.g.',
      '#   monoceros completion pwsh > $HOME/.config/monoceros/completion.ps1',
      "#   Add-Content $PROFILE '. $HOME/.config/monoceros/completion.ps1'",
      '#',
      '# The work is done by `monoceros __complete --line --point`; this',
      '# shell wrapper only forwards the cursor view.',
      '',
      'Register-ArgumentCompleter -Native -CommandName monoceros -ScriptBlock {',
      '    param($wordToComplete, $commandAst, $cursorPosition)',
      '    $line = $commandAst.Extent.Text',
      '    $point = $cursorPosition - $commandAst.Extent.StartOffset',
      '    if ($point -lt 0) { $point = 0 }',
      '    $raw = & monoceros __complete --line $line --point $point 2>$null',
      '    if (-not $raw) { return }',
      '    $raw -split "`n" |',
      '        Where-Object { $_.Length -gt 0 -and $_ -like "$wordToComplete*" } |',
      '        ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, "ParameterValue", $_) }',
      '}',
      '',
    ].join('\n');
  }

  // zsh
  return [
    '#compdef monoceros',
    '# zsh completion for monoceros',
    '# install: drop this file somewhere on your $fpath as `_monoceros`,',
    '# then start a new shell (or run `compinit`). Example:',
    '#   monoceros completion zsh > "${fpath[1]}/_monoceros"',
    '#',
    '# The work is done by `monoceros __complete --line --point`; this',
    '# shell wrapper only forwards the cursor view.',
    '',
    '_monoceros() {',
    '  local line="$BUFFER"',
    '  local point="$CURSOR"',
    '  local -a candidates with_eq without_eq',
    '  candidates=("${(@f)$(monoceros __complete --line "$line" --point "$point" 2>/dev/null)}")',
    '  candidates=("${(@)candidates:#}")',
    '  # Split candidates into "ends with `=`" (value-flags — no suffix',
    '  # space wanted because the user types the value immediately) and',
    '  # "everything else" (positional values, boolean flags — default',
    '  # space behaviour).',
    '  for cand in "${candidates[@]}"; do',
    '    if [[ "$cand" == *= ]]; then',
    '      with_eq+=("$cand")',
    '    else',
    '      without_eq+=("$cand")',
    '    fi',
    '  done',
    '  (( ${#with_eq[@]} ))    && compadd -S \'\' -- "${with_eq[@]}"',
    '  (( ${#without_eq[@]} )) && compadd      -- "${without_eq[@]}"',
    '}',
    '',
    '_monoceros "$@"',
    '',
  ].join('\n');
}

export const completionCommand = defineCommand({
  meta: {
    name: 'completion',
    group: 'tooling',
    // Hidden from `monoceros --help`: the install scripts wire up
    // completion automatically; manual setup is documented in
    // docs/commands/completion.md. Still runnable directly.
    hidden: true,
    description:
      'Print a shell completion script for bash, zsh or PowerShell to stdout. Pipe the output into a file your shell loads at startup. The install scripts (install.sh / install.ps1) call this automatically.',
  },
  args: {
    shell: {
      type: 'positional',
      description: "Target shell. One of: 'bash', 'zsh', 'pwsh'.",
      required: true,
    },
  },
  run({ args }) {
    const shell = args.shell as string;
    if (shell !== 'bash' && shell !== 'zsh' && shell !== 'pwsh') {
      process.stderr.write(
        `Unknown shell: ${JSON.stringify(shell)}. Supported: ${SHELLS.join(', ')}.\n`,
      );
      process.exit(2);
    }
    process.stdout.write(renderCompletionScript(shell));
  },
});

export const COMPLETION_SHELLS = SHELLS;
