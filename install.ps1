# Monoceros installer — Windows (PowerShell).
#
# What this does:
#   1. Checks the PowerShell execution policy isn't blocking .ps1 shims.
#   2. Verifies Docker is reachable (`docker info`).
#   3. Verifies Node >= 20 is on PATH (with npm).
#   4. Runs `npm install -g @getmonoceros/workbench`.
#   5. Drops a PowerShell completion script and wires it into $PROFILE.
#
# What this does NOT do:
#   - Install Docker.
#   - Install Node.
#   - Touch your system beyond an `npm install -g` and one $PROFILE
#     append for completion bootstrap (guarded; repeat runs don't
#     duplicate).
#
# If either prerequisite is missing the script prints an explanation
# and exits non-zero. Install the missing piece yourself, then
# re-run.
#
# Usage:
#   iwr -useb https://raw.githubusercontent.com/getmonoceros/workbench/main/install.ps1 | iex
# or download install.ps1 and run it locally:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Pin to a specific version: skip this script and run
#   npm install -g @getmonoceros/workbench@<version>
# directly instead.
#
# Why the body is wrapped in a function: when loaded via `iwr | iex`
# the script runs in the caller's interactive session, not a
# subprocess. A top-level `exit N` would terminate the user's
# PowerShell host — closing their window before they can read the
# error. Wrapping in a function turns `return N` into a scoped exit
# that leaves the host alive. We propagate the code to the process
# only when invoked via `-File`.

