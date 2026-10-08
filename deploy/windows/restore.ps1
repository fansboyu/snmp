param([Parameter(Mandatory = $true)][string]$BackupDirectory, [switch]$Force)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Docker
Assert-Images
$config = Get-PackageConfig
$BackupDirectory = (Resolve-Path -LiteralPath $BackupDirectory).Path
$record = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $BackupDirectory 'backup.json') -Raw | ConvertFrom-Json
if ($record.format -ne 1 -or $record.postgresMajor -notin @(16, 18)) { throw 'Only verified PostgreSQL 16 and 18 backups are supported.' }
if ($record.PSObject.Properties['dumpMajor'] -and $record.dumpMajor -gt 18) { throw 'Backup was written by a newer pg_dump than the target PostgreSQL 18 tools.' }
foreach ($name in @('database.dump', 'config.env')) {
    $entry = @($record.files | Where-Object { $_.path -eq $name })
    if ($entry.Count -ne 1 -or (Get-FileHash -LiteralPath (Join-Path $BackupDirectory $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry[0].sha256) { throw "Backup checksum failed: $name" }
}
$sourceSecret = $null
foreach ($line in [IO.File]::ReadAllLines((Join-Path $BackupDirectory 'config.env'))) { if ($line -match '^JWT_SECRET=(.+)$') { $sourceSecret = $matches[1].Trim([char[]]@('"', "'")) } }
if (-not $sourceSecret -or $sourceSecret -notmatch '^[A-Za-z0-9_\-]{16,}$') { throw 'Backup JWT_SECRET is missing or invalid.' }
Write-Host "Target project: $($config.COMPOSE_PROJECT_NAME); database: snmp_monitor; backup release: $($record.releaseVersion)"
if (-not $Force -and (Read-Host 'Restore replaces database contents. Type RESTORE to continue') -cne 'RESTORE') { throw 'Restore canceled.' }
Invoke-Compose -Arguments (@('stop') + $script:AppServices)
Invoke-Compose -Arguments @('up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '120', 'postgres')
if ((Get-PostgresMajor) -ne 18) { throw 'This deployment requires a PostgreSQL 18 target. No data was restored.' }
# Always take a safety backup before replacing any target data.
& (Join-Path $PSScriptRoot 'backup.ps1')
$container = Get-PostgresContainer
$temporary = '/tmp/netlooker-restore-' + (New-RandomHex -Bytes 8) + '.dump'
try {
    Invoke-Docker -Arguments @('cp', (Join-Path $BackupDirectory 'database.dump'), "${container}:$temporary")
    Invoke-Compose -Arguments @('exec', '-T', 'postgres', 'pg_restore', '-U', 'snmp', '-d', 'snmp_monitor', '--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', $temporary)
    $envFile = Join-Path $PSScriptRoot '.env'
    $content = [IO.File]::ReadAllText($envFile)
    $content = [regex]::Replace($content, '(?m)^JWT_SECRET=.*$', ('JWT_SECRET=' + $sourceSecret))
    Write-Utf8 -Path $envFile -Content $content
} finally { Invoke-Compose -Arguments @('exec', '-T', 'postgres', 'rm', '-f', $temporary) }
Write-Host 'Restore completed; original JWT key preserved, target ports/project/database credentials retained.'
Write-Host 'Application services remain stopped. Check mail/discovery settings, then run start.ps1.'
