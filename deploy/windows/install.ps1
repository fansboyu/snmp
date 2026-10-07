param([switch]$SkipImageLoad)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Docker
$manifest = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'VERSION.json') -Raw | ConvertFrom-Json
foreach ($item in $manifest.files) {
    $file = Join-Path $PSScriptRoot $item.path
    if (-not (Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256) { throw "Package checksum failed: $($item.path)" }
}
if (-not $SkipImageLoad) { Invoke-Docker -Arguments @('load', '--input', (Join-Path $PSScriptRoot 'images.tar')) }
$envFile = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
    $content = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '.env.example'))
    $content = $content.Replace('GENERATE_DATABASE_PASSWORD', (New-RandomHex)).Replace('GENERATE_JWT_SECRET', (New-RandomHex -Bytes 32)).Replace('GENERATE_ADMIN_PASSWORD', (New-RandomHex -Bytes 12))
    Write-Utf8 -Path $envFile -Content $content
    Write-Host 'Created .env with unique credentials. Read ADMIN_PASSWORD there before first login.'
} else { Write-Host 'Existing .env preserved.' }
Assert-Images
Invoke-Compose -Arguments @('config', '--quiet')
Write-Host "Installed release $($manifest.version). Run .\start.ps1"
