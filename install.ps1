# Monoceros installer — Windows (PowerShell).
#
# What this does:
#   1. Verifies Docker is reachable (`docker info`).
#   2. Verifies Node >= 20 is on PATH (with npm).
#   3. Runs `npm install -g @getmonoceros/workbench`.
#   4. Drops a PowerShell completion script and wires it into $PROFILE.
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

function Say     ($msg) { Write-Host $msg }
function Ok      ($msg) {
  Write-Host '  ' -NoNewline
  Write-Host '✓' -ForegroundColor Green -NoNewline
  Write-Host " $msg"
}
function Warn    ($msg) {
  Write-Host '  ' -NoNewline
  Write-Host '!' -ForegroundColor Yellow -NoNewline
  Write-Host " $msg"
}
function Fail    ($msg) {
  Write-Host '✗' -ForegroundColor Red -NoNewline
  Write-Host " $msg"
}
function Section ($msg) {
  Write-Host ''
  Write-Host "$BOLD$UNDERLINE▸ $msg$RESET"
}
# Wrap text for inline coloured spans inside larger lines built up
# with Write-Host -NoNewline. Returned strings include ANSI codes.
function Cmd ($txt) { return "$ESC[36m$txt$RESET" }
function Dim ($txt) { return "$ESC[90m$txt$RESET" }

# ── Header ────────────────────────────────────────────────────────
Say ''
Write-Host "${BOLD}Monoceros installer${RESET}"
Write-Host "  $(Dim 'local, reproducible dev containers with AI coding tooling')"

# ── 1. Prerequisites ──────────────────────────────────────────────
Section 'Prerequisites'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Fail 'Docker is not installed.'
  @'

Monoceros needs Docker. Install it before continuing:

  Docker Desktop for Windows  ->  https://docs.docker.com/desktop/install/windows-install/
  (or via WinGet:  winget install Docker.DockerDesktop)

Docker Desktop requires admin rights to install. If you're on a
managed corporate machine without admin, talk to your IT — there's
no userspace Docker on Windows.

Then re-run this installer.
'@ | Write-Host
  exit 1
}

try {
  $null = docker info 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'docker info non-zero' }
} catch {
  Fail "Docker is installed but the daemon isn't reachable."
  @'

Start Docker Desktop, wait until the whale icon stops animating,
then re-run this installer.
'@ | Write-Host
  exit 1
}
Ok 'Docker daemon reachable'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node is not installed.'
  @"

Monoceros needs Node $NodeMinMajor or newer. Pick whichever install
style fits your setup — Monoceros doesn't care, we just need ``node``
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
  exit 1
}

$nodeVersionRaw = (node --version) -replace '^v',''
$nodeMajor = [int]($nodeVersionRaw -split '\.')[0]
if ($nodeMajor -lt $NodeMinMajor) {
  Fail "Node $nodeVersionRaw is too old. Monoceros needs >= $NodeMinMajor."
  @"

Upgrade Node, then re-run this installer. See the install hints
above for the common upgrade paths.
"@ | Write-Host
  exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Fail 'npm is not on PATH (unusual — npm normally ships with Node).'
  @'

Reinstall Node from one of the sources above; npm should come along
automatically.
'@ | Write-Host
  exit 1
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
  exit 1
}

$cliPath = (Get-Command monoceros -ErrorAction SilentlyContinue).Source
$cliVersion = $null
if ($cliPath) {
  try { $cliVersion = (& monoceros --version 2>$null | Select-Object -First 1).Trim() } catch {}
}
if ($cliPath -and $cliVersion) {
  Ok "monoceros $(Dim $cliVersion) $(Dim '→') $(Dim $cliPath)"
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
  Ok "pwsh $(Dim '→') $(Dim $completionFile) $(Dim '($PROFILE already wired)')"
} else {
  Add-Content -Path $PROFILE -Value ''
  Add-Content -Path $PROFILE -Value $marker
  Add-Content -Path $PROFILE -Value $sourceLine
  Ok "pwsh $(Dim '→') $(Dim $completionFile)"
  Ok "$(Dim 'appended dot-source line to $PROFILE')"
}

# ── 4. Next steps ─────────────────────────────────────────────────
Section 'Next steps'

Say ''
Say "  Activate in this shell $(Dim '(reload your profile so the completion is registered):')"
Say ''
Say "    $(Cmd '. $PROFILE')"
Say ''
Say '  Try it out:'
Say ''
Say "    $(Cmd 'monoceros init hello --with=node,claude')"
Say "    $(Dim '# edit %USERPROFILE%\.monoceros\monoceros-config.yml (api keys etc)')"
Say "    $(Cmd 'monoceros apply hello')"
Say "    $(Cmd 'monoceros shell hello')"
Say ''
