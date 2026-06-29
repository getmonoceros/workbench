#requires -Version 5.1
<#
.SYNOPSIS
  Monoceros Windows installer (issue #32): set up a managed WSL distro behind a
  thin Windows shim, so the user never has to touch WSL by hand.

.DESCRIPTION
  Steps (each shown with a spinner, then a check mark):
    0. Reset    - tear down any previous Monoceros install (re-runnable).
    1. Docker   - require a reachable Docker on Windows; else point at Docker Desktop.
    2. Distro   - import the managed 'monoceros' WSL distro, set the default user.
    3. Integrate- enable Docker Desktop WSL integration and apply it.
    4. CLI      - install the CLI (as the user, via install.sh) + seed the config.
    5. Link     - point %USERPROFILE%\.monoceros at the distro's ~/.monoceros.
    6. Editors  - allow wsl.localhost in VS Code / Codium so they don't prompt.
    7. Shim     - drop a `monoceros` shim at the front of PATH.

  TEMPORARY STAND-INS (to be replaced as #32 progresses):
    - The rootfs is built on the fly from a base image (docker export); the real
      installer will import a prebuilt Monoceros rootfs that ships the CLI baked in.

  Must run elevated (the symlink and PATH change need admin). Re-runnable.

.PARAMETER DistroName  Managed distro name. Default 'monoceros'.
.PARAMETER BaseImage   Stand-in rootfs image. Default 'ubuntu:24.04'.
.PARAMETER SkipCli     Skip the CLI install (fast mechanics-only test runs).

  This installer is non-destructive: it creates the distro if missing and
  reuses it (preserving ~/.monoceros) if present. To remove anything, use
  uninstall.ps1.
#>
param(
  [string]$DistroName = 'monoceros',
  [string]$BaseImage  = 'ubuntu:24.04',
  [switch]$SkipCli
)

$ErrorActionPreference = 'Stop'

# ── Bootstrap: run from a file, elevated ───────────────────────────
# Via `irm <url> | iex` there is no script file, and the symlink + PATH change
# need admin. Download self to a temp file if needed, relaunch elevated as
# -File, then stop this (piped / non-elevated) run. `return`, never `exit`, so
# an interactive iex session is not closed.
$SelfUrl = 'https://raw.githubusercontent.com/getmonoceros/workbench/main/installer/install.ps1'
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not $PSCommandPath -or -not (Test-Admin)) {
  $self = $PSCommandPath
  if (-not $self) {
    $self = Join-Path $env:TEMP 'monoceros-install.ps1'
    try { Invoke-RestMethod -Uri $SelfUrl -OutFile $self } catch { Write-Host "  Could not download the installer from $SelfUrl" -ForegroundColor Red; return }
  }
  try { Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', $self) | Out-Null }
  catch { Write-Host '  Elevation was declined. Re-run from an elevated PowerShell.' -ForegroundColor Yellow }
  return
}

# ----------------------------------------------------------------------------
# Fixed locations the installer owns.
# ----------------------------------------------------------------------------
$SettingsPath  = Join-Path $env:APPDATA 'Docker\settings-store.json'
$ShimDir       = Join-Path $env:LOCALAPPDATA 'Monoceros\bin'
$LinkPath      = Join-Path $env:USERPROFILE '.monoceros'
$WorkDir       = Join-Path $env:TEMP "monoceros-install-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"
$DistroUser    = 'ubuntu'  # default non-root user in the stand-in image (uid 1000)
$script:MonoBin = "/home/$DistroUser/.local/bin/monoceros"
$script:Warnings = @()
$script:Version = ''

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# ----------------------------------------------------------------------------
# Animated spinner: the frames are drawn from a background runspace while the
# step's work runs (and blocks) on the main thread.
# ----------------------------------------------------------------------------
$CHECK = [char]0x2714; $CROSS = [char]0x2717  # ✔ ✗
$Spin = [hashtable]::Synchronized(@{ Stop = $false; Active = $false; Label = '' })
$SpinRunspace = [runspacefactory]::CreateRunspace()
$SpinRunspace.Open()
$SpinRunspace.SessionStateProxy.SetVariable('S', $Spin)
$SpinPwsh = [powershell]::Create()
$SpinPwsh.Runspace = $SpinRunspace
[void]$SpinPwsh.AddScript({
  $frames = [char[]]@(0x280B,0x2819,0x2839,0x2838,0x283C,0x2834,0x2826,0x2827,0x2807,0x280F)
  $i = 0
  while (-not $S.Stop) {
    if ($S.Active) {
      [Console]::Write("`r   " + $frames[$i % $frames.Length] + '  ' + $S.Label + '     ')
      $i++
    }
    Start-Sleep -Milliseconds 90
  }
})
[void]$SpinPwsh.BeginInvoke()

function Stop-Spinner {
  if ($Spin.Stop) { return }
  $Spin.Active = $false; $Spin.Stop = $true
  Start-Sleep -Milliseconds 120
  try { $SpinPwsh.Dispose() } catch {}
  try { $SpinRunspace.Dispose() } catch {}
}

function Clear-Line { [Console]::Write("`r" + (' ' * 79) + "`r") }

# Run one step under the spinner. The Body must stay SILENT (no Write-Host) and
# may return a short detail string, shown dimmed under the check mark.
function Invoke-Step([string]$Label, [scriptblock]$Body) {
  $Spin.Label = $Label; $Spin.Active = $true
  try {
    $null = & $Body
  } catch {
    $Spin.Active = $false; Clear-Line
    Write-Host '   ' -NoNewline; Write-Host $CROSS -ForegroundColor Red -NoNewline; Write-Host "  $Label" -ForegroundColor Gray
    throw
  }
  $Spin.Active = $false; Clear-Line
  Write-Host '   ' -NoNewline; Write-Host $CHECK -ForegroundColor Green -NoNewline; Write-Host "  $Label" -ForegroundColor Gray
}

function Hint([string[]]$lines) { Write-Host ''; foreach ($l in $lines) { Write-Host "    $l" -ForegroundColor White }; Write-Host '' }

# ----------------------------------------------------------------------------
# Win32: keep the Docker Desktop window from stealing focus on restart.
# ----------------------------------------------------------------------------
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
}
"@
$ConsoleHwnd = [Win32]::GetConsoleWindow()

function Tame-DockerWindow {
  $h = (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle
  if ($h) { [Win32]::ShowWindow([IntPtr]$h, 6) | Out-Null }
  if ($ConsoleHwnd -ne [IntPtr]::Zero) { [Win32]::SetForegroundWindow($ConsoleHwnd) | Out-Null }
}

# ----------------------------------------------------------------------------
# Primitives (unchanged logic).
# ----------------------------------------------------------------------------
function Distro-Exists { return ((wsl.exe -l -q) 2>&1 | Out-String) -split "`r?`n" | Where-Object { $_.Trim() -eq $DistroName } }

# Run bash inside the distro with zero quoting hazard (base64 across the boundary).
function In-Distro([string]$bash, [string]$User = 'root') {
  $local:ErrorActionPreference = 'Continue'
  $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($bash))
  return (wsl.exe -d $DistroName -u $User -- bash -lc "echo $b64 | base64 -d | bash") 2>&1 | Out-String
}

function Wait-DockerDaemon([int]$timeoutSec = 60) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
    try { docker info *> $null; if ($LASTEXITCODE -eq 0) { return $true } } catch {}
    Start-Sleep -Seconds 2
  }
  return $false
}

