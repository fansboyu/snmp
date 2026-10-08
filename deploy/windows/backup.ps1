param([string]$OutputDirectory)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Docker
$config = Get-PackageConfig
$container = Get-PostgresContainer
$postgresMajor = Get-PostgresMajor
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $PSScriptRoot ('backups/' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + (New-RandomHex -Bytes 3)) }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Backup directory already exists; choose a new directory.' }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$temporary = '/tmp/netlooker-' + (New-RandomHex -Bytes 8) + '.dump'
try {
    Invoke-Compose -Arguments @('exec', '-T', 'postgres', 'pg_dump', '-U', 'snmp', '-d', 'snmp_monitor', '--format=custom', '--file', $temporary)
    Invoke-Docker -Arguments @('cp', "${container}:$temporary", (Join-Path $OutputDirectory 'database.dump'))
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '.env') -Destination (Join-Path $OutputDirectory 'config.env')
    $version = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'VERSION.json') -Raw | ConvertFrom-Json
    $record = [ordered]@{ format = 1; postgresMajor = $postgresMajor; dumpMajor = $postgresMajor; releaseVersion = $version.version; project = $config.COMPOSE_PROJECT_NAME; createdAt = [DateTime]::UtcNow.ToString('o'); files = @() }
    foreach ($name in @('database.dump', 'config.env')) { $record.files += @{path = $name; sha256 = (Get-FileHash -LiteralPath (Join-Path $OutputDirectory $name) -Algorithm SHA256).Hash.ToLowerInvariant()} }
    Write-Utf8 -Path (Join-Path $OutputDirectory 'backup.json') -Content ($record | ConvertTo-Json -Depth 5)
} finally { Invoke-Compose -Arguments @('exec', '-T', 'postgres', 'rm', '-f', $temporary) }
Write-Host "Backup completed: $OutputDirectory"
Write-Host 'Contains database and secret configuration. Store this directory privately.'
