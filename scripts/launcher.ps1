param(
    [switch]$Start,
    [switch]$Stop,
    [switch]$Copy,
    [switch]$CopyToken,
    [switch]$Verify,
    [switch]$Open,
    [switch]$Status,
    [switch]$DisableInput,
    [ValidateSet('safe', 'agent', 'full')]
    [string]$SetProfile,
    [switch]$ShowPolicy,
    [string]$AddWorkspace,
    [ValidateSet('codex', 'claude')]
    [string]$LoginAgent,
    [switch]$Activity,
    [switch]$WatchActivity,
    [switch]$Connections,
    [string]$RevokeClient,
    [switch]$Lan,
    [switch]$ConfigureNamedTunnel,
    [switch]$StartNamedTunnel
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DataRoot = Join-Path $ProjectRoot 'data'
New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
Set-Location -LiteralPath $ProjectRoot

$ServerPidFile = Join-Path $DataRoot 'launcher-server.pid'
$TunnelPidFile = Join-Path $DataRoot 'launcher-tunnel.pid'
$PublicUrlFile = Join-Path $DataRoot 'current-public-url.txt'
$ServerStdout = Join-Path $DataRoot 'launcher-server.stdout.log'
$ServerStderr = Join-Path $DataRoot 'launcher-server.stderr.log'
$TunnelStdout = Join-Path $DataRoot 'launcher-tunnel.stdout.log'
$TunnelStderr = Join-Path $DataRoot 'launcher-tunnel.stderr.log'
$LocalBaseUrl = 'http://127.0.0.1:8787'
$ControlProfileScript = Join-Path $ProjectRoot 'scripts\control-profile.ps1'
$ControlPolicyFile = Join-Path $DataRoot 'control-policy.json'
$AuditFile = Join-Path $DataRoot 'audit.ndjson'
$LocalAdminTokenFile = Join-Path $DataRoot 'local-admin-token.txt'
$NamedTunnelConfigFile = Join-Path $DataRoot 'named-tunnel-config.json'
$NamedTunnelTokenFile = Join-Path $DataRoot 'named-tunnel-token.dpapi.txt'

function Resolve-Cloudflared {
    $command = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $wingetRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (Test-Path -LiteralPath $wingetRoot) {
        $candidate = Get-ChildItem -LiteralPath $wingetRoot -Filter 'cloudflared.exe' -File -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 1 -ExpandProperty FullName
        if ($candidate) { return $candidate }
    }
    throw 'cloudflared.exe was not found. Install cloudflared and run the launcher again.'
}

function Get-RecordedPid {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $value = (Get-Content -Raw -LiteralPath $Path).Trim()
    $parsed = 0
    if ([int]::TryParse($value, [ref]$parsed)) { return $parsed }
    return $null
}

function Get-ProcessCommandLine {
    param([int]$ProcessId)
    $record = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    return [string]$record.CommandLine
}

function Test-ExpectedManagedProcess {
    param(
        [int]$ProcessId,
        [string]$ExpectedProcessName
    )
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { return $false }
    $commandLine = Get-ProcessCommandLine $ProcessId
    switch ($ExpectedProcessName) {
        'node' {
            if ($process.ProcessName -notin @('node', 'electron', 'Remote MCP Control')) { return $false }
            return $commandLine -match '(?i)src[\\/]server\.mjs'
        }
        'cloudflared' { return $process.ProcessName -eq 'cloudflared' -and $commandLine -match '(?i)127\.0\.0\.1:8787' }
        default { return -not $ExpectedProcessName -or $process.ProcessName -eq $ExpectedProcessName }
    }
}

function Get-ValidRecordedPid {
    param(
        [string]$PidFile,
        [string]$ExpectedProcessName
    )
    $recordedPid = Get-RecordedPid $PidFile
    if ($recordedPid -and (Test-ExpectedManagedProcess $recordedPid $ExpectedProcessName)) { return $recordedPid }
    return $null
}

function Stop-RecordedProcess {
    param(
        [string]$PidFile,
        [string]$Label,
        [string]$ExpectedProcessName
    )
    $recordedPid = Get-RecordedPid $PidFile
    if ($recordedPid) {
        if (Test-ExpectedManagedProcess $recordedPid $ExpectedProcessName) {
            Stop-Process -Id $recordedPid -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $recordedPid -Timeout 5 -ErrorAction SilentlyContinue
            Write-Host "$Label stopped: PID $recordedPid" -ForegroundColor DarkGray
        }
    }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

function Get-ProjectServerPids {
    $pidMatches = @()
    $recordedPid = Get-RecordedPid $ServerPidFile
    $listenerPids = @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @('node.exe', 'electron.exe', 'Remote MCP Control.exe') })) {
        $commandLine = [string]$process.CommandLine
        $isProjectCommand = $commandLine.IndexOf($ProjectRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        $isRecorded = $recordedPid -and [int]$process.ProcessId -eq $recordedPid
        $ownsControlPort = $listenerPids -contains [int]$process.ProcessId
        if ($commandLine -match '(?i)src[\\/]server\.mjs' -and ($isProjectCommand -or $isRecorded -or $ownsControlPort)) {
            $pidMatches += [int]$process.ProcessId
        }
    }
    return @($pidMatches | Select-Object -Unique)
}

function Get-ProjectTunnelPids {
    $pidMatches = @()
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue)) {
        $commandLine = [string]$process.CommandLine
        if ($commandLine -match '(?i)127\.0\.0\.1:8787') {
            $pidMatches += [int]$process.ProcessId
        }
    }
    return @($pidMatches | Select-Object -Unique)
}

