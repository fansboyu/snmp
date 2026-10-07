. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Docker
Invoke-Compose -Arguments @('ps', '-a')
Wait-Web
