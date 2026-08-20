param(
    [string]$BaseUrl = 'http://127.0.0.1:8787',
    [string]$ClientName = 'remote-client'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DataRoot = Join-Path $ProjectRoot 'data'
$bootstrapPath = Join-Path $DataRoot 'bootstrap-token.txt'
if (-not (Test-Path -LiteralPath $bootstrapPath)) { throw "Bootstrap file not found: $bootstrapPath" }
$bootstrap = (Get-Content -Raw -LiteralPath $bootstrapPath).Trim()
$body = @{
    grant_type = 'client_credentials'
    client_id = 'pairing'
    client_secret = $bootstrap
    client_name = $ClientName
}
$response = Invoke-RestMethod -Uri "$($BaseUrl.TrimEnd('/'))/auth/exchange" -Method Post -ContentType 'application/x-www-form-urlencoded' -Body $body
$safeName = ($ClientName -replace '[^A-Za-z0-9._-]', '_')
$tokenPath = Join-Path $DataRoot "client-$safeName.token"
Set-Content -LiteralPath $tokenPath -Value $response.access_token -NoNewline -Encoding ascii
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$grant = '{0}:(F)' -f $identity
& icacls.exe $tokenPath /inheritance:r /grant:r $grant | Out-Null
Write-Output "Access token saved to: $tokenPath"
Write-Output "MCP endpoint: $($BaseUrl.TrimEnd('/'))/mcp"
Write-Output "Token expires in seconds: $($response.expires_in)"