function Stop-ProcessByIdSafe {
    param(
        [int]$ProcessId,
        [string]$Label,
        [string]$ExpectedProcessName
    )
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (Test-ExpectedManagedProcess $ProcessId $ExpectedProcessName) {
        Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "$Label stopped: PID $ProcessId" -ForegroundColor DarkGray
    }
}

function Stop-DiscoveredProjectProcesses {
    foreach ($processId in @(Get-ProjectServerPids)) {
        Stop-ProcessByIdSafe $processId 'discovered MCP server' 'node'
    }
    foreach ($processId in @(Get-ProjectTunnelPids)) {
        Stop-ProcessByIdSafe $processId 'discovered MCP tunnel' 'cloudflared'
    }
}

function Assert-PortAvailable {
    # Recover from a stale/missing PID file left by an interrupted launcher.
    foreach ($processId in @(Get-ProjectServerPids)) {
        Stop-ProcessByIdSafe $processId 'orphan MCP server' 'node'
    }
    Start-Sleep -Milliseconds 250
    $listeners = @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) {
        $owners = ($listeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
        throw "Port 8787 is already in use (PID $owners). Stop the existing MCP server first."
    }
}

function Wait-ForHttp {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 30
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
            if ($curl) {
                & $curl.Source '--noproxy' '*' '--silent' '--show-error' '--fail' '--connect-timeout' '5' '--max-time' '10' '--output' 'NUL' $Url 2>$null
                if ($LASTEXITCODE -eq 0) { return $true }
            } else {
                $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
                if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return $true }
            }
        } catch { }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Wait-ForOAuthIssuer {
    param(
        [string]$MetadataUrl,
        [string]$ExpectedBaseUrl,
        [int]$TimeoutSeconds = 30
    )
    $expected = $ExpectedBaseUrl.TrimEnd('/')
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $metadata = Invoke-RestMethod -Uri $MetadataUrl -Method Get -TimeoutSec 5 -ErrorAction Stop
            if ([string]$metadata.issuer -eq $expected -and [string]$metadata.authorization_endpoint -eq "$expected/oauth/authorize") {
                return $true
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Ensure-Dependencies {
    $sdkPackage = Join-Path $ProjectRoot 'node_modules\@modelcontextprotocol\sdk\package.json'
    $zodPackage = Join-Path $ProjectRoot 'node_modules\zod\package.json'
    if ((Test-Path -LiteralPath $sdkPackage) -and (Test-Path -LiteralPath $zodPackage)) { return }

    $packageLock = Join-Path $ProjectRoot 'package-lock.json'
    if (-not (Test-Path -LiteralPath $packageLock)) {
        throw "package-lock.json is missing from $ProjectRoot. Extract the complete source ZIP, then run the launcher from the folder containing package.json."
    }
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    Write-Host 'Installing MCP server dependencies (first run only)...' -ForegroundColor Yellow
    & $npm ci --omit=dev --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
}

function Get-LogExcerpt {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $content = (Get-Content -Raw -LiteralPath $Path -ErrorAction SilentlyContinue).Trim()
    if ($content.Length -gt 1000) { return $content.Substring([Math]::Max(0, $content.Length - 1000)) }
    return $content
}

function Get-LocalAdminToken {
    if (-not (Test-Path -LiteralPath $LocalAdminTokenFile)) {
        throw "The local launcher administration token does not exist yet: $LocalAdminTokenFile. Start the MCP server once first."
    }
    $token = (Get-Content -Raw -LiteralPath $LocalAdminTokenFile).Trim()
    if ($token.Length -lt 30) { throw 'The local launcher administration token is invalid.' }
    return $token
}

function Invoke-LocalAdminApi {
    param(
        [ValidateSet('GET', 'POST')]
        [string]$Method,
        [string]$Path,
        [object]$Body
    )
    if (-not (Wait-ForHttp "$LocalBaseUrl/healthz" 3)) { throw 'The local MCP server is not running.' }
    $headers = @{ 'X-Mcp-Local-Admin' = Get-LocalAdminToken }
    $parameters = @{ Uri = "$LocalBaseUrl$Path"; Method = $Method; Headers = $headers; UseBasicParsing = $true; TimeoutSec = 10 }
    if ($Method -eq 'POST') {
        $parameters.ContentType = 'application/json'
        $parameters.Body = ($Body | ConvertTo-Json -Compress)
    }
    return Invoke-RestMethod @parameters
}

function Format-ActivityEntry {
    param([object]$Entry)
    $client = if ($Entry.clientName) { $Entry.clientName } elseif ($Entry.client_name) { $Entry.client_name } else { '' }
    $tool = if ($Entry.tool) { " tool=$($Entry.tool)" } else { '' }
    $result = if ($null -ne $Entry.success) { " success=$($Entry.success)" } else { '' }
    $details = if ($Entry.details) { " details=$($Entry.details | ConvertTo-Json -Compress -Depth 4)" } else { '' }
    $reason = if ($Entry.reason) { " reason=$($Entry.reason)" } elseif ($Entry.error) { " error=$($Entry.error)" } else { '' }
    "[$($Entry.timestamp)] $($Entry.event)$tool$result$reason$details client=$client"
}

function Show-ActivityLog {
    param([switch]$Follow)
    if (-not (Test-Path -LiteralPath $AuditFile)) {
        Write-Host 'No MCP activity has been recorded yet.' -ForegroundColor Yellow
        return
    }
    if ($Follow) {
        Write-Host 'Watching MCP activity. Press Ctrl+C to return to the launcher.' -ForegroundColor Cyan
        Get-Content -LiteralPath $AuditFile -Tail 0 -Wait | ForEach-Object {
            try { Format-ActivityEntry ($_ | ConvertFrom-Json) } catch { $_ }
        }
        return
    }
    Get-Content -LiteralPath $AuditFile -Tail 80 | ForEach-Object {
        try { Format-ActivityEntry ($_ | ConvertFrom-Json) } catch { $_ }
    }
}

function Show-ConnectorConnections {
    $status = Invoke-LocalAdminApi -Method GET -Path '/admin/connectors'
    Write-Host "OAuth access token lifetime: $($status.oauth_access_token_ttl_seconds) seconds" -ForegroundColor DarkGray
    Write-Host "OAuth refresh token lifetime: $($status.oauth_refresh_token_ttl_seconds) seconds" -ForegroundColor DarkGray
    $visibleConnectors = @($status.connectors | Where-Object { $_.client_name -ne 'local OAuth verification' })
    if ($visibleConnectors.Count -eq 0) {
        Write-Host 'No non-test OAuth connectors have registered yet.' -ForegroundColor Yellow
    } else {
        foreach ($connector in $visibleConnectors) {
            $state = if ($connector.connected) { 'connected' } else { 'not connected / revoked' }
            Write-Host "[$state] $($connector.client_name)" -ForegroundColor $(if ($connector.connected) { 'Green' } else { 'DarkGray' })
            Write-Host "  Client: $($connector.client_id)" -ForegroundColor DarkGray
            Write-Host "  Permissions: $($connector.permissions -join ', ')" -ForegroundColor DarkGray
            Write-Host "  Access tokens: $($connector.active_access_tokens), refresh tokens: $($connector.active_refresh_tokens), last use: $($connector.last_used_at)" -ForegroundColor DarkGray
        }
    }
    if (@($status.active_mcp_sessions).Count -gt 0) {
        Write-Host 'Active MCP sessions:' -ForegroundColor Cyan
        foreach ($session in @($status.active_mcp_sessions)) {
            Write-Host "  $($session.client_name) connected=$($session.connected_at) last_activity=$($session.last_activity_at)" -ForegroundColor DarkGray
        }
    }
}

function Revoke-ConnectorConnection {
    param([string]$ClientId)
    if (-not $ClientId) { throw 'A connector client ID is required.' }
    $result = Invoke-LocalAdminApi -Method POST -Path '/admin/connectors' -Body @{ client_id = $ClientId }
    Write-Host "Connector authorization revoked: $($result.client_id). Reconnect it to choose a new permission set." -ForegroundColor Green
}

function Start-Server {
    param([string]$PublicBaseUrl)
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $oldPublic = [Environment]::GetEnvironmentVariable('MCP_PUBLIC_BASE_URL', 'Process')
    $oldDisable = [Environment]::GetEnvironmentVariable('MCP_DISABLE_INPUT', 'Process')
    $env:MCP_PUBLIC_BASE_URL = $PublicBaseUrl.TrimEnd('/')
    if ($DisableInput) { $env:MCP_DISABLE_INPUT = '1' } else { Remove-Item Env:MCP_DISABLE_INPUT -ErrorAction SilentlyContinue }
    try {
        $process = Start-Process -FilePath $node -ArgumentList @('src/server.mjs') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $ServerStdout -RedirectStandardError $ServerStderr -PassThru
    } finally {
        if ($null -eq $oldPublic) { Remove-Item Env:MCP_PUBLIC_BASE_URL -ErrorAction SilentlyContinue } else { $env:MCP_PUBLIC_BASE_URL = $oldPublic }
        if ($null -eq $oldDisable) { Remove-Item Env:MCP_DISABLE_INPUT -ErrorAction SilentlyContinue } else { $env:MCP_DISABLE_INPUT = $oldDisable }
    }
    Set-Content -LiteralPath $ServerPidFile -Value $process.Id -Encoding ascii
    return $process
}

function Get-QuickTunnelUrl {
    $text = ''
    foreach ($path in @($TunnelStdout, $TunnelStderr)) {
        if (Test-Path -LiteralPath $path) {
            $text += "`n" + (Get-Content -Raw -LiteralPath $path -ErrorAction SilentlyContinue)
        }
    }
    $urlMatches = [regex]::Matches($text, 'https://[a-z0-9-]+\.trycloudflare\.com', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($urlMatches.Count -gt 0) { return $urlMatches[$urlMatches.Count - 1].Value.TrimEnd('/') }
    return $null
}

function Start-PublicMcp {
    Write-Host 'Starting the public MCP server...' -ForegroundColor Cyan
    Ensure-Dependencies
    Stop-RecordedProcess $ServerPidFile 'previous launcher server' 'node'
    Stop-RecordedProcess $TunnelPidFile 'previous launcher tunnel' 'cloudflared'
    Stop-DiscoveredProjectProcesses
    Assert-PortAvailable

    $server = Start-Server $LocalBaseUrl
    if (-not (Wait-ForHttp "$LocalBaseUrl/healthz" 30)) {
        Stop-RecordedProcess $ServerPidFile 'server' 'node'
        $detail = Get-LogExcerpt $ServerStderr
        if ($detail) { throw "The local MCP server did not start. Log: $ServerStderr`n$detail" }
        throw "The local MCP server did not start. Log: $ServerStderr"
    }

    try { $cloudflared = Resolve-Cloudflared } catch {
        Stop-RecordedProcess $ServerPidFile 'server' 'node'
        throw
    }
    Remove-Item -LiteralPath $TunnelStdout, $TunnelStderr -Force -ErrorAction SilentlyContinue
    Set-Content -LiteralPath $TunnelStdout, $TunnelStderr -Value '' -Encoding utf8 -ErrorAction SilentlyContinue
    $tunnel = Start-Process -FilePath $cloudflared -ArgumentList @('tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', $LocalBaseUrl) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $TunnelStdout -RedirectStandardError $TunnelStderr -PassThru
    Set-Content -LiteralPath $TunnelPidFile -Value $tunnel.Id -Encoding ascii

    $publicBaseUrl = $null
    $deadline = (Get-Date).AddSeconds(45)
    do {
        $publicBaseUrl = Get-QuickTunnelUrl
        if ($publicBaseUrl) { break }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    if (-not $publicBaseUrl) {
        Stop-RecordedProcess $ServerPidFile 'server' 'node'
        Stop-RecordedProcess $TunnelPidFile 'tunnel' 'cloudflared'
        throw "Cloudflare Quick Tunnel URL was not received. Log: $TunnelStderr"
    }

    Stop-RecordedProcess $ServerPidFile 'local server' 'node'
    Start-Sleep -Seconds 1
    Assert-PortAvailable
    $server = Start-Server $publicBaseUrl
    Set-Content -LiteralPath $PublicUrlFile -Value $publicBaseUrl -NoNewline -Encoding ascii
    if (-not (Wait-ForHttp "$LocalBaseUrl/healthz" 30) -or -not (Wait-ForOAuthIssuer "$LocalBaseUrl/.well-known/oauth-authorization-server" $publicBaseUrl 30)) {
        Stop-RecordedProcess $ServerPidFile 'server' 'node'
        Stop-RecordedProcess $TunnelPidFile 'tunnel' 'cloudflared'
        throw "The public MCP server did not restart with the tunnel OAuth issuer. Log: $ServerStderr"
    }
    # Cloudflare Quick Tunnel can publish DNS before the edge starts forwarding.
    # Give the temporary hostname enough time to become reachable.
    if (-not (Wait-ForHttp "$publicBaseUrl/healthz" 120)) {
        Copy-ConnectionUrl
        Write-Host 'Warning: the Quick Tunnel is not reachable yet. The server and tunnel were kept running; retry option 4 after a minute.' -ForegroundColor Yellow
        Write-Host "Server log: $ServerStderr" -ForegroundColor DarkGray
        Write-Host "Tunnel log: $TunnelStderr" -ForegroundColor DarkGray
        return
    }
    if (-not (Wait-ForHttp "$publicBaseUrl/.well-known/oauth-protected-resource/mcp" 60) -or -not (Wait-ForOAuthIssuer "$publicBaseUrl/.well-known/oauth-authorization-server" $publicBaseUrl 60)) {
        Stop-RecordedProcess $ServerPidFile 'server' 'node'
        Stop-RecordedProcess $TunnelPidFile 'tunnel' 'cloudflared'
        throw "OAuth metadata was not published. Log: $ServerStderr"
    }

    Copy-ConnectionUrl
    Write-Host ''
    Write-Host 'The public MCP server is running.' -ForegroundColor Green
    Write-Host "Plugin registration URL: $publicBaseUrl/mcp" -ForegroundColor Yellow
    Write-Host 'When the browser authorization page appears, enter the pairing token from data/bootstrap-token.txt.' -ForegroundColor DarkGray
    Write-Host 'This is a Quick Tunnel URL and may change when the launcher restarts.' -ForegroundColor DarkGray
}

function Get-PreferredLanIp {
    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixLength -gt 0 } |
        Sort-Object -Property InterfaceIndex |
        Select-Object -ExpandProperty IPAddress -Unique)
    if ($addresses.Count -eq 0) { throw 'No usable private IPv4 LAN address was found.' }
    return $addresses[0]
}

function Start-LanMcp {
    $lanIp = Get-PreferredLanIp
    $lanBaseUrl = "http://${lanIp}:8787"
    Write-Host "Starting stable LAN MCP server at $lanBaseUrl/mcp ..." -ForegroundColor Cyan
    Ensure-Dependencies
    Stop-RecordedProcess $ServerPidFile 'previous launcher server' 'node'
    Stop-RecordedProcess $TunnelPidFile 'previous launcher tunnel' 'cloudflared'
    Stop-DiscoveredProjectProcesses
    Assert-PortAvailable
    $server = Start-Server $lanBaseUrl
    if (-not (Wait-ForHttp "$LocalBaseUrl/healthz" 30)) {
        Stop-RecordedProcess $ServerPidFile 'server' 'node'
        $detail = Get-LogExcerpt $ServerStderr
        if ($detail) { throw "The LAN MCP server did not start. Log: $ServerStderr`n$detail" }
        throw "The LAN MCP server did not start. Log: $ServerStderr"
    }
    Set-Content -LiteralPath $PublicUrlFile -Value $lanBaseUrl -NoNewline -Encoding ascii
    Copy-ConnectionUrl
    Write-Host 'LAN MCP server is running. Its URL remains stable while this PC keeps the same LAN IP.' -ForegroundColor Green
    Write-Host 'For other devices on this Wi-Fi/LAN, run scripts\install-firewall.ps1 as Administrator once.' -ForegroundColor Yellow
    Write-Host 'ChatGPT cloud connectors require public HTTPS; use a named tunnel for a stable Internet URL.' -ForegroundColor DarkGray
}

function Convert-SecureStringToPlainText {
    param([Security.SecureString]$SecureString)
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureString)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Read-StableHttpsOrigin {
    param([string]$Prompt)
    $rawUrl = (Read-Host $Prompt).Trim().TrimEnd('/')
    try { $uri = [Uri]$rawUrl } catch { throw 'Enter a valid HTTPS URL such as https://mcp.example.com.' }
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or $uri.HostNameType -eq [UriHostNameType]::Unknown -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) {
        throw 'The stable URL must be an HTTPS origin without a path, query, or fragment.'
    }
    return $uri.GetLeftPart([UriPartial]::Authority)
}

function Read-NamedTunnelName {
    $name = (Read-Host 'New Cloudflare tunnel name (example: remote-mcp-admin-pc)').Trim()
    if ($name -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{1,62}$') {
        throw 'Use 2-63 English letters, numbers, and hyphens. The name must start with a letter or number.'
    }
    return $name
}

function Save-NamedTunnelConfiguration {
    param(
        [string]$PublicBaseUrl,
        [string]$TunnelToken,
        [string]$TunnelName
    )
    if ([string]::IsNullOrWhiteSpace($TunnelToken) -or $TunnelToken.Trim().Length -lt 20) {
        throw 'The Cloudflare named-tunnel token is too short.'
    }
    (ConvertTo-SecureString -String $TunnelToken.Trim() -AsPlainText -Force) |
        ConvertFrom-SecureString |
        Set-Content -LiteralPath $NamedTunnelTokenFile -Encoding ascii
    [ordered]@{
        public_base_url = $PublicBaseUrl.TrimEnd('/')
        tunnel_name = $TunnelName
    } | ConvertTo-Json | Set-Content -LiteralPath $NamedTunnelConfigFile -Encoding utf8
    Write-Host "Saved named-tunnel configuration for $($PublicBaseUrl.TrimEnd('/'))." -ForegroundColor Green
}

function Test-CloudflareTunnelLogin {
    param([string]$Cloudflared)
    $null = & $Cloudflared 'tunnel' 'list' '--output' 'json' 2>&1 | Out-String
    return ($LASTEXITCODE -eq 0)
}

function Ensure-CloudflareTunnelLogin {
    param([string]$Cloudflared)
    if (Test-CloudflareTunnelLogin $Cloudflared) {
        Write-Host 'Cloudflare login is already available on this Windows account.' -ForegroundColor DarkGray
        return
    }
    Write-Host ''
    Write-Host 'Cloudflare browser login is required to create a stable tunnel and its DNS route.' -ForegroundColor Cyan
    Write-Host 'A browser window will open. Sign in, then select the Cloudflare zone that owns the hostname you will enter.' -ForegroundColor DarkGray
    & $Cloudflared 'tunnel' 'login'
    if ($LASTEXITCODE -ne 0 -or -not (Test-CloudflareTunnelLogin $Cloudflared)) {
        throw 'Cloudflare login was not completed. Complete the browser login, then choose option 19 again.'
    }
}

function New-NamedTunnelConfiguration {
    $cloudflared = Resolve-Cloudflared
    Write-Host ''
    Write-Host 'Stable Cloudflare Tunnel setup' -ForegroundColor Cyan
    Write-Host 'Requirements: a domain already active in this Cloudflare account (for example, example.com).' -ForegroundColor DarkGray
    Ensure-CloudflareTunnelLogin $cloudflared

    $tunnelName = Read-NamedTunnelName
    $publicBaseUrl = Read-StableHttpsOrigin 'Stable HTTPS hostname to create (example: https://mcp.example.com)'
    $hostname = ([Uri]$publicBaseUrl).Host
    Write-Host ''
    Write-Host "The launcher will create tunnel '$tunnelName' and add the DNS route '$hostname'." -ForegroundColor Yellow
    Write-Host 'It will not overwrite an existing DNS record.' -ForegroundColor DarkGray
    $confirm = (Read-Host 'Continue? (Y/N)').Trim().ToUpperInvariant()
    if ($confirm -ne 'Y') {
        Write-Host 'Named-tunnel setup cancelled. No Cloudflare changes were made.' -ForegroundColor Yellow
        return
    }

    Write-Host "Creating Cloudflare tunnel '$tunnelName'..." -ForegroundColor Cyan
    $createOutput = & $cloudflared 'tunnel' 'create' $tunnelName 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "Cloudflare could not create the tunnel. Choose a unique name and confirm the browser login. Details: $($createOutput.Trim())"
    }

    Write-Host "Routing $hostname to '$tunnelName'..." -ForegroundColor Cyan
    $routeOutput = & $cloudflared 'tunnel' 'route' 'dns' $tunnelName $hostname 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "The tunnel was created, but Cloudflare could not add the DNS route. Resolve the DNS record in Cloudflare, then use option 19 and choose manual registration. Details: $($routeOutput.Trim())"
    }

    Write-Host 'Fetching the tunnel run token without displaying it...' -ForegroundColor Cyan
    $tunnelToken = (& $cloudflared 'tunnel' 'token' $tunnelName 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $tunnelToken.Length -lt 20) {
        throw 'The tunnel and DNS route were created, but its run token could not be fetched. In Cloudflare Zero Trust, copy the tunnel token and choose option 19 manual registration.'
    }

    Save-NamedTunnelConfiguration -PublicBaseUrl $publicBaseUrl -TunnelToken $tunnelToken -TunnelName $tunnelName
    Write-Host 'Setup complete. Choose option 20 to start the stable MCP URL.' -ForegroundColor Green
}