function Wait-DaemonTamingWindow([int]$timeoutSec = 150) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew(); $up = $false
  while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
    Tame-DockerWindow
    try { docker info *> $null; if ($LASTEXITCODE -eq 0) { $up = $true; break } } catch {}
    Start-Sleep -Milliseconds 800
  }
  for ($i = 0; $i -lt 8; $i++) { Tame-DockerWindow; Start-Sleep -Milliseconds 500 }
  return $up
}

function Find-DockerDesktopExe {
  $roots = @((Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop'), (Join-Path $env:ProgramFiles 'Docker\Docker')) |
           Where-Object { Test-Path $_ }
  foreach ($r in $roots) {
    $hit = Get-ChildItem -Path $r -Recurse -Filter 'Docker Desktop.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

function Restart-DockerDesktop {
  $local:ErrorActionPreference = 'Continue'
  $hasCli = $false
  try { docker desktop version *> $null; if ($LASTEXITCODE -eq 0) { $hasCli = $true } } catch {}
  if ($hasCli) {
    docker desktop restart *> $null
    if (Wait-DaemonTamingWindow 150) { return 'cli' }
  }
  $exe = Find-DockerDesktopExe
  if (-not $exe) { return 'none' }
  Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'com.docker.*' } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 4
  Start-Process $exe -WindowStyle Minimized | Out-Null
  if (Wait-DaemonTamingWindow 150) { return 'process' }
  return 'none'
}

function Add-Integration {
  if (-not (Test-Path $SettingsPath)) { return $false }
  $json = Get-Content $SettingsPath -Raw | ConvertFrom-Json
  if ($json.PSObject.Properties.Name -contains 'IntegratedWslDistros') {
    if (@($json.IntegratedWslDistros) -contains $DistroName) { return $true }
    $json.IntegratedWslDistros = @(@($json.IntegratedWslDistros) + $DistroName | Select-Object -Unique)
  } else {
    $json | Add-Member -NotePropertyName 'IntegratedWslDistros' -NotePropertyValue ([string[]]@($DistroName)) -Force
  }
  ($json | ConvertTo-Json -Depth 40) | Set-Content -Path $SettingsPath -Encoding UTF8
  return $false
}

# Add wsl.localhost to VS Code / Codium `security.allowedUNCHosts`. Silent;
# returns a short summary of what it touched.
function Allow-UncHostInEditors {
  $targets = @(
    @{ name = 'VS Code';  path = (Join-Path $env:APPDATA 'Code\User\settings.json') },
    @{ name = 'VSCodium'; path = (Join-Path $env:APPDATA 'VSCodium\User\settings.json') }
  )
  $done = @()
  foreach ($t in $targets) {
    if (-not (Test-Path (Split-Path $t.path -Parent))) { continue }
    if (-not (Test-Path $t.path)) {
      Set-Content -Path $t.path -Encoding UTF8 -Value '{ "security.allowedUNCHosts": ["wsl.localhost"] }'
      $done += $t.name; continue
    }
    try { $cfg = Get-Content $t.path -Raw | ConvertFrom-Json }
    catch { $done += "$($t.name) (manual: tick 'allow host' once)"; continue }
    $list = @()
    if ($cfg.PSObject.Properties.Name -contains 'security.allowedUNCHosts') { $list = @($cfg.'security.allowedUNCHosts') }
    if ($list -contains 'wsl.localhost') { $done += $t.name; continue }
    $list = [string[]]@($list + 'wsl.localhost' | Select-Object -Unique)
    if ($cfg.PSObject.Properties.Name -contains 'security.allowedUNCHosts') { $cfg.'security.allowedUNCHosts' = $list }
    else { $cfg | Add-Member -NotePropertyName 'security.allowedUNCHosts' -NotePropertyValue $list -Force }
    ($cfg | ConvertTo-Json -Depth 40) | Set-Content -Path $t.path -Encoding UTF8
    $done += $t.name
  }
  if ($done) { return ($done -join ', ') } else { return 'no VS Code / Codium found' }
}

# ============================================================================
# Main
# ============================================================================
try {
  try { [Console]::CursorVisible = $false } catch {}
  Write-Host ''
  Write-Host '   Monoceros for Windows' -ForegroundColor White
  Write-Host ('   ' + (([string][char]0x2500) * 24)) -ForegroundColor DarkGray
  Write-Host ''

  Invoke-Step '1. Checking for Docker on Windows' {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue) -or -not (Wait-DockerDaemon 20)) { throw 'NO_DOCKER' }
  }

  $step2 = if (Distro-Exists) { "2. Reusing the existing '$DistroName' distro (configs preserved)" } else { "2. Creating the '$DistroName' WSL distro" }
  Invoke-Step $step2 {
    if (Distro-Exists) { return }  # reuse - never recreate, so ~/.monoceros survives
    $null = New-Item -ItemType Directory -Force -Path $WorkDir
    docker pull $BaseImage 2>&1 | Out-Null
    $cid = (docker create $BaseImage 2>$null).Trim()
    docker export $cid -o (Join-Path $WorkDir 'rootfs.tar') 2>$null
    docker rm $cid 2>&1 | Out-Null
    wsl.exe --import $DistroName (Join-Path $WorkDir 'distro') (Join-Path $WorkDir 'rootfs.tar') 2>&1 | Out-Null
    In-Distro "id -u $DistroUser >/dev/null 2>&1 || useradd -m -s /bin/bash $DistroUser; printf '[user]\ndefault=$DistroUser\n' > /etc/wsl.conf" | Out-Null
    wsl.exe --terminate $DistroName 2>&1 | Out-Null
    "default user: $DistroUser"
  }

  Invoke-Step '3. Wiring Docker into the distro' {
    $already = Add-Integration
    $how = 'already integrated'
    if (-not $already) {
      $method = Restart-DockerDesktop
      if ($method -eq 'none') { throw 'Docker Desktop did not come back after the restart.' }
      $how = "applied via $method restart"
    }
    $check = In-Distro 'docker version >/dev/null 2>&1 && echo OK || echo FAIL' $DistroUser
    if ($check -notmatch 'OK') { throw "Docker not reachable inside the distro as '$DistroUser'." }
    $how
  }

  if ($SkipCli) {
    Invoke-Step '4. CLI install (skipped: -SkipCli)' { }
  } else {
    Invoke-Step '4. Installing the Monoceros CLI and seeding the config' {
      $sys = In-Distro @'
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git openssh-client >/dev/null
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
apt-get install -y -qq nodejs >/dev/null
node -v >/dev/null 2>&1 && echo NODE-OK || echo NODE-NOT-READY
'@
      if ($sys -match 'NODE-NOT-READY') { throw 'Node could not be installed in the distro.' }
      $r = In-Distro @'
curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/install.sh | bash
BIN="$HOME/.local/bin/monoceros"
TPL="$HOME/.local/lib/node_modules/@getmonoceros/workbench/templates/monoceros-config.sample.yml"
mkdir -p "$HOME/.monoceros"
if [ -f "$TPL" ] && [ ! -f "$HOME/.monoceros/monoceros-config.yml" ]; then cp "$TPL" "$HOME/.monoceros/monoceros-config.yml"; fi
[ -x "$BIN" ] && echo "MONO_BIN=$BIN" || echo "CLI-NOT-READY"
[ -x "$BIN" ] && echo "MONO_VER=$("$BIN" --version 2>/dev/null | head -n1 | tr -d '\r')"
[ -f "$HOME/.monoceros/monoceros-config.yml" ] && echo "CONFIG-OK" || echo "CONFIG-MISSING"
'@ $DistroUser
      if ($r -match 'CLI-NOT-READY') { throw "CLI did not install as the user. Output:`n$r" }
      $bm = [regex]::Match($r, 'MONO_BIN=(\S+)'); if ($bm.Success) { $script:MonoBin = $bm.Groups[1].Value }
      $vm = [regex]::Match($r, 'MONO_VER=(.+)'); if ($vm.Success) { $script:Version = $vm.Groups[1].Value.Trim() }
      if ($r -match 'CONFIG-MISSING') { throw 'monoceros-config.yml was not seeded into the home.' }
      'CLI + monoceros-config.yml installed'
    }
  }

  Invoke-Step '5. Linking %USERPROFILE%\.monoceros into the distro' {
    if ((Test-Path $LinkPath) -and ((Get-Item $LinkPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }  # already linked
    if (Test-Path $LinkPath) { throw "$LinkPath exists but is a real folder, not our link - remove it first." }
    $distroHome = (In-Distro 'mkdir -p "$HOME/.monoceros"; printf "%s" "$HOME"' $DistroUser).Trim()
    $rel = ($distroHome.TrimStart('/') -replace '/', '\')
    $target = "\\wsl.localhost\$DistroName\$rel\.monoceros"
    New-Item -ItemType SymbolicLink -Path $LinkPath -Target $target | Out-Null
    $target
  }

  Invoke-Step '6. Allowing wsl.localhost in editors' { Allow-UncHostInEditors }

  Invoke-Step '7. Installing the monoceros shim' {
    $null = New-Item -ItemType Directory -Force -Path $ShimDir
    $shim = Join-Path $ShimDir 'monoceros.cmd'
    Set-Content -Path $shim -Encoding ASCII -Value "@echo off`r`nwsl.exe -d $DistroName -- $script:MonoBin %*`r`n"
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ -and $_ -ne $ShimDir })
    [Environment]::SetEnvironmentVariable('Path', ((@($ShimDir) + $parts) -join ';'), 'User')
    $hostCli = Get-Command monoceros -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -and $_.Source -notlike "$ShimDir*" } | Select-Object -First 1
    if ($hostCli) { $script:Warnings += "A separate Windows install of monoceros ($($hostCli.Source)) may shadow this one. Remove it with: npm uninstall -g @getmonoceros/workbench" }
  }

  Stop-Spinner
  try { [Console]::CursorVisible = $true } catch {}

  if ($script:Warnings.Count -gt 0) {
    Write-Host ''
    foreach ($w in $script:Warnings) { Write-Host "   !  $w" -ForegroundColor Yellow }
  }

  Write-Host ''
  Write-Host ('   ' + (([string][char]0x2500) * 52)) -ForegroundColor DarkGray
  Write-Host ''
  $readyLine = if ($script:Version) { "  Monoceros $($script:Version) is ready." } else { '  Monoceros is ready.' }
  Write-Host '   ' -NoNewline; Write-Host $CHECK -ForegroundColor Green -NoNewline; Write-Host $readyLine -ForegroundColor White
  Write-Host ''
  Write-Host '   Your container configs live here:' -ForegroundColor Gray
  Write-Host "       $LinkPath" -ForegroundColor Cyan
  Write-Host ''
  Write-Host '   Get started in a new unprivileged terminal:' -ForegroundColor Gray
  Write-Host '       monoceros init  myapp --with-languages=node --with-features=claude' -ForegroundColor Cyan -NoNewline; Write-Host '   # describe a dev container' -ForegroundColor DarkGray
  Write-Host '       monoceros apply myapp' -ForegroundColor Cyan -NoNewline; Write-Host '    # build and start it' -ForegroundColor DarkGray
  Write-Host '       monoceros shell myapp' -ForegroundColor Cyan -NoNewline; Write-Host '    # work inside it' -ForegroundColor DarkGray
  Write-Host ''
  Write-Host '   Help        ' -ForegroundColor Gray -NoNewline; Write-Host 'monoceros --help' -ForegroundColor Cyan
  Write-Host '   Docs        ' -ForegroundColor Gray -NoNewline; Write-Host 'https://getmonoceros.build/docs' -ForegroundColor Cyan
  Write-Host "   What's new  " -ForegroundColor Gray -NoNewline; Write-Host 'https://getmonoceros.build/changelog' -ForegroundColor Cyan
  Write-Host ''

} catch {
  Stop-Spinner
  try { [Console]::CursorVisible = $true } catch {}
  Write-Host ''
  if ($_.Exception.Message -eq 'NO_DOCKER') {
    Write-Host '  Monoceros needs Docker on Windows, but none was found.' -ForegroundColor Yellow
    Hint @(
      'Install Docker Desktop, then run this installer again:',
      '',
      '    winget install Docker.DockerDesktop',
      '',
      'Or download it from https://www.docker.com/products/docker-desktop/',
      '',
      'Prefer your own Docker inside WSL? Use the Linux install path at',
      'getmonoceros.build/docs.'
    )
  } else {
    Write-Host "  Installation failed: $($_.Exception.Message)" -ForegroundColor Red
  }
  exit 1
} finally {
  Stop-Spinner
  try { [Console]::CursorVisible = $true } catch {}
  if (Test-Path $WorkDir) { Remove-Item $WorkDir -Recurse -Force -ErrorAction SilentlyContinue }
}
