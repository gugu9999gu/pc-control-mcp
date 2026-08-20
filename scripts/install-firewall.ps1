param([int]$Port = 8787)

$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated PowerShell window. It only opens the selected TCP port to Windows LocalSubnet on the Private profile.'
}
$ruleName = 'Codex MCP Remote Control (LocalSubnet)'
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private -RemoteAddress LocalSubnet | Out-Null
Write-Output "Created firewall rule '$ruleName' for TCP/$Port from LocalSubnet on the Private profile."
