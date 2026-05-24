import { defineCommand } from 'citty';

/**
 * `monoceros completion <shell>` — prints a shell-completion script
 * for bash or zsh to stdout. The user redirects it into a file their
 * shell loads at startup.
 *
 * Both scripts complete:
 *   - subcommand names at position 1
 *   - container names (read from `<MONOCEROS_HOME>/container-configs/`)
 *     for the second positional of every command that takes a
 *     `<NAME>` argument referring to an existing container — i.e.
 *     everything *except* `init` (which expects a fresh name) and the
 *     verb-only commands like `list-components` / `completion`.
 *
 * MONOCEROS_HOME respects the same precedence as the CLI itself: env
 * var first, then `$HOME/.monoceros`. Container-name completion in
 * the workbench-checkout dev environment looks at the env var if set;
 * otherwise it falls back to `~/.monoceros/`, which matches the
 * global-install case. A contributor who wants dev-container names
 * completed sets `MONOCEROS_HOME=$PWD/.local` in their shell.
 *
 * Install:
 *   bash:  monoceros completion bash > ~/.bash_completion.d/monoceros
 *          (or any path your shell sources; `source` it from .bashrc)
 *   zsh:   monoceros completion zsh > "${fpath[1]}/_monoceros"
 *          (after ensuring compinit is active)
 */

// Keep these arrays in sync with main.ts. Single source of truth
// would be nice but adds startup cost — citty's subCommands aren't
// trivial to enumerate from a static context. Tests guard the
// list in completion.test.ts.
const ALL_COMMANDS = [
  'init',
  'list-components',
  'shell',
  'run',
  'logs',
  'start',
  'stop',
  'status',
  'apply',
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
  'completion',
] as const;

// Commands whose first positional is an existing container name.
// Everything else either takes no positional (`list-components`,
// `completion`) or expects a fresh name (`init`, `restore`).
const COMMANDS_WITH_CONTAINER_ARG = [
  'shell',
  'run',
  'logs',
  'start',
  'stop',
  'status',
  'apply',
  'remove',
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
] as const;

const SHELLS = ['bash', 'zsh', 'pwsh'] as const;
type Shell = (typeof SHELLS)[number];

export function renderCompletionScript(shell: Shell): string {
  const commands = ALL_COMMANDS.join(' ');
  const containerCommandsRegex = COMMANDS_WITH_CONTAINER_ARG.join('|');

  if (shell === 'bash') {
    return [
      '# bash completion for monoceros',
      '# install: source this file from .bashrc, e.g.',
      '#   monoceros completion bash > ~/.bash_completion.d/monoceros',
      '#   echo "source ~/.bash_completion.d/monoceros" >> ~/.bashrc',
      '',
      '_monoceros() {',
      '  local cur prev cmd home configs_dir names',
      '  cur="${COMP_WORDS[COMP_CWORD]}"',
      '',
      '  if [[ $COMP_CWORD -eq 1 ]]; then',
      `    COMPREPLY=( $(compgen -W "${commands}" -- "$cur") )`,
      '    return',
      '  fi',
      '',
      '  cmd="${COMP_WORDS[1]}"',
      '  if [[ $COMP_CWORD -eq 2 ]]; then',
      '    case "$cmd" in',
      `      ${containerCommandsRegex})`,
      '        home="${MONOCEROS_HOME:-$HOME/.monoceros}"',
      '        configs_dir="$home/container-configs"',
      '        if [[ -d "$configs_dir" ]]; then',
      `          names=$(cd "$configs_dir" && ls *.yml 2>/dev/null | sed 's/\\.yml$//')`,
      '          COMPREPLY=( $(compgen -W "$names" -- "$cur") )',
      '        fi',
      '        ;;',
      '      completion)',
      `        COMPREPLY=( $(compgen -W "${SHELLS.join(' ')}" -- "$cur") )`,
      '        ;;',
      '    esac',
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
      '',
      'Register-ArgumentCompleter -Native -CommandName monoceros -ScriptBlock {',
      '    param($wordToComplete, $commandAst, $cursorPosition)',
      '',
      '    $commands = @(',
      ...ALL_COMMANDS.map((c) => `        '${c}'`),
      '    )',
      `    $shells = @('${SHELLS.join("', '")}')`,
      '    $containerCommands = @(',
      ...COMMANDS_WITH_CONTAINER_ARG.map((c) => `        '${c}'`),
      '    )',
      '',
      '    $tokens = $commandAst.CommandElements',
      '    $position = $tokens.Count',
      '    if ($wordToComplete) { $position-- }',
      '',
      '    if ($position -eq 1) {',
      '        $commands | Where-Object { $_ -like "$wordToComplete*" } |',
      '            ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, "ParameterValue", $_) }',
      '        return',
      '    }',
      '',
      '    if ($position -eq 2) {',
      '        $cmd = $tokens[1].Value',
      '        if ($containerCommands -contains $cmd) {',
      '            $home = if ($env:MONOCEROS_HOME) { $env:MONOCEROS_HOME } else { Join-Path $env:USERPROFILE ".monoceros" }',
      '            $configsDir = Join-Path $home "container-configs"',
      '            if (Test-Path $configsDir) {',
      '                Get-ChildItem -Path $configsDir -Filter "*.yml" |',
      '                    ForEach-Object { $_.BaseName } |',
      '                    Where-Object { $_ -like "$wordToComplete*" } |',
      '                    ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, "ParameterValue", $_) }',
      '            }',
      '        } elseif ($cmd -eq "completion") {',
      '            $shells | Where-Object { $_ -like "$wordToComplete*" } |',
      '                ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, "ParameterValue", $_) }',
      '        }',
      '    }',
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
    '',
    '_monoceros() {',
    '  local -a commands shells',
    '  commands=(',
    ...ALL_COMMANDS.map((c) => `    '${c}'`),
    '  )',
    `  shells=(${SHELLS.map((s) => `'${s}'`).join(' ')})`,
    '',
    '  if (( CURRENT == 2 )); then',
    "    _describe 'monoceros command' commands",
    '    return',
    '  fi',
    '',
    '  local cmd=${words[2]}',
    '  if (( CURRENT == 3 )); then',
    '    case $cmd in',
    `      ${containerCommandsRegex})`,
    '        local home="${MONOCEROS_HOME:-$HOME/.monoceros}"',
    '        local configs_dir="$home/container-configs"',
    '        if [[ -d $configs_dir ]]; then',
    '          local -a names',
    '          names=(${configs_dir}/*.yml(N:t:r))',
    "          _describe 'container' names",
    '        fi',
    '        ;;',
    '      completion)',
    "        _describe 'shell' shells",
    '        ;;',
    '    esac',
    '  fi',
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

// Exposed for tests so the static command list stays in sync with
// what main.ts wires up.
export const COMPLETION_COMMANDS_FOR_TEST = ALL_COMMANDS;
export const COMPLETION_CONTAINER_COMMANDS_FOR_TEST =
  COMMANDS_WITH_CONTAINER_ARG;
