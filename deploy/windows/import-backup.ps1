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
$secret = $null
foreach ($line in [IO.File]::ReadAllLines($SourceConfig)) { if ($line -match '^JWT_SECRET=(.+)$') { $secret = $matches[1].Trim([char[]]@('"', "'")) } }
if (-not $secret -or $secret -notmatch '^[A-Za-z0-9_\-]{16,}$') { throw 'SourceConfig must explicitly contain the actual source JWT_SECRET.' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Output directory already exists.' }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
Copy-Item -LiteralPath $DumpFile -Destination (Join-Path $OutputDirectory 'database.dump')
Write-Utf8 -Path (Join-Path $OutputDirectory 'config.env') -Content ("JWT_SECRET=$secret`n")
$record = [ordered]@{ format = 1; postgresMajor = 16; releaseVersion = $SourceVersion; project = 'imported'; createdAt = [DateTime]::UtcNow.ToString('o'); files = @() }
foreach ($name in @('database.dump', 'config.env')) { $record.files += @{ path = $name; sha256 = (Get-FileHash -LiteralPath (Join-Path $OutputDirectory $name) -Algorithm SHA256).Hash.ToLowerInvariant() } }
Write-Utf8 -Path (Join-Path $OutputDirectory 'backup.json') -Content ($record | ConvertTo-Json -Depth 5)
Write-Host "Imported PostgreSQL 16 backup: $OutputDirectory"