function Set-NamedTunnelConfigurationManually {
    $publicBaseUrl = Read-StableHttpsOrigin 'Stable public HTTPS URL already routed to your Cloudflare named tunnel'
    $tunnelName = (Read-Host 'Existing Cloudflare tunnel name (optional)').Trim()
    $secureToken = Read-Host 'Cloudflare named-tunnel token (stored encrypted for this Windows user)' -AsSecureString
    $tunnelToken = Convert-SecureStringToPlainText $secureToken
    Save-NamedTunnelConfiguration -PublicBaseUrl $publicBaseUrl -TunnelToken $tunnelToken -TunnelName $tunnelName
    Write-Host 'Cloudflare must already route that hostname to the named tunnel token.' -ForegroundColor DarkGray
}

function Set-NamedTunnelConfiguration {
    Write-Host ''
    Write-Host 'Stable named Cloudflare Tunnel configuration' -ForegroundColor Cyan
    Write-Host '1. Create a new tunnel and DNS hostname automatically (recommended)'
    Write-Host '2. Register an existing tunnel URL and token manually'
    Write-Host 'B. Back'
    $choice = (Read-Host 'Choice').Trim().ToUpperInvariant()
    switch ($choice) {
        '1' { New-NamedTunnelConfiguration }
        '2' { Set-NamedTunnelConfigurationManually }
        'B' { return }
        default { Write-Host 'Choose 1, 2, or B.' -ForegroundColor Yellow }
    }
}

