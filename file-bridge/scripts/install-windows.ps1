param([string]$DaemonHost = '127.0.0.1:6768')
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this installer on Windows.' }
if ($DaemonHost -notmatch '\A(?:127\.0\.0\.1|localhost):[0-9]{1,5}\z') { throw 'Use a local daemon address, such as 127.0.0.1:6768.' }
$source = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $env:LOCALAPPDATA 'Paseo\plugins\file-bridge'
New-Item -ItemType Directory -Force $destination | Out-Null
foreach ($name in @('paseo-plugin.json','OVERVIEW.md','README.md','index.client.tsx','index.server.ts','client','server','shared')) {
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination $destination -Recurse -Force
}
Write-Output "File Bridge plugin source ready: $destination"
$cli = Get-Command paseo -ErrorAction SilentlyContinue
if ($null -ne $cli) {
    $installed = & $cli.Source --host $DaemonHost plugin ls --json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Cannot reach the local daemon. Add the printed directory in its Settings > Plugins.' }
    $existing = @($installed | Where-Object { $_.id -eq 'file-bridge' })
    if ($existing.Count) {
        $registered = [IO.Path]::GetFullPath($existing[0].path).TrimEnd('\')
        $expected = [IO.Path]::GetFullPath($destination).TrimEnd('\')
        if ($registered -ine $expected) {
            throw "Existing file-bridge uses another source: $registered. In the LOCAL host Settings > Plugins remove that installation, then rerun this installer to register $destination. Source files and SSH settings are retained."
        }
        & $cli.Source --host $DaemonHost plugin reload file-bridge --json
    } else {
        & $cli.Source --host $DaemonHost plugin install $destination --json
    }
    if ($LASTEXITCODE -ne 0) { throw 'Plugin install/reload failed. Check local Settings > Plugins.' }
    & $cli.Source --host $DaemonHost plugin ls file-bridge --json
} else {
    Write-Output 'Select the LOCAL Windows host in Paseo, open Settings > Plugins, and add this directory:'
    Write-Output $destination
}
Write-Output 'Open File Bridge on the Windows host; click acquire control and verify node030 shows this computer.'
