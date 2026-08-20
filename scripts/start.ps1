param(
    [string]$PublicBaseUrl = 'http://localhost:8787',
    [switch]$DisableInput
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot
$env:MCP_PUBLIC_BASE_URL = $PublicBaseUrl.TrimEnd('/')
if ($DisableInput) { $env:MCP_DISABLE_INPUT = '1' } else { Remove-Item Env:MCP_DISABLE_INPUT -ErrorAction SilentlyContinue }

npm run start