function Get-NamedTunnelConfiguration {
    if (-not (Test-Path -LiteralPath $NamedTunnelConfigFile) -or -not (Test-Path -LiteralPath $NamedTunnelTokenFile)) {
        throw 'Named tunnel is not configured. Choose Configure named Cloudflare tunnel first.'
    }
    $config = Get-Content -Raw -LiteralPath $NamedTunnelConfigFile | ConvertFrom-Json
    $secureToken = Get-Content -Raw -LiteralPath $NamedTunnelTokenFile | ConvertTo-SecureString
    $plainToken = Convert-SecureStringToPlainText $secureToken
    if (-not $config.public_base_url -or $plainToken.Length -lt 20) { throw 'Named tunnel configuration is incomplete.' }
    return [ordered]@{ public_base_url = ([string]$config.public_base_url).TrimEnd('/'); token = $plainToken }
}

function Start-NamedTunnelMcp {
    $named = Get-NamedTunnelConfiguration
    Write-Host "Starting stable named-tunnel MCP server at $($named.public_base_url)/mcp ..." -ForegroundColor Cyan
    Ensure-Dependencies
    Stop-RecordedProcess $ServerPidFile 'previous launcher server' 'node'
    Stop-RecordedProcess $TunnelPidFile 'previous launcher tunnel' 'cloudflared'
    Stop-DiscoveredProjectProcesses
    Assert-PortAvailable
    $server = Start-Server $named.public_base_url
    if (-not (Wait-ForHttp "$LocalBaseUrl/healthz" 30)) {
        Stop-RecordedProcess $ServerPidFile 'server' 'node'
        throw "The local MCP server did not start. Log: $ServerStderr"
    }
    $cloudflared = Resolve-Cloudflared
    Remove-Item -LiteralPath $TunnelStdout, $TunnelStderr -Force -ErrorAction SilentlyContinue
    Set-Content -LiteralPath $TunnelStdout, $TunnelStderr -Value '' -Encoding utf8 -ErrorAction SilentlyContinue
    $previousTunnelToken = [Environment]::GetEnvironmentVariable('TUNNEL_TOKEN', 'Process')
    $env:TUNNEL_TOKEN = $named.token
    try {
        $tunnel = Start-Process -FilePath $cloudflared -ArgumentList @('tunnel', '--no-autoupdate', 'run', '--url', $LocalBaseUrl) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $TunnelStdout -RedirectStandardError $TunnelStderr -PassThru
    } finally {
        if ($null -eq $previousTunnelToken) { Remove-Item Env:TUNNEL_TOKEN -ErrorAction SilentlyContinue } else { $env:TUNNEL_TOKEN = $previousTunnelToken }
    }
    Set-Content -LiteralPath $TunnelPidFile -Value $tunnel.Id -Encoding ascii
    Set-Content -LiteralPath $PublicUrlFile -Value $named.public_base_url -NoNewline -Encoding ascii
    if (-not (Wait-ForHttp "$($named.public_base_url)/healthz" 120)) {
        Stop-RecordedProcess $ServerPidFile 'server' 'node'
        Stop-RecordedProcess $TunnelPidFile 'named tunnel' 'cloudflared'
        throw "The named tunnel URL did not respond. Confirm the Cloudflare hostname routing and token. Log: $TunnelStderr"
    }
    if (-not (Wait-ForHttp "$($named.public_base_url)/.well-known/oauth-protected-resource/mcp" 60)) {
        Stop-RecordedProcess $ServerPidFile 'server' 'node'
        Stop-RecordedProcess $TunnelPidFile 'named tunnel' 'cloudflared'
        throw "OAuth metadata was not published through the named tunnel. Log: $ServerStderr"
    }
    Copy-ConnectionUrl
    Write-Host 'Stable named-tunnel MCP server is running. The connector URL will not change on restart.' -ForegroundColor Green
}