function Invoke-MonocerosInstaller {
  $ErrorActionPreference = 'Stop'

  $Package = '@getmonoceros/workbench'
  $NodeMinMajor = 20

  # ── Pretty printing ───────────────────────────────────────────────
  # Palette matches install.sh and the CLI's help renderer:
  #   cyan      = identifiers you type
  #   darkgray  = supplementary metadata
  #   green/red/yellow = success/error/warn
  # Section markers use ANSI bold+underline directly — Write-Host
  # colours don't compose with bold/underline, but Windows Terminal
  # and PowerShell 7's host both handle ANSI escapes natively.
  $ESC = [char]27
  $BOLD = "$ESC[1m"
  $UNDERLINE = "$ESC[4m"
  $RESET = "$ESC[0m"

  # Glyphs are deliberately ASCII (+, X, >, --, ->). PS 5.1's default
  # conhost.exe codepage is OEM/ANSI, not UTF-8 — multi-byte glyphs
  # (✓ ✗ ▸ — →) render as `?` there. ANSI color and bold escapes
  # *do* work in modern conhost, so semantics carry via colour; the
  # glyph is only a visual marker. install.sh keeps Unicode glyphs
  # because macOS/Linux terminals render them reliably.
  function Say     ($msg) { Write-Host $msg }
  function Ok      ($msg) {
    Write-Host '  ' -NoNewline
    Write-Host '+' -ForegroundColor Green -NoNewline
    Write-Host " $msg"
  }
  function Warn    ($msg) {
    Write-Host '  ' -NoNewline
    Write-Host '!' -ForegroundColor Yellow -NoNewline
    Write-Host " $msg"
  }
  function Fail    ($msg) {
    Write-Host 'X' -ForegroundColor Red -NoNewline
    Write-Host " $msg"
  }
  function Section ($msg) {
    Write-Host ''
    Write-Host "$BOLD$UNDERLINE> $msg$RESET"
  }
  # Wrap text for inline coloured spans inside larger lines built up
  # with Write-Host -NoNewline. Returned strings include ANSI codes.
  function Cmd ($txt) { return "$ESC[36m$txt$RESET" }
  function Dim ($txt) { return "$ESC[90m$txt$RESET" }

  # True iff at least one WSL 2 distro is registered. Lets the Docker
  # hints below show only the relevant step (full `wsl --install` vs.
  # nothing). WSL_UTF8 makes `wsl -l -v` emit UTF-8 instead of UTF-16LE
  # (which arrives full of NUL bytes); we strip NULs anyway as a guard
  # for older WSL builds that ignore the env var.
  function Get-Wsl2Ready {
    try {
      $env:WSL_UTF8 = '1'
      $out = (& wsl -l -v 2>$null) -join "`n"
    } catch { return $false }
    if (-not $out) { return $false }
    $out = $out -replace "`0", ''
    foreach ($line in ($out -split "`r?`n")) {
      $t = ($line.Trim() -replace '^\*\s*', '')
      if (-not $t) { continue }
      if ($t -match '\bNAME\b' -and $t -match '\bVERSION\b') { continue }
      $tokens = $t -split '\s+'
      if ($tokens[-1] -eq '2') { return $true }
    }
    return $false
  }

  # ── Header ────────────────────────────────────────────────────────
  Say ''
  Write-Host "${BOLD}Monoceros installer${RESET}"
  Write-Host "  $(Dim 'local, reproducible dev containers with AI coding tooling')"

  # ── 0. Execution policy ───────────────────────────────────────────
  # npm installs `npm`, `monoceros`, etc. as PowerShell shims (*.ps1).
  # PowerShell prefers the .ps1 over the .cmd, so under the Windows-
  # default `Restricted` (or `AllSigned`) policy every such call — this
  # installer's `npm install` AND, later, every `monoceros` command —
  # dies with a cryptic PSSecurityException. We can't run those scripts
  # ourselves, so detect the blocking policy up front and tell the
  # builder exactly how to unblock it. CurrentUser scope needs no admin
  # and persists, so future shells can run `monoceros` too.
  $policy = Get-ExecutionPolicy
  if ($policy -eq 'Restricted' -or $policy -eq 'AllSigned') {
    Section 'Prerequisites'
    Fail "PowerShell execution policy is '$policy' -- npm and monoceros can't run."
    @'

PowerShell won't run the .ps1 wrappers npm creates for `npm` and
`monoceros`. Unblock them for your user (no admin required), then
re-run this installer:

  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

RemoteSigned lets local scripts run and still requires a signature for
scripts downloaded from the internet. The setting is persistent, so
new PowerShell tabs can run `monoceros` too.
'@ | Write-Host
    return 1
  }

  # ── 1. Prerequisites ──────────────────────────────────────────────
  Section 'Prerequisites'

  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail 'Docker is not installed.'
    if (Get-Wsl2Ready) {
      # WSL 2 is already set up — only Docker is missing. Skip the
      # `wsl --install` step entirely.
      @'

Monoceros needs Docker. WSL 2 is already set up on this machine, so
only Docker Desktop is missing. Install it:

  winget install Docker.DockerDesktop
  # no admin? winget install Docker.DockerDesktop --override "install --user --accept-license"

Start Docker Desktop (you can skip the sign-in), then re-run this
installer. Background + the no-admin path: docs/install-windows.md.
'@ | Write-Host
    } else {
      # No WSL 2 distro yet — set up WSL first, then Docker.
      @'

Monoceros needs Docker. On Windows, Docker Desktop runs on the WSL 2
backend, and no WSL 2 distro is set up yet -- so do both. From a
PowerShell opened as Administrator (right-click -> "Run as administrator"):

  1. wsl --install                     # WSL + Ubuntu, sets WSL 2 as default
                                        #   when the Linux shell opens, type
                                        #   `exit` to leave it
  2. winget install Docker.DockerDesktop
  3. Start Docker Desktop (you can skip the sign-in)

Then open a NEW, regular (non-admin) PowerShell and re-run this
installer. If Windows asks for a reboot along the way, do it and
continue afterwards.

No admin rights on a managed machine? A per-user Docker Desktop
install (no admin) is possible when WSL is already enabled. That
path, the "Virtualization support not detected" fix, and the full
walkthrough: see docs/install-windows.md in the workbench repo.
'@ | Write-Host
    }
    return 1
  }

  try {
    $null = docker info 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'docker info non-zero' }
  } catch {
    Fail "Docker is installed but the daemon isn't reachable."
    if (Get-Wsl2Ready) {
      @'

Start Docker Desktop, wait until the whale icon stops animating,
then re-run this installer.
'@ | Write-Host
    } else {
      # No WSL 2 distro — this is almost certainly why Docker Desktop's
      # backend won't come up. Give the exact fix.
      @'

Docker Desktop's daemon isn't reachable, and no WSL 2 distro is
registered -- Docker runs on the WSL 2 backend, so without a distro it
can't start (often shown as the misleading "Virtualization support not
detected", even with virtualization enabled in BIOS).

Fix it in an elevated PowerShell:

  wsl --set-default-version 2
  wsl --update
  wsl --install -d Ubuntu

Then reboot, start Docker Desktop, and re-run this installer. Full
walkthrough: docs/install-windows.md.
'@ | Write-Host
    }
    return 1
  }
  Ok 'Docker daemon reachable'

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail 'Node is not installed.'
    @"

Monoceros needs Node $NodeMinMajor or newer. Pick whichever install
style fits your setup -- Monoceros doesn't care, we just need ``node``
on PATH:

  System-wide (admin):
    winget install OpenJS.NodeJS
    choco install nodejs
    https://nodejs.org/en/download  (.msi installer)

  Per-user (no admin):
    winget install OpenJS.NodeJS --scope user
    nvm-windows:  https://github.com/coreybutler/nvm-windows
    fnm:          https://github.com/Schniz/fnm
    Direct ZIP:   https://nodejs.org/en/download (extract + add to PATH)

Then re-run this installer.
"@ | Write-Host
    return 1
  }

  $nodeVersionRaw = (node --version) -replace '^v',''
  $nodeMajor = [int]($nodeVersionRaw -split '\.')[0]
  if ($nodeMajor -lt $NodeMinMajor) {
    Fail "Node $nodeVersionRaw is too old. Monoceros needs >= $NodeMinMajor."
    @"

Upgrade Node, then re-run this installer. See the install hints
above for the common upgrade paths.
"@ | Write-Host
    return 1
  }

  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail 'npm is not on PATH (unusual -- npm normally ships with Node).'
    @'

