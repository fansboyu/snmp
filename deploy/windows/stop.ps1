. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Docker
Invoke-Compose -Arguments @('stop')
Write-Host 'Stopped. Database volume and configuration are preserved.'