function Get-PublicBaseUrl {
    if (-not (Test-Path -LiteralPath $PublicUrlFile)) { throw 'No saved public URL. Run Start first.' }
    $value = (Get-Content -Raw -LiteralPath $PublicUrlFile).Trim().TrimEnd('/')
    if (-not $value) { throw 'The public URL file is empty.' }
    return $value
}

function Copy-ConnectionUrl {
    $value = Get-PublicBaseUrl
    try {
        Set-Clipboard -Value "$value/mcp"
        Write-Host 'Copied the MCP URL to the clipboard.' -ForegroundColor Green
    } catch {
        Write-Host "MCP URL: $value/mcp" -ForegroundColor Yellow
    }
}

function Get-BootstrapToken {
    $tokenPath = Join-Path $DataRoot 'bootstrap-token.txt'
    if (-not (Test-Path -LiteralPath $tokenPath)) { throw "Pairing token file was not found: $tokenPath" }
    $token = (Get-Content -Raw -LiteralPath $tokenPath).Trim()
    if ($token.Length -lt 20) { throw 'Pairing token file is empty or invalid.' }
    return $token
}

function Copy-PairingToken {
    $token = Get-BootstrapToken
    try {
        Set-Clipboard -Value $token
        Write-Host 'Copied the pairing token to the clipboard. Paste it only into the local OAuth authorization page, then clear the clipboard.' -ForegroundColor Green
    } catch {
        throw "Could not copy the pairing token to the clipboard: $($_.Exception.Message)"
    }
}

