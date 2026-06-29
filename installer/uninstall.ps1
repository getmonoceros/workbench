#requires -Version 5.1
<#
.SYNOPSIS
  Uninstall Monoceros from Windows (issue #32).

.DESCRIPTION
  Interactive: pick a scope from the menu at startup.

    Keep distro  - `monoceros remove` every container (Docker objects gone, the
                   container dir + yml backed up to container-backups/ first),
                   purge Monoceros images, de-integrate from Docker, remove the
                   Windows wiring. The distro + ~/.monoceros are kept.
    Everything   - same, with --no-backup, plus `wsl --unregister` (deletes the
                   distro and all data in it). Irreversible.

  The scope is chosen interactively. Other tools' Docker images/volumes are
  never touched.

.PARAMETER DistroName  Managed distro name. Default 'monoceros'.
#>
param(
  [string]$DistroName = 'monoceros'
)

$ErrorActionPreference = 'Stop'

# ── Bootstrap: run from a file ─────────────────────────────────────
# Via `irm <url> | iex` there is no script file; the arrow menu and the `exit`
# calls need a real script process (a stray `exit` would close the user's
# interactive shell). Download self to a temp file and relaunch as -File
# (-NoExit so the result stays visible), then return. No elevation needed -
# uninstall only removes things the user owns.
$SelfUrl = 'https://raw.githubusercontent.com/getmonoceros/workbench/main/installer/uninstall.ps1'
if (-not $PSCommandPath) {
  $self = Join-Path $env:TEMP 'monoceros-uninstall.ps1'
  try { Invoke-RestMethod -Uri $SelfUrl -OutFile $self } catch { Write-Host "  Could not download the uninstaller from $SelfUrl" -ForegroundColor Red; return }
  try { Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NoExit','-ExecutionPolicy','Bypass','-File', $self) | Out-Null }
  catch { Write-Host '  Could not relaunch from a file.' -ForegroundColor Yellow }
  return
}
$SettingsPath = Join-Path $env:APPDATA 'Docker\settings-store.json'
$ShimDir      = Join-Path $env:LOCALAPPDATA 'Monoceros\bin'
$LinkPath     = Join-Path $env:USERPROFILE '.monoceros'
$CHECK = [char]0x2714; $CROSS = [char]0x2717
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# Per-step state filled by the "Inspecting" step.
$script:Bin = ''
$script:Names = @()
$script:LiveIntegrated = $false
$script:RemoveErr = ''

# Enable ANSI/VT so the menu redraws in place.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class VTMode {
  [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);
  [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);
}
"@
try { $vh = [VTMode]::GetStdHandle(-11); $vm = 0; [void][VTMode]::GetConsoleMode($vh, [ref]$vm); [void][VTMode]::SetConsoleMode($vh, $vm -bor 0x0004) } catch {}

# --- Spinner (animated from a background runspace; work runs on main thread) -
$Spin = [hashtable]::Synchronized(@{ Stop = $false; Active = $false; Label = '' })
$SpinRunspace = [runspacefactory]::CreateRunspace(); $SpinRunspace.Open()
$SpinRunspace.SessionStateProxy.SetVariable('S', $Spin)
$SpinPwsh = [powershell]::Create(); $SpinPwsh.Runspace = $SpinRunspace
[void]$SpinPwsh.AddScript({
  $frames = [char[]]@(0x280B,0x2819,0x2839,0x2838,0x283C,0x2834,0x2826,0x2827,0x2807,0x280F)
  $i = 0
  while (-not $S.Stop) {
    if ($S.Active) { [Console]::Write("`r   " + $frames[$i % $frames.Length] + '  ' + $S.Label + '     '); $i++ }
    Start-Sleep -Milliseconds 90
  }
})
[void]$SpinPwsh.BeginInvoke()
function Stop-Spinner {
  if ($Spin.Stop) { return }
  $Spin.Active = $false; $Spin.Stop = $true; Start-Sleep -Milliseconds 120
  try { $SpinPwsh.Dispose() } catch {}; try { $SpinRunspace.Dispose() } catch {}
}
function Clear-Line { [Console]::Write("`r" + (' ' * 79) + "`r") }
function Invoke-Step([string]$Label, [scriptblock]$Body) {
  $Spin.Label = $Label; $Spin.Active = $true
  try { $null = & $Body }
  catch { $Spin.Active = $false; Clear-Line; Write-Host '   ' -NoNewline; Write-Host $CROSS -ForegroundColor Red -NoNewline; Write-Host "  $Label" -ForegroundColor Gray; throw }
  $Spin.Active = $false; Clear-Line
  Write-Host '   ' -NoNewline; Write-Host $CHECK -ForegroundColor Green -NoNewline; Write-Host "  $Label" -ForegroundColor Gray
}

# --- Arrow-key menu (in-place redraw via ANSI/VT) ---------------------------
function Read-Menu([string]$Prompt, [string[]]$Options) {
  $e = [char]27; $n = $Options.Count + 1; $sel = 0; $drawn = $false
  try { [Console]::CursorVisible = $false } catch {}
  try {
    while ($true) {
      if ($drawn) { [Console]::Write("${e}[${n}A") }
      $drawn = $true
      [Console]::Write("${e}[2K"); Write-Host ('   ' + $Prompt) -ForegroundColor White
      for ($i = 0; $i -lt $Options.Count; $i++) {
        [Console]::Write("${e}[2K")
        if ($i -eq $sel) { Write-Host ('  > ' + $Options[$i]) -ForegroundColor Cyan } else { Write-Host ('    ' + $Options[$i]) -ForegroundColor Gray }
      }
      $k = [Console]::ReadKey($true)
      if     ($k.Key -eq 'UpArrow')   { $sel = ($sel - 1 + $Options.Count) % $Options.Count }
      elseif ($k.Key -eq 'DownArrow') { $sel = ($sel + 1) % $Options.Count }
      elseif ($k.Key -eq 'Enter')     { return $sel }
      elseif ($k.Key -eq 'Escape')    { return -1 }
    }
  } finally { try { [Console]::CursorVisible = $true } catch {} }
}

# --- Docker Desktop restart (so de-integration takes effect), window-tamed ---
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32U {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
}
"@
$ConsoleHwnd = [Win32U]::GetConsoleWindow()
function Tame-DockerWindow {
  $h = (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle
  if ($h) { [Win32U]::ShowWindow([IntPtr]$h, 6) | Out-Null }
  if ($ConsoleHwnd -ne [IntPtr]::Zero) { [Win32U]::SetForegroundWindow($ConsoleHwnd) | Out-Null }
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
function Restart-DockerDesktop {
  $local:ErrorActionPreference = 'Continue'
  try { docker desktop version *> $null; if ($LASTEXITCODE -eq 0) { docker desktop restart *> $null; return (Wait-DaemonTamingWindow 150) } } catch {}
  $roots = @((Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop'), (Join-Path $env:ProgramFiles 'Docker\Docker')) | Where-Object { Test-Path $_ }
  foreach ($r in $roots) {
    $exe = Get-ChildItem -Path $r -Recurse -Filter 'Docker Desktop.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($exe) {
      Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 4; Start-Process $exe.FullName -WindowStyle Minimized | Out-Null
      return (Wait-DaemonTamingWindow 150)
    }
  }
  return $false
}

function Distro-Exists { return ((wsl.exe -l -q) 2>&1 | Out-String) -split "`r?`n" | Where-Object { $_.Trim() -eq $DistroName } }
function In-Distro([string]$bash) {
  $local:ErrorActionPreference = 'Continue'
  $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($bash))
  return (wsl.exe -d $DistroName -- bash -lc "echo $b64 | base64 -d | bash") 2>&1 | Out-String
}
function Remove-Integration {
  $local:ErrorActionPreference = 'Continue'
  if (-not (Test-Path $SettingsPath)) { return }
  try {
    $json = Get-Content $SettingsPath -Raw | ConvertFrom-Json
    if ($json.PSObject.Properties.Name -contains 'IntegratedWslDistros') {
      $remaining = @(@($json.IntegratedWslDistros) | Where-Object { $_ -ne $DistroName })
      if ($remaining.Count -eq 0) { $json.PSObject.Properties.Remove('IntegratedWslDistros') } else { $json.IntegratedWslDistros = $remaining }
      ($json | ConvertTo-Json -Depth 40) | Set-Content -Path $SettingsPath -Encoding UTF8
    }
  } catch {}
}

# ============================================================================
Write-Host ''
Write-Host '   Uninstall Monoceros' -ForegroundColor White
Write-Host ('   ' + (([string][char]0x2500) * 19)) -ForegroundColor DarkGray
Write-Host ''

$choice = Read-Menu 'What should be removed?  (Up/Down, Enter; Esc cancels)' @(
  'Remove Monoceros, keep the distro and my configs (resume later)',
  'Remove everything, including the distro and all data'
)
if ($choice -lt 0) { Stop-Spinner; Write-Host ''; Write-Host '   Cancelled.' -ForegroundColor Yellow; exit 0 }
$everything = ($choice -eq 1)
if ($everything) {
  Write-Host ''
  Write-Host "   This deletes the '$DistroName' distro and ~/.monoceros (configs + backups). Irreversible." -ForegroundColor Yellow
  $ans = Read-Host "   Type the distro name ('$DistroName') to confirm"
  if ($ans -ne $DistroName) { Stop-Spinner; Write-Host '   Not confirmed - nothing changed.' -ForegroundColor Yellow; exit 0 }
}
Write-Host ''

# From here native tools are judged by exit code; benign stderr must not abort.
$ErrorActionPreference = 'Continue'

try {
  Invoke-Step 'Inspecting the Monoceros install' {
    if (Distro-Exists) {
      $script:Bin = (In-Distro 'b="$HOME/.local/bin/monoceros"; [ -x "$b" ] && printf "%s" "$b"').Trim()
      if ($script:Bin) {
        $raw = In-Distro 'for f in "$HOME"/.monoceros/container-configs/*.yml; do [ -e "$f" ] && basename "$f" .yml; done'
        $script:Names = @($raw -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      }
      $script:LiveIntegrated = ((In-Distro 'docker version >/dev/null 2>&1 && echo Y || echo N') -match 'Y')
    }
  }

  $cLabel =
    if (-not (Distro-Exists)) { "No '$DistroName' distro - nothing in Docker to remove" }
    elseif (-not $script:Bin) { 'No Monoceros CLI in the distro - no containers to remove' }
    elseif ($script:Names.Count -eq 0) { 'No containers to remove' }
    else { "Removing $($script:Names.Count) container(s)$(if ($everything) { '' } else { ' (backed up first)' }) and Monoceros images" }
  Invoke-Step $cLabel {
    foreach ($n in $script:Names) {
      $rmArgs = @('-d', $DistroName, '--', $script:Bin, 'remove', $n, '-y')
      if ($everything) { $rmArgs += '--no-backup' }
      $out = (& wsl.exe @rmArgs 2>&1 | Out-String)
      if ($LASTEXITCODE -ne 0) { $script:RemoveErr = $out; throw "Container '$n' could not be removed." }
    }
    if (Distro-Exists) {
      $imgs = @(docker images --filter 'reference=*monoceros-runtime*' -q 2>$null | Sort-Object -Unique)
      if ($imgs.Count -gt 0) { docker rmi $imgs 2>&1 | Out-Null }
    }
  }

  Invoke-Step 'De-integrating from Docker Desktop' {
    Remove-Integration
    if ($script:LiveIntegrated) {
      if (-not (Restart-DockerDesktop)) { throw 'Docker Desktop did not restart to apply the de-integration.' }
    }
  }

  Invoke-Step 'Removing the Windows wiring' {
    if (Test-Path $ShimDir) { Remove-Item $ShimDir -Recurse -Force -ErrorAction SilentlyContinue }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ -and $_ -ne $ShimDir })
    [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
    if (Test-Path $LinkPath) {
      $item = Get-Item $LinkPath -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { (Get-Item $LinkPath -Force).Delete() }
    }
  }

  if ($everything) {
    Invoke-Step "Removing the '$DistroName' distro and its data" {
      if (Distro-Exists) { wsl.exe --unregister $DistroName 2>&1 | Out-Null }
    }
  }

  Stop-Spinner
  Write-Host ''
  Write-Host '   ' -NoNewline; Write-Host $CHECK -ForegroundColor Green -NoNewline; Write-Host '  Monoceros uninstalled.' -ForegroundColor White
  if (-not $everything) {
    Write-Host ''
    Write-Host "   Kept the '$DistroName' distro and ~/.monoceros - re-run install to resume." -ForegroundColor Gray
  }
  Write-Host ''

} catch {
  Stop-Spinner
  Write-Host ''
  Write-Host "   Uninstall stopped: $($_.Exception.Message)" -ForegroundColor Yellow
  if ($script:RemoveErr) {
    foreach ($l in @($script:RemoveErr -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 4)) { Write-Host "     $l" -ForegroundColor DarkGray }
  }
  Write-Host '   The distro, Windows wiring, and Docker integration were left untouched. Resolve the above and re-run.' -ForegroundColor Gray
  Write-Host ''
  exit 1
} finally {
  Stop-Spinner
  try { [Console]::CursorVisible = $true } catch {}
}
