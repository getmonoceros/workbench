import { defineCommand } from 'citty';
import { buildPwshCompletionModel } from '../completion/resolve.js';

/**
 * `monoceros completion <shell>` — prints a shell-completion script
 * for bash, zsh or PowerShell to stdout. The user pipes the output
 * into a file their shell sources at startup.
 *
 * Two architectures, one source of truth:
 *
 *   - bash / zsh: a THIN wrapper. The actual completion logic lives in
 *     the CLI behind `monoceros __complete --line "<buffer>" --point
 *     <N>`, called on every Tab. Cheap where the CLI is a local binary
 *     (macOS/Linux, and inside the WSL distro via `monoceros shell`).
 *
 *   - PowerShell: a SELF-CONTAINED script. On Windows the CLI lives in a
 *     WSL distro reached through a `monoceros.cmd` shim, so a per-Tab
 *     callback would be a full WSL round-trip — far too slow, and the
 *     reason completion felt broken there. Instead we bake the STATIC
 *     candidate lists (commands, flags, languages, services, features,
 *     …) into the script at generation time and resolve the dynamic ones
 *     (container names, apps, workspace dirs, launch targets) directly
 *     off the host filesystem via the `%USERPROFILE%\.monoceros` symlink.
 *     No CLI call per Tab.
 *
 * Both are derived from citty's command definitions + the spec table in
 * `completion/resolve.ts`. Adding a command or flag means extending the
 * resolver, not editing per-shell scripts — and `buildPwshCompletionModel`
 * carries that straight into the pwsh script.
 */

const SHELLS = ['bash', 'zsh', 'pwsh'] as const;
type Shell = (typeof SHELLS)[number];

