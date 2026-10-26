<#
.SYNOPSIS
  Installs NIO Runner for the current Windows user and starts it at every logon.

.DESCRIPTION
  Copies the app to %LOCALAPPDATA%\Programs\NIO-Runner (no admin rights needed), creates
  nio-runner.json from the example if you do not have one yet, registers a per-user scheduled
  task "NIO Runner" that starts the windowless runner at logon and restarts it if it crashes,
  and adds Start menu shortcuts for the status page, the config file and the logs.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -AddToPath -NoStart
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\NIO-Runner'),
  [switch]$AddToPath,
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$TaskName = 'NIO Runner'
$Source = $PSScriptRoot

Write-Host "Installing NIO Runner to $InstallDir"
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
Get-Process -Name 'nio-runner-background', 'nio-runner' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) } |
  Stop-Process -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
foreach ($file in 'nio-runner.exe', 'nio-runner-background.exe', 'nio-runner.example.json', 'README.txt', 'uninstall.ps1') {
  Copy-Item -Force (Join-Path $Source $file) (Join-Path $InstallDir $file)
}
# Files from a downloaded zip carry "Mark of the Web"; clear it so Windows runs them without prompting.
Get-ChildItem $InstallDir -File | Unblock-File

$config = Join-Path $InstallDir 'nio-runner.json'
$newConfig = -not (Test-Path $config)
if ($newConfig) {
  Copy-Item (Join-Path $InstallDir 'nio-runner.example.json') $config
  Write-Host "Created $config from the example. Edit it before the runner can connect." -ForegroundColor Yellow
}

# Per-user logon task: no console window, restarts on failure, never times out.
$exe = Join-Path $InstallDir 'nio-runner-background.exe'
$action = New-ScheduledTaskAction -Execute $exe -Argument "run --quiet --config `"$config`"" -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Wakes Claude Code and Codex when they are mentioned in NIO-Book.' -Force | Out-Null
Write-Host "Registered scheduled task '$TaskName' (starts at logon)."

# Start menu shortcuts.
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'NIO Runner'
New-Item -ItemType Directory -Force -Path $menu | Out-Null
$port = 7788
try { $port = (Get-Content $config -Raw | ConvertFrom-Json).statusPort } catch { }
if (-not $port) { $port = 7788 }
Set-Content -Path (Join-Path $menu 'NIO Runner Status.url') -Value "[InternetShortcut]`r`nURL=http://127.0.0.1:$port/`r`n"
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path $menu 'NIO Runner Config.lnk')); $lnk.TargetPath = 'notepad.exe'; $lnk.Arguments = "`"$config`""; $lnk.Save()
$logs = Join-Path $InstallDir 'data\logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$lnk = $shell.CreateShortcut((Join-Path $menu 'NIO Runner Logs.lnk')); $lnk.TargetPath = $logs; $lnk.Save()

if ($AddToPath) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not ($userPath -split ';' | Where-Object { $_ -eq $InstallDir })) {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ";$InstallDir"), 'User')
    Write-Host "Added $InstallDir to your PATH (open a new terminal to use nio-runner)."
  }
}

if ($newConfig) {
  Start-Process notepad.exe -ArgumentList "`"$config`""
  Write-Host ''
  Write-Host 'Next steps:' -ForegroundColor Cyan
  Write-Host "  1. Fill in server, API keys and project folders in $config"
  Write-Host "  2. Check it:   & `"$InstallDir\nio-runner.exe`" check"
  Write-Host "  3. Start it:   Start-ScheduledTask -TaskName '$TaskName'   (or sign out and back in)"
} elseif (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Started. Status page: http://127.0.0.1:$port/" -ForegroundColor Green
}
