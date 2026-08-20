param(
    [string]$PublicBaseUrl = 'http://localhost:8787',
    [switch]$DisableInput
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DataRoot = Join-Path $ProjectRoot 'data'
New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
$env:MCP_PUBLIC_BASE_URL = $PublicBaseUrl.TrimEnd('/')
if ($DisableInput) { $env:MCP_DISABLE_INPUT = '1' } else { Remove-Item Env:MCP_DISABLE_INPUT -ErrorAction SilentlyContinue }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$stdout = Join-Path $DataRoot 'server.stdout.log'
$stderr = Join-Path $DataRoot 'server.stderr.log'
$process = Start-Process -FilePath $node -ArgumentList @('src/server.mjs') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Set-Content -LiteralPath (Join-Path $DataRoot 'server.pid') -Value $process.Id -Encoding ascii
Write-Output "Started PID $($process.Id). Logs: $stdout and $stderr"