function Show-LauncherStatus {
    $serverPid = Get-ValidRecordedPid $ServerPidFile 'node'
    $tunnelPid = Get-ValidRecordedPid $TunnelPidFile 'cloudflared'
    $discoveredServerPids = @(Get-ProjectServerPids)
    $discoveredTunnelPids = @(Get-ProjectTunnelPids)
    if (-not $serverPid -and $discoveredServerPids.Count -gt 0) { $serverPid = $discoveredServerPids[0] }
    if (-not $tunnelPid -and $discoveredTunnelPids.Count -gt 0) { $tunnelPid = $discoveredTunnelPids[0] }
    $serverState = if ($serverPid -and (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) { "running (PID $serverPid)" } else { 'stopped' }
    $tunnelState = if ($tunnelPid -and (Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue)) { "running (PID $tunnelPid)" } else { 'stopped' }
    $public = if (Test-Path -LiteralPath $PublicUrlFile) { (Get-Content -Raw -LiteralPath $PublicUrlFile).Trim() } elseif ($tunnelState -ne 'stopped') { Get-QuickTunnelUrl } else { '(none)' }
    if (-not $public) { $public = '(unknown)' }
    Write-Host "Server: $serverState"
    Write-Host "Tunnel: $tunnelState"
    Write-Host "Public URL: $public"
    $profile = '(defaults to agent on next start)'
    if (Test-Path -LiteralPath $ControlPolicyFile) {
        try { $profile = (Get-Content -Raw -LiteralPath $ControlPolicyFile | ConvertFrom-Json).profile } catch { $profile = '(invalid policy JSON)' }
    }
    Write-Host "Control profile: $profile"
    if ($public -ne '(none)') {
        $endpointMode = if ($public -match '^http://') { 'stable LAN HTTP' } elseif ($public -match 'trycloudflare\.com') { 'temporary Cloudflare Quick Tunnel' } elseif (Test-Path -LiteralPath $NamedTunnelConfigFile) { 'stable named Cloudflare Tunnel' } else { 'custom HTTPS endpoint' }
        Write-Host "Endpoint mode: $endpointMode"
        Write-Host "MCP URL: $public/mcp"
        Write-Host "Local health: $(if (Wait-ForHttp "$LocalBaseUrl/healthz" 2) { 'ok' } else { 'no response' })"
    }
}

function Invoke-ControlProfileScript {
    param([string[]]$Arguments)
    if (-not (Test-Path -LiteralPath $ControlProfileScript)) { throw "Control profile script was not found: $ControlProfileScript" }
    $powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
    & $powerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ControlProfileScript @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Control policy update failed with exit code $LASTEXITCODE." }
}

function Restart-ServerForPolicy {
    $runningServerPids = @(Get-ProjectServerPids)
    if ($runningServerPids.Count -eq 0) {
        Write-Host 'Policy saved. It will be used the next time the MCP server starts.' -ForegroundColor Green
        return
    }
    $public = Get-PublicBaseUrl
    Write-Host 'Restarting the MCP server so the local policy takes effect...' -ForegroundColor Cyan
    Stop-RecordedProcess $ServerPidFile 'server' 'node'
    foreach ($processId in $runningServerPids) {
        Stop-ProcessByIdSafe $processId 'discovered MCP server' 'node'
    }
    Start-Sleep -Milliseconds 500
    Assert-PortAvailable
    $server = Start-Server $public
    if (-not (Wait-ForHttp "$LocalBaseUrl/healthz" 30)) {
        Stop-RecordedProcess $ServerPidFile 'server' 'node'
        $detail = Get-LogExcerpt $ServerStderr
        if ($detail) { throw "The server did not restart after the policy update. Log: $ServerStderr`n$detail" }
        throw "The server did not restart after the policy update. Log: $ServerStderr"
    }
    Write-Host "Policy is active. MCP URL: $public/mcp" -ForegroundColor Green
}

function Set-ControlProfile {
    param(
        [ValidateSet('safe', 'agent', 'full')]
        [string]$Profile
    )
    Invoke-ControlProfileScript @('-Profile', $Profile)
    Restart-ServerForPolicy
}

function Add-ControlWorkspace {
    param([string]$Workspace)
    Invoke-ControlProfileScript @('-AddWorkspace', $Workspace)
    Restart-ServerForPolicy
}

function Show-ControlPolicy {
    Invoke-ControlProfileScript @('-Show')
}

function Stop-PublicMcp {
    Stop-RecordedProcess $ServerPidFile 'server' 'node'
    Stop-RecordedProcess $TunnelPidFile 'tunnel' 'cloudflared'
    Stop-DiscoveredProjectProcesses
    Remove-Item -LiteralPath $PublicUrlFile -Force -ErrorAction SilentlyContinue
    Write-Host 'Stopped the MCP server and tunnel managed by this launcher.' -ForegroundColor Green
}

function Run-OAuthVerification {
    $public = Get-PublicBaseUrl
    if (-not (Wait-ForHttp "$public/healthz" 30)) { throw 'The public MCP URL is not reachable yet. Wait a little and retry verification.' }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    & $node (Join-Path $ProjectRoot 'scripts\verify-oauth.mjs') $public
    if ($LASTEXITCODE -ne 0) { throw 'OAuth verification failed.' }
}

function Open-ChatGpt {
    Start-Process 'https://chatgpt.com/'
    Write-Host 'Opened ChatGPT. Register the MCP URL under Settings > Apps/Connectors/Developer mode.' -ForegroundColor Green
}

function Open-AgentLogin {
    param(
        [ValidateSet('codex', 'claude')]
        [string]$Agent
    )
    $command = Get-Command ("$Agent.exe") -ErrorAction Stop
    # Login requires the person's browser/session. Keep the terminal visible so
    # the person can complete the provider's normal interactive flow.
    $escapedPath = $command.Source.Replace("'", "''")
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoExit', '-Command', "& '$escapedPath' login")
    Write-Host "Opened an interactive $Agent login terminal. Finish login there, then run option 4 to verify." -ForegroundColor Green
}

function Invoke-Action {
    if ($Activity) { Show-ActivityLog; return }
    if ($WatchActivity) { Show-ActivityLog -Follow; return }
    if ($Connections) { Show-ConnectorConnections; return }
    if ($RevokeClient) { Revoke-ConnectorConnection $RevokeClient; return }
    if ($Lan) { Start-LanMcp; return }
    if ($ConfigureNamedTunnel) { Set-NamedTunnelConfiguration; return }
    if ($StartNamedTunnel) { Start-NamedTunnelMcp; return }
    if ($SetProfile) { Set-ControlProfile $SetProfile; return }
    if ($ShowPolicy) { Show-ControlPolicy; return }
    if ($AddWorkspace) { Add-ControlWorkspace $AddWorkspace; return }
    if ($LoginAgent) { Open-AgentLogin $LoginAgent; return }
    if ($Start) { Start-PublicMcp; return }
    if ($Stop) { Stop-PublicMcp; return }
    if ($Copy) { Copy-ConnectionUrl; return }
    if ($CopyToken) { Copy-PairingToken; return }
    if ($Verify) { Run-OAuthVerification; return }
    if ($Open) { Open-ChatGpt; return }
    if ($Status) { Show-LauncherStatus; return }

    do {
        Write-Host ''
        Write-Host '=== Windows Remote MCP Launcher ===' -ForegroundColor Cyan
        Write-Host '1. Start public MCP server (generate HTTPS URL)'
        Write-Host '2. Copy MCP URL'
        Write-Host '3. Copy pairing token'
        Write-Host '4. Verify OAuth + MCP connection'
        Write-Host '5. Open ChatGPT'
        Write-Host '6. Show status'
        Write-Host '7. Stop server/tunnel'
        Write-Host '8. Enable full CLI + agent profile (local policy)'
        Write-Host '9. Enable agent profile (Codex/Claude only)'
        Write-Host '10. Enable safe profile (read-only status/screen tools)'
        Write-Host '11. Show local control policy'
        Write-Host '12. Add an allowed CLI workspace'
        Write-Host '13. Open Codex/Claude interactive login'
        Write-Host '14. Show recent MCP activity log'
        Write-Host '15. Watch live MCP activity log'
        Write-Host '16. Show connector connections and permissions'
        Write-Host '17. Revoke connector connection (reconnect to change permissions)'
        Write-Host '18. Start stable LAN URL (private network only)'
        Write-Host '19. Create/configure stable named Cloudflare Tunnel'
        Write-Host '20. Start configured stable named Cloudflare Tunnel'
        Write-Host 'Q. Quit'
        $choice = (Read-Host 'Choice').Trim().ToUpperInvariant()
        try {
            switch ($choice) {
                '1' { Start-PublicMcp }
                '2' { Copy-ConnectionUrl }
                '3' { Copy-PairingToken }
                '4' { Run-OAuthVerification }
                '5' { Open-ChatGpt }
                '6' { Show-LauncherStatus }
                '7' { Stop-PublicMcp }
                '8' {
                    $confirmation = (Read-Host 'Type FULL to enable remote allowlisted CLI jobs').Trim()
                    if ($confirmation -eq 'FULL') { Set-ControlProfile 'full' } else { Write-Host 'Full profile was not enabled.' -ForegroundColor Yellow }
                }
                '9' { Set-ControlProfile 'agent' }
                '10' { Set-ControlProfile 'safe' }
                '11' { Show-ControlPolicy }
                '12' {
                    $workspace = (Read-Host 'Existing folder to allow for CLI and agent jobs').Trim()
                    if ($workspace) { Add-ControlWorkspace $workspace } else { Write-Host 'No folder was added.' -ForegroundColor Yellow }
                }
                '13' {
                    $agent = (Read-Host 'Agent to log in (codex or claude)').Trim().ToLowerInvariant()
                    if ($agent -in @('codex', 'claude')) { Open-AgentLogin $agent } else { Write-Host 'Choose codex or claude.' -ForegroundColor Yellow }
                }
                '14' { Show-ActivityLog }
                '15' { Show-ActivityLog -Follow }
                '16' { Show-ConnectorConnections }
                '17' {
                    Show-ConnectorConnections
                    $clientId = (Read-Host 'Client ID to revoke').Trim()
                    if ($clientId) { Revoke-ConnectorConnection $clientId } else { Write-Host 'No connector was revoked.' -ForegroundColor Yellow }
                }
                '18' { Start-LanMcp }
                '19' { Set-NamedTunnelConfiguration }
                '20' { Start-NamedTunnelMcp }
                'Q' { return }
                default { Write-Host 'Choose a valid menu item.' -ForegroundColor Yellow }
            }
        } catch {
            Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
        }
    } while ($true)
}

try {
    Invoke-Action
} catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
