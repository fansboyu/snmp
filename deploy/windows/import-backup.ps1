param(
    [Parameter(Mandatory = $true)][string]$DumpFile,
    [Parameter(Mandatory = $true)][string]$SourceConfig,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$SourceVersion = 'development'
)
. (Join-Path $PSScriptRoot 'common.ps1')
$DumpFile = (Resolve-Path -LiteralPath $DumpFile).Path
$SourceConfig = (Resolve-Path -LiteralPath $SourceConfig).Path
$stream = [IO.File]::OpenRead($DumpFile)
try {
    $header = New-Object byte[] 5
    if ($stream.Read($header, 0, 5) -ne 5 -or [Text.Encoding]::ASCII.GetString($header) -ne 'PGDMP') { throw 'Expected a pg_dump custom-format file.' }
} finally { $stream.Dispose() }
Assert-Docker
$manifest = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'VERSION.json') -Raw | ConvertFrom-Json
$postgresImage = @($manifest.images | Where-Object { $_.service -eq 'postgres' })[0].reference
$archiveList = (Invoke-Docker -Arguments @('run', '--rm', '--network', 'none', '--mount', "type=bind,source=$DumpFile,target=/backup/database.dump,readonly", '--entrypoint', 'pg_restore', $postgresImage, '--list', '/backup/database.dump')) -join "`n"
if ($archiveList -notmatch 'Dumped from database version: (\d+)\.') { throw 'Cannot identify the source PostgreSQL version.' }
$sourceMajor = [int]$matches[1]
if ($archiveList -notmatch 'Dumped by pg_dump version: (\d+)\.') { throw 'Cannot identify the pg_dump version.' }
$dumpMajor = [int]$matches[1]
if ($sourceMajor -notin @(16, 18) -or $dumpMajor -gt 18) { throw 'Only PostgreSQL 16/18 archives readable by PostgreSQL 18 tools are supported.' }
$secret = $null
foreach ($line in [IO.File]::ReadAllLines($SourceConfig)) { if ($line -match '^JWT_SECRET=(.+)$') { $secret = $matches[1].Trim([char[]]@('"', "'")) } }
if (-not $secret -or $secret -notmatch '^[A-Za-z0-9_\-]{16,}$') { throw 'SourceConfig must explicitly contain the actual source JWT_SECRET.' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Output directory already exists.' }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
Copy-Item -LiteralPath $DumpFile -Destination (Join-Path $OutputDirectory 'database.dump')
Write-Utf8 -Path (Join-Path $OutputDirectory 'config.env') -Content ("JWT_SECRET=$secret`n")
$record = [ordered]@{ format = 1; postgresMajor = $sourceMajor; dumpMajor = $dumpMajor; releaseVersion = $SourceVersion; project = 'imported'; createdAt = [DateTime]::UtcNow.ToString('o'); files = @() }
foreach ($name in @('database.dump', 'config.env')) { $record.files += @{ path = $name; sha256 = (Get-FileHash -LiteralPath (Join-Path $OutputDirectory $name) -Algorithm SHA256).Hash.ToLowerInvariant() } }
Write-Utf8 -Path (Join-Path $OutputDirectory 'backup.json') -Content ($record | ConvertTo-Json -Depth 5)
Write-Host "Imported PostgreSQL $sourceMajor backup: $OutputDirectory"
