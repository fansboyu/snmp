param(
    [Parameter(Mandatory = $true)][string]$ReleaseVersion,
    [string]$OutputDirectory,
    [string]$SourceProject = 'snmp-for',
    [switch]$SkipBuild
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
if ($ReleaseVersion -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$') { throw 'Invalid release version.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repository "releases/netlooker-$ReleaseVersion-windows-amd64" }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if ((Test-Path -LiteralPath $OutputDirectory) -or (Test-Path -LiteralPath ($OutputDirectory + '.zip'))) { throw 'Output already exists; choose a new version or directory.' }
function Run-Docker {
    param([string[]]$Arguments)
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Docker failed (exit $LASTEXITCODE)." }
}
if (-not $SkipBuild) {
    Run-Docker -Arguments @('compose', '--project-directory', $repository, '-p', $SourceProject, '-f', (Join-Path $repository 'docker-compose.yml'), 'build')
}
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'windows') -Force | Copy-Item -Destination $OutputDirectory -Recurse
New-Item -ItemType Directory -Path (Join-Path $OutputDirectory 'postgres') | Out-Null
Copy-Item -LiteralPath (Join-Path $repository 'postgres/schema.sql') -Destination (Join-Path $OutputDirectory 'postgres/schema.sql')
Copy-Item -LiteralPath (Join-Path $repository 'postgres/migrations') -Destination (Join-Path $OutputDirectory 'postgres/migrations') -Recurse
$utf8 = New-Object Text.UTF8Encoding($false)
foreach ($template in @('.env.example', '部署说明.md')) {
    $templatePath = Join-Path $OutputDirectory $template
    [IO.File]::WriteAllText($templatePath, [IO.File]::ReadAllText($templatePath).Replace('RELEASE_VERSION', $ReleaseVersion), $utf8)
}
$images = @()
foreach ($service in @('postgres', 'api-gateway', 'migrator', 'collector-go', 'discovery-worker', 'notifier', 'web-vue3')) {
    $source = if ($service -eq 'postgres') { 'postgres:18-alpine' } else { "${SourceProject}-${service}:latest" }
    $reference = "netlooker/${service}:$ReleaseVersion"
    $details = @(Run-Docker -Arguments @('image', 'inspect', $source) | ConvertFrom-Json)[0]
    if ($details.Os -ne 'linux' -or $details.Architecture -ne 'amd64') { throw "Unsupported image architecture: $source" }
    Run-Docker -Arguments @('tag', $source, $reference)
    $images += [ordered]@{ service = $service; reference = $reference; id = $details.Id; platform = 'linux/amd64' }
}
Run-Docker -Arguments (@('save', '--output', (Join-Path $OutputDirectory 'images.tar')) + @($images | ForEach-Object { $_.reference }))
$commit = & git -C $repository rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot read source revision.' }
$dirty = @(& git -C $repository status --porcelain).Count -gt 0
$manifest = [ordered]@{ product = 'netlooker'; version = $ReleaseVersion; postgresMajor = 18; createdAt = [DateTime]::UtcNow.ToString('o'); platform = 'linux/amd64'; sourceCommit = $commit; includesWorkingTreeChanges = $dirty; images = $images; files = @() }
foreach ($file in Get-ChildItem -LiteralPath $OutputDirectory -Recurse -File -Force) {
    $relative = $file.FullName.Substring($OutputDirectory.Length + 1).Replace([IO.Path]::DirectorySeparatorChar, [char]'/')
    $manifest.files += [ordered]@{ path = $relative; bytes = $file.Length; sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
}
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'VERSION.json'), ($manifest | ConvertTo-Json -Depth 8), $utf8)
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($OutputDirectory, ($OutputDirectory + '.zip'), [IO.Compression.CompressionLevel]::Optimal, $true)
$archiveHash = (Get-FileHash -LiteralPath ($OutputDirectory + '.zip') -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($OutputDirectory + '.zip.sha256'), ($archiveHash + '  ' + [IO.Path]::GetFileName($OutputDirectory + '.zip') + "`n"), $utf8)
Write-Host "Release folder: $OutputDirectory"
Write-Host "Archive: $OutputDirectory.zip"
