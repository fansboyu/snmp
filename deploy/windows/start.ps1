. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Docker
Assert-Images
Invoke-Compose -Arguments @('config', '--quiet')
# Migration runs without concurrent application writers, including on upgrades.
Invoke-Compose -Arguments (@('stop') + $script:AppServices)
Invoke-Compose -Arguments @('up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '120', 'postgres')
Invoke-Compose -Arguments @('up', '--no-deps', '--pull', 'never', '--force-recreate', '--abort-on-container-exit', '--exit-code-from', 'migrator', 'migrator')
Invoke-Compose -Arguments (@('up', '-d', '--no-deps', '--pull', 'never') + $script:AppServices)
Wait-Web
