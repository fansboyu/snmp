Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:PackageRoot = $PSScriptRoot
$script:AppServices = @('api-gateway', 'web-vue3', 'collector-go', 'discovery-worker', 'notifier')

function Invoke-Docker {
    param([string[]]$Arguments)
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Docker command failed (exit $LASTEXITCODE)." }
}

function Assert-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install and start Docker Desktop with Linux containers first.' }
    $engine = Invoke-Docker -Arguments @('info', '--format', '{{.OSType}}/{{.Architecture}}')
    if ($engine -notmatch '^linux/(x86_64|amd64)$') { throw 'This package requires a Linux amd64 Docker engine.' }
    $composeVersion = Invoke-Docker -Arguments @('compose', 'version', '--short')
    $parsedVersion = [version](($composeVersion -replace '^v', '') -replace '-.*$', '')
    if ($parsedVersion -lt [version]'2.20.0') { throw 'Docker Compose 2.20 or newer is required.' }
}

function Get-PackageConfig {
    $file = Join-Path $script:PackageRoot '.env'
    if (-not (Test-Path -LiteralPath $file)) { throw 'Run install.ps1 first; .env is missing.' }
    $config = @{}
    foreach ($line in [IO.File]::ReadAllLines($file)) {
        if ($line -match '^([A-Z_][A-Z0-9_]*)=(.*)$') { $config[$matches[1]] = $matches[2].Trim([char[]]@('"', "'")) }
    }
    foreach ($key in @('IMAGE_VERSION', 'COMPOSE_PROJECT_NAME', 'POSTGRES_PASSWORD', 'JWT_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'WEB_PORT')) {
        if (-not $config.ContainsKey($key) -or -not $config[$key]) { throw "Required configuration is missing: $key" }
    }
    if ($config.COMPOSE_PROJECT_NAME -notmatch '^[a-z0-9][a-z0-9_-]*$') { throw 'Invalid COMPOSE_PROJECT_NAME.' }
    if ($config.POSTGRES_PASSWORD -notmatch '^[A-Za-z0-9_-]{16,}$') { throw 'POSTGRES_PASSWORD must have 16+ URL-safe letters, digits, underscores or hyphens.' }
    $port = 0
    if (-not [int]::TryParse($config.WEB_PORT, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw 'Invalid WEB_PORT.' }
    return $config
}

function Invoke-Compose {
    param([string[]]$Arguments)
    $config = Get-PackageConfig
    Invoke-Docker -Arguments (@('compose', '--project-directory', $script:PackageRoot, '--env-file', (Join-Path $script:PackageRoot '.env'), '-p', $config.COMPOSE_PROJECT_NAME, '-f', (Join-Path $script:PackageRoot 'compose.yaml')) + $Arguments)
}

function Assert-Images {
    $manifest = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $script:PackageRoot 'VERSION.json') -Raw | ConvertFrom-Json
    $config = Get-PackageConfig
    if ($config.IMAGE_VERSION -ne $manifest.version) { throw 'IMAGE_VERSION does not match this release manifest.' }
    foreach ($image in $manifest.images) {
        $id = Invoke-Docker -Arguments @('image', 'inspect', $image.reference, '--format', '{{.Id}}')
        if ($id -ne $image.id) { throw "Image content mismatch: $($image.reference). Reload images.tar with install.ps1." }
    }
}

function Write-Utf8 {
    param([string]$Path, [string]$Content)
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function New-RandomHex {
    param([int]$Bytes = 24)
    $buffer = New-Object byte[] $Bytes
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($buffer)).Replace('-', '').ToLowerInvariant()
}

function Get-PostgresContainer {
    $id = Invoke-Compose -Arguments @('ps', '-q', 'postgres')
    if (-not $id) { throw 'PostgreSQL is not running. Run start.ps1 first.' }
    return [string]$id
}

function Get-PostgresMajor {
    $number = [int](Invoke-Compose -Arguments @('exec', '-T', 'postgres', 'psql', '-X', '-U', 'snmp', '-d', 'snmp_monitor', '-At', '-c', 'show server_version_num'))
    return [int][Math]::Floor($number / 10000)
}

function Wait-Web {
    $config = Get-PackageConfig
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    $url = "http://127.0.0.1:$($config.WEB_PORT)/health"
    do {
        try {
            $health = Invoke-RestMethod -Uri $url -TimeoutSec 3
            if ($health.status -eq 'ok') { Write-Host "Ready: http://localhost:$($config.WEB_PORT)"; return }
        } catch { }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Web/API health check timed out. Run status.ps1 or docker compose logs.'
}