Reinstall Node from one of the sources above; npm should come along
automatically.
'@ | Write-Host
    return 1
  }
  Ok "Node $(Dim $nodeVersionRaw) with npm"

  # ── 2. CLI install ────────────────────────────────────────────────
  Section 'Installing CLI'

  # --silent suppresses npm's "changed N packages" / "looking for funding"
  # narration. Errors still surface on stderr.
  & npm install -g --silent $Package
  if ($LASTEXITCODE -ne 0) {
    Fail 'npm install failed.'
    @"

If this is a permissions issue, npm is configured to write to a
location requiring elevated privileges. Two ways out:

  - run PowerShell as Administrator and re-try
  - configure npm's prefix to a user-owned directory and add it to
    PATH (search 'npm config set prefix' for guidance).

Once installed, verify with:  monoceros --version
"@ | Write-Host
    return 1
  }

  $cliPath = (Get-Command monoceros -ErrorAction SilentlyContinue).Source
  $cliVersion = $null
  if ($cliPath) {
    try { $cliVersion = (& monoceros --version 2>$null | Select-Object -First 1).Trim() } catch {}
  }
  if ($cliPath -and $cliVersion) {
    Ok "monoceros $(Dim $cliVersion) $(Dim '->') $(Dim $cliPath)"
  } else {
    Ok 'Monoceros installed'
  }

  # ── 3. PowerShell completion ──────────────────────────────────────
  Section 'Shell completion'

  $completionDir  = Join-Path $env:USERPROFILE '.config\monoceros'
  $completionFile = Join-Path $completionDir 'completion.ps1'
  $marker         = '# monoceros completion (managed by install.ps1)'
  $sourceLine     = ". `"$completionFile`""

  if (-not (Test-Path $completionDir)) {
    New-Item -ItemType Directory -Path $completionDir -Force | Out-Null
  }
  & monoceros completion pwsh | Out-File -Encoding UTF8 -FilePath $completionFile

  if (-not (Test-Path $PROFILE)) {
    New-Item -ItemType File -Path $PROFILE -Force | Out-Null
  }
  $profileContent = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
  if ($profileContent -and $profileContent.Contains($marker)) {
    Ok "pwsh $(Dim '->') $(Dim $completionFile) $(Dim '($PROFILE already wired)')"
  } else {
    Add-Content -Path $PROFILE -Value ''
    Add-Content -Path $PROFILE -Value $marker
    Add-Content -Path $PROFILE -Value $sourceLine
    Ok "pwsh $(Dim '->') $(Dim $completionFile)"
    Ok "$(Dim 'appended dot-source line to $PROFILE')"
  }

  # ── 4. User home ──────────────────────────────────────────────────
  # Ensure %USERPROFILE%\.monoceros\ exists with an all-commented
  # monoceros-config.yml template. Same logic as install.sh — the
  # template ships as-is, user uncomments what they need. No "copy
  # the sample and rename" ritual.
  Section 'User home'

  $monocerosHome = Join-Path $env:USERPROFILE '.monoceros'
  $npmRoot       = (& npm root -g).Trim()
  $configSrc     = Join-Path $npmRoot '@getmonoceros\workbench\templates\monoceros-config.sample.yml'
  $configDst     = Join-Path $monocerosHome 'monoceros-config.yml'

  if (-not (Test-Path $monocerosHome)) {
    New-Item -ItemType Directory -Path $monocerosHome -Force | Out-Null
  }

  if (Test-Path $configSrc) {
    if (Test-Path $configDst) {
      Ok "config $(Dim '->') $(Dim $configDst) $(Dim '(already present, left alone)')"
    } else {
      Copy-Item -Path $configSrc -Destination $configDst
      Ok "config $(Dim '->') $(Dim $configDst)"
      Say "  $(Dim 'All entries are commented out -- uncomment what you need')"
      Say "  $(Dim '(git identity, feature API keys, etc).')"
    }
  } else {
    Warn "config template not found at $configSrc -- skipping"
  }

  # ── 5. Next steps ─────────────────────────────────────────────────
  Section 'Next steps'

  Say ''
  Say "  Activate in this shell $(Dim '(reload your profile so the completion is registered):')"
  Say ''
  Say "    $(Cmd '. $PROFILE')"
  Say ''
  Say '  Try it out:'
  Say ''
  Say "    $(Cmd 'monoceros init hello --with=node,claude')"
  Say "    $(Dim '# optional: edit %USERPROFILE%\.monoceros\monoceros-config.yml for global defaults')"
  Say "    $(Cmd 'monoceros apply hello')"
  Say "    $(Cmd 'monoceros shell hello')"
  Say ''

  return 0
}

$__monocerosExit = Invoke-MonocerosInstaller

# Propagate the exit code only when invoked as a file. Under `iwr | iex`
# the script runs in the caller's session and an `exit` here would close
# their window; returning quietly leaves them at their prompt with the
# error message still on screen.
if ($MyInvocation.MyCommand.Path) {
  exit $__monocerosExit
}
