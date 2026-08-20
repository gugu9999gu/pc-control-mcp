$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DataRoot = Join-Path $ProjectRoot 'data'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$grant = '{0}:(F)' -f $identity
Get-ChildItem -LiteralPath $DataRoot -File -ErrorAction SilentlyContinue | ForEach-Object {
    & icacls.exe $_.FullName /inheritance:r /grant:r $grant | Out-Null
    Write-Output "Protected $($_.Name) for $identity"
}