function renderBashScript(): string {
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

function renderZshScript(): string {
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

/**
 * The self-contained PowerShell completer. The `__MONOCEROS_MODEL__`
 * placeholder is replaced with the JSON model derived from the command
 * specs. All logic runs in-process in PowerShell — no CLI/WSL call per
 * Tab. The dynamic lookups (container names, apps, workspace dirs,
 * targets) read the host filesystem under `%USERPROFILE%\.monoceros`
 * (the symlink the Windows installer creates into the WSL distro), so
 * they work with the container stopped and cost only a directory scan.
 */
async function renderPwshScript(): Promise<string> {
  const model = await buildPwshCompletionModel();
  const json = JSON.stringify(model);
  return `# PowerShell completion for monoceros (self-contained).
# install: dot-source this file from your $PROFILE, e.g.
#   monoceros completion pwsh > $HOME/.config/monoceros/completion.ps1
#   Add-Content $PROFILE '. $HOME/.config/monoceros/completion.ps1'
#
# Unlike the bash/zsh wrappers this never calls back into the CLI per
# Tab (on Windows that would be a WSL round-trip each keystroke).
# The static candidates are baked in below; the dynamic ones (container
# names, apps, workspace dirs, launch targets) are read straight off the
# host filesystem via the %USERPROFILE%\\.monoceros symlink.

$global:MonocerosModel = @'
${json}
'@ | ConvertFrom-Json

function __Monoceros_Home {
  if ($env:MONOCEROS_HOME) { return $env:MONOCEROS_HOME }
  return (Join-Path $env:USERPROFILE '.monoceros')
}

function __Monoceros_ContainerNames {
  $dir = Join-Path (__Monoceros_Home) 'container-configs'
  if (-not (Test-Path -LiteralPath $dir)) { return @() }
  @(Get-ChildItem -LiteralPath $dir -Filter '*.yml' -File -ErrorAction SilentlyContinue |
      ForEach-Object { $_.BaseName } | Sort-Object)
}

# Recursively collect directory paths under $at, relative to it, capped
# at $maxDepth. Skips dot-dirs, node_modules, and symlinked dirs — the
# host-side mirror of collectDirs() in completion/resolve.ts.
function __Monoceros_CollectDirs($maxDepth, $acc, $at, $rel, $depth) {
  $entries = Get-ChildItem -LiteralPath $at -Directory -Force -ErrorAction SilentlyContinue
  foreach ($e in $entries) {
    if ($e.Name.StartsWith('.')) { continue }
    if ($e.Name -eq 'node_modules') { continue }
    if ($e.LinkType) { continue }
    $childRel = if ($rel) { "$rel/$($e.Name)" } else { $e.Name }
    [void]$acc.Add($childRel)
    if (($depth + 1) -lt $maxDepth) {
      __Monoceros_CollectDirs $maxDepth $acc $e.FullName $childRel ($depth + 1)
    }
  }
}

function __Monoceros_WorkspaceDirs($name) {
  if (-not $name) { return @() }
  $root = Join-Path (Join-Path (__Monoceros_Home) 'container') $name
  if (-not (Test-Path -LiteralPath $root)) { return @() }
  $acc = New-Object System.Collections.Generic.List[string]
  __Monoceros_CollectDirs 1 $acc $root '' 0
  $projects = Join-Path $root 'projects'
  if (Test-Path -LiteralPath $projects) {
    $pacc = New-Object System.Collections.Generic.List[string]
    __Monoceros_CollectDirs 4 $pacc $projects '' 0
    foreach ($p in $pacc) { [void]$acc.Add("projects/$p") }
  }
  @($acc | Sort-Object -Unique)
}

# App-relative paths under projects/ carrying .monoceros/launch.json.
function __Monoceros_WalkApps($at, $rel, $depth, $acc) {
  if ($rel -and (Test-Path -LiteralPath (Join-Path (Join-Path $at '.monoceros') 'launch.json'))) {
    [void]$acc.Add($rel)
  }
  if ($depth -ge 4) { return }
  $entries = Get-ChildItem -LiteralPath $at -Directory -Force -ErrorAction SilentlyContinue
  foreach ($e in $entries) {
    if ($e.Name.StartsWith('.')) { continue }
    $childRel = if ($rel) { "$rel/$($e.Name)" } else { $e.Name }
    __Monoceros_WalkApps $e.FullName $childRel ($depth + 1) $acc
  }
}

function __Monoceros_Apps($name) {
  if (-not $name) { return @() }
  $root = Join-Path (Join-Path (Join-Path (__Monoceros_Home) 'container') $name) 'projects'
  if (-not (Test-Path -LiteralPath $root)) { return @() }
  $acc = New-Object System.Collections.Generic.List[string]
  __Monoceros_WalkApps $root '' 0 $acc
  @($acc | Sort-Object)
}

function __Monoceros_Targets($name, $app) {
  if (-not $name -or -not $app) { return @() }
  $appPath = $app -replace '/', '\\'
  $file = Join-Path (Join-Path (Join-Path (Join-Path (__Monoceros_Home) 'container') $name) 'projects') (Join-Path $appPath (Join-Path '.monoceros' 'launch.json'))
  if (-not (Test-Path -LiteralPath $file)) { return @() }
  try { $json = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json } catch { return @() }
  $list = if ($json.targets) { $json.targets } elseif ($json.configurations) { $json.configurations } else { $null }
  if (-not $list) { return @() }
  @($list | ForEach-Object { $_.name } | Where-Object { $_ })
}

# The positional tokens (skipping flags) after \`monoceros <cmd>\`.
function __Monoceros_Positionals($argTokens) {
  $out = @()
  foreach ($t in $argTokens) {
    if ($t -eq '--') { break }
    if ($t.StartsWith('-')) { continue }
    $out += $t
  }
  ,$out
}

# Resolve a value descriptor ({values:[...]} static, or {kind:...}
# dynamic) to its candidate list.
function __Monoceros_Values($desc, $argTokens) {
  if (-not $desc) { return @() }
  if ($null -ne $desc.values) { return @($desc.values) }
  if ($desc.kind) {
    $pos = __Monoceros_Positionals $argTokens
    $name = if ($pos.Count -gt 0) { $pos[0] } else { $null }
    $app = if ($pos.Count -gt 1) { $pos[1] } else { $null }
    switch ($desc.kind) {
      'containerName' { return (__Monoceros_ContainerNames) }
      'app'           { return (__Monoceros_Apps $name) }
      'appOrService'  { return (__Monoceros_Apps $name) }
      'runInDir'      { return (__Monoceros_WorkspaceDirs $name) }
      'target'        { return (__Monoceros_Targets $name $app) }
    }
  }
  return @()
}

# Comma-aware prefix filter — mirrors resolveValues() so
# \`--with-features=a,b<TAB>\` completes after the last comma.
function __Monoceros_Filter($values, $fragment) {
  if (-not $values) { return @() }
  $commaIdx = $fragment.LastIndexOf(',')
  if ($commaIdx -lt 0) {
    return @($values | Where-Object { $_.StartsWith($fragment) })
  }
  $prefix = $fragment.Substring(0, $commaIdx + 1)
  $tail = $fragment.Substring($commaIdx + 1)
  @($values | Where-Object { $_.StartsWith($tail) } | ForEach-Object { "$prefix$_" })
}

function __Monoceros_LookupFlag($flags, $token) {
  if (-not $flags) { return $null }
  $direct = $flags.PSObject.Properties[$token]
  if ($direct) { return $direct.Value }
  foreach ($p in $flags.PSObject.Properties) {
    if ($p.Value.aliases -contains $token) { return $p.Value }
  }
  return $null
}

# Value flags are offered with a trailing '=' (so no space is wanted
# after Tab); boolean flags and aliases as bare names.
function __Monoceros_FlagNames($flags, $fragment) {
  if (-not $flags) { return @() }
  $names = @()
  foreach ($p in $flags.PSObject.Properties) {
    if ($p.Value.type -eq 'value') { $names += "$($p.Name)=" } else { $names += $p.Name }
    foreach ($a in $p.Value.aliases) { $names += $a }
  }
  @($names | Where-Object { $_.StartsWith($fragment) })
}

function __Monoceros_CountPositionals($argTokens, $flags) {
  $count = 0
  for ($i = 0; $i -lt $argTokens.Count; $i++) {
    $t = $argTokens[$i]
    if ($t -like '--*' -and $t.Contains('=')) { continue }
    if ($t.StartsWith('-')) {
      $flag = __Monoceros_LookupFlag $flags $t
      if ($flag -and $flag.type -eq 'value' -and ($i + 1) -lt $argTokens.Count) { $i++ }
      continue
    }
    $count++
  }
  $count
}

function __Monoceros_Emit($candidates) {
  @($candidates | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  })
}

Register-ArgumentCompleter -Native -CommandName @('monoceros', 'monoceros.cmd', 'monoceros.exe') -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)

  $model = $global:MonocerosModel
  $current = if ($wordToComplete) { $wordToComplete } else { '' }

  # Tokens already complete on the line. When the current word is
  # non-empty it is the last command element — drop it from "prev".
  # NOTE: each list is wrapped in @(...) around the whole if-expression.
  # \`$x = if (...) { @(one-element) }\` enumerates the output and collapses
  # a single-element array back to a scalar, so \`$tokens[0]\` would index
  # into a string ('apply'[0] -> 'a'). The outer @(...) forces an array.
  $elements = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })
  if ($current -ne '' -and $elements.Count -gt 0 -and $elements[-1] -eq $current) {
    $prev = @(if ($elements.Count -gt 1) { $elements[0..($elements.Count - 2)] } else { @() })
  } else {
    $prev = @($elements)
  }
  # Strip the program name (prev[0]).
  $tokens = @(if ($prev.Count -gt 1) { $prev[1..($prev.Count - 1)] } else { @() })

  # No subcommand yet → complete the subcommand list.
  if ($tokens.Count -eq 0) {
    return (__Monoceros_Emit (@($model.commands | Where-Object { $_.StartsWith($current) })))
  }

  $command = $tokens[0]
  $spec = $model.specs.PSObject.Properties[$command]
  if (-not $spec) { return }
  $spec = $spec.Value
  $argTokens = @(if ($tokens.Count -gt 1) { $tokens[1..($tokens.Count - 1)] } else { @() })

  # Everything after \`--\` is the inner command — not ours to complete.
  if ($argTokens -contains '--') { return }

  # Case A: current is \`--flag=fragment\` → that flag's values.
  if ($current -like '--*' -and $current.Contains('=')) {
    $eq = $current.IndexOf('=')
    $flagName = $current.Substring(0, $eq)
    $frag = $current.Substring($eq + 1)
    $flag = if ($spec.flags) { $spec.flags.PSObject.Properties[$flagName] } else { $null }
    if (-not $flag -or $flag.Value.type -ne 'value') { return }
    $vals = __Monoceros_Values $flag.Value.value $argTokens
    return (__Monoceros_Emit (@(__Monoceros_Filter $vals $frag | ForEach-Object { "$flagName=$_" })))
  }

  # Case B: current is an incomplete flag name.
  if ($current.StartsWith('-')) {
    return (__Monoceros_Emit (__Monoceros_FlagNames $spec.flags $current))
  }

  # Case C: previous token was a value flag expecting a value.
  $lastPrev = if ($argTokens.Count -gt 0) { $argTokens[-1] } else { $null }
  if ($lastPrev -and $lastPrev -like '--*' -and -not $lastPrev.Contains('=')) {
    $flag = if ($spec.flags) { $spec.flags.PSObject.Properties[$lastPrev] } else { $null }
    if ($flag -and $flag.Value.type -eq 'value' -and $flag.Value.value) {
      $vals = __Monoceros_Values $flag.Value.value $argTokens
      return (__Monoceros_Emit (__Monoceros_Filter $vals $current))
    }
  }

  # Case D: a positional slot.
  $positionalIdx = __Monoceros_CountPositionals $argTokens $spec.flags
  $positionals = @($spec.positionals)
  $expected = $spec.positionalCount
  if ($positionalIdx -lt $positionals.Count) {
    $vals = __Monoceros_Values $positionals[$positionalIdx] $argTokens
    return (__Monoceros_Emit (__Monoceros_Filter $vals $current))
  }
  if ($positionalIdx -ge $expected) {
    return (__Monoceros_Emit (__Monoceros_FlagNames $spec.flags $current))
  }
}
`;
}

export async function renderCompletionScript(shell: Shell): Promise<string> {
  if (shell === 'bash') return renderBashScript();
  if (shell === 'zsh') return renderZshScript();
  return renderPwshScript();
}

export const completionCommand = defineCommand({
  meta: {
    name: 'completion',
    group: 'tooling',
    // Hidden from `monoceros --help`: the install scripts wire up
    // completion automatically; manual setup is documented at
    // getmonoceros.build/docs/reference/utilities/completion. Still runnable directly.
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
  async run({ args }) {
    const shell = args.shell as string;
    if (shell !== 'bash' && shell !== 'zsh' && shell !== 'pwsh') {
      process.stderr.write(
        `Unknown shell: ${JSON.stringify(shell)}. Supported: ${SHELLS.join(', ')}.\n`,
      );
      process.exit(2);
    }
    process.stdout.write(await renderCompletionScript(shell));
  },
});

export const COMPLETION_SHELLS = SHELLS;
