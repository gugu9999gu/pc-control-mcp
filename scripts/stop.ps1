$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path (Join-Path $ProjectRoot 'data') 'server.pid'
if (-not (Test-Path -LiteralPath $PidFile)) { Write-Output 'No server.pid file found.'; exit 0 }
$serverPid = [int](Get-Content -Raw -LiteralPath $PidFile)
$process = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
if ($process) {
    Stop-Process -Id $serverPid -ErrorAction Stop
    Write-Output "Stopped PID $serverPid."
} else {
    Write-Output "PID $serverPid is not running."
}
Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
