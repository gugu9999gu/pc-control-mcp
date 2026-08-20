param(
    [ValidateSet('safe', 'agent', 'full')]
    [string]$Profile,
    [string]$AddWorkspace,
    [switch]$Show
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DataRoot = Join-Path $ProjectRoot 'data'
$PolicyPath = Join-Path $DataRoot 'control-policy.json'

function New-DefaultPolicy {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $nodeRoot = Split-Path -Parent $node
    $workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot '..\..'))
    return [ordered]@{
        version = 1
        profile = 'agent'
        allowed_workspaces = @($workspaceRoot)
        allow_process_stop = $true
        max_concurrent_jobs = 2
        max_job_runtime_seconds = 1800
        max_job_output_bytes = 1048576
        allowed_programs = [ordered]@{
            codex = [ordered]@{ command = 'codex.exe'; description = 'Codex CLI' }
            claude = [ordered]@{ command = 'claude.exe'; description = 'Claude Code CLI' }
            git = [ordered]@{ command = 'git.exe'; description = 'Git' }
            node = [ordered]@{ command = 'node.exe'; description = 'Node.js' }
            npm = [ordered]@{
                command = $node
                fixed_args = @((Join-Path $nodeRoot 'node_modules\npm\bin\npm-cli.js'))
                description = 'npm'
            }
            python = [ordered]@{ command = 'python.exe'; description = 'Python' }
        }
    }
}

function Read-Policy {
    New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
    if (-not (Test-Path -LiteralPath $PolicyPath)) { return New-DefaultPolicy }
    try {
        # Windows PowerShell 5.1 does not provide ConvertFrom-Json -AsHashtable.
        return Get-Content -Raw -LiteralPath $PolicyPath | ConvertFrom-Json
    } catch {
        throw "The control policy is not valid JSON: $PolicyPath. $($_.Exception.Message)"
    }
}

function Save-Policy {
    param([object]$Policy)
    $Policy | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $PolicyPath -Encoding utf8
}

$policy = Read-Policy
$changed = $false

if ($Profile) {
    $policy.profile = $Profile
    $changed = $true
}

if ($AddWorkspace) {
    $resolved = (Resolve-Path -LiteralPath $AddWorkspace -ErrorAction Stop).Path
    if (-not $policy.allowed_workspaces) { $policy.allowed_workspaces = @() }
    $existing = @($policy.allowed_workspaces | ForEach-Object { [System.IO.Path]::GetFullPath([string]$_) })
    if ($existing -notcontains $resolved) {
        $policy.allowed_workspaces = @($existing + $resolved)
        $changed = $true
    }
}

if ($changed -or -not (Test-Path -LiteralPath $PolicyPath)) { Save-Policy $policy }

if ($Show -or $changed) {
    Write-Host "Control policy: $PolicyPath" -ForegroundColor Cyan
    $policy | ConvertTo-Json -Depth 8
}
