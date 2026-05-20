# Monoceros installer — Windows (PowerShell).
#
# What this does:
#   1. Verifies Docker is reachable (`docker info`).
#   2. Verifies Node >= 20 is on PATH (with npm).
#   3. Runs `npm install -g @getmonoceros/workbench`.
#
# What this does NOT do:
#   - Install Docker.
#   - Install Node.
#   - Touch any system-wide configuration beyond the npm install.
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

function Say  ($msg) { Write-Host $msg }
function Ok   ($msg) { Write-Host "✓ $msg" -ForegroundColor Green }
function Warn ($msg) { Write-Host "! $msg" -ForegroundColor Yellow }
function Fail ($msg) { Write-Host "✗ $msg" -ForegroundColor Red }

# ── 1. Docker ─────────────────────────────────────────────────────
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
Ok 'Docker daemon reachable.'

# ── 2. Node + npm ─────────────────────────────────────────────────
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
Ok "Node $nodeVersionRaw with npm."

# ── 3. Install ────────────────────────────────────────────────────
Say ''
Say "Installing $Package globally…"
& npm install -g $Package
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

Say ''
Ok 'Monoceros installed.'
Say ''
Say 'Try:  monoceros init hello --with=node,claude'
Say '      then edit %USERPROFILE%\.monoceros\monoceros-config.yml and:'
Say '      monoceros apply hello'
