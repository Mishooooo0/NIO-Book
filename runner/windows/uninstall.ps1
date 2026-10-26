<#
.SYNOPSIS
  Removes NIO Runner for the current user. Keeps nio-runner.json and data\ unless -RemoveData is given.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\NIO-Runner'),
  [switch]$RemoveData
)
$ErrorActionPreference = 'Stop'
$TaskName = 'NIO Runner'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'."
}
Get-Process -Name 'nio-runner-background', 'nio-runner' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) } |
  Stop-Process -Force -ErrorAction SilentlyContinue

$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'NIO Runner'
if (Test-Path $menu) { Remove-Item -Recurse -Force $menu }

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -and ($userPath -split ';' | Where-Object { $_ -eq $InstallDir })) {
  [Environment]::SetEnvironmentVariable('Path', (($userPath -split ';' | Where-Object { $_ -and $_ -ne $InstallDir }) -join ';'), 'User')
}

if (Test-Path $InstallDir) {
  if ($RemoveData) {
    Remove-Item -Recurse -Force $InstallDir
    Write-Host "Removed $InstallDir"
  } else {
    Get-ChildItem $InstallDir -File | Where-Object { $_.Name -notin 'nio-runner.json' } | Remove-Item -Force
    Write-Host "Removed the program. Kept your config and data in $InstallDir (use -RemoveData to delete them)."
  }
}
