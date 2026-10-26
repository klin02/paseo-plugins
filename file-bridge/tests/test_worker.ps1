$ErrorActionPreference = 'Stop'
$worker = Join-Path $PSScriptRoot '../server/start-desktop-transfer.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($worker, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Get-Hash', 'Assert-NoReparsePath', 'Read-TransferFile', 'Remove-EmptyStage')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    Invoke-Expression $definition.Extent.Text
}
function Assert-True($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-Throws([scriptblock]$Action, [string]$Message) {
    $caught = $false
    try { & $Action | Out-Null } catch { $caught = $true }
    Assert-True $caught $Message
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('file-bridge-worker-test-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
    $source = Join-Path $root 'source.txt'
    [IO.File]::WriteAllBytes($source, [Text.Encoding]::UTF8.GetBytes('transfer bytes'))
    $bytes = Read-TransferFile $source
    Assert-True ((Get-Hash $bytes) -eq 'e7a51387646cc5bef7907ebbd2f12231d5ebda61f5e9d597cd608c736cb0193c') 'SHA-256 or file read mismatch'
    Assert-True ([IO.File]::Exists($source)) 'Reading removed source file'
    $empty = Join-Path $root 'empty'
    [IO.File]::WriteAllBytes($empty, [byte[]]@())
    $emptyBytes = Read-TransferFile $empty
    Assert-True ($emptyBytes -is [byte[]] -and $emptyBytes.Length -eq 0) 'Empty files must preserve byte array type'
    $large = Join-Path $root 'large'
    $stream = [IO.File]::Create($large)
    try { $stream.SetLength(32MB + 1) } finally { $stream.Dispose() }
    Assert-Throws { Read-TransferFile $large } 'Oversize file was accepted'
    $folder = Join-Path $root 'job'
    $stage = Join-Path $folder 'upload'
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    Remove-EmptyStage $stage $folder
    Assert-True (-not [IO.Directory]::Exists($folder)) 'Empty staging folders were not removed'
    if ($PSVersionTable.Platform -eq 'Unix') {
        $link = Join-Path $root 'link'
        New-Item -ItemType SymbolicLink -Path $link -Target $source | Out-Null
        Assert-Throws { Read-TransferFile $link } 'Symlink file was accepted'
        $directoryLink = Join-Path $root 'directory-link'
        New-Item -ItemType SymbolicLink -Path $directoryLink -Target $root | Out-Null
        Assert-Throws { Assert-NoReparsePath (Join-Path $directoryLink 'missing/file') } 'Symlink ancestor was accepted'
        Assert-Throws { Remove-EmptyStage $directoryLink $root } 'Cleanup accepted linked directory'
    }
    $watcher = $ast.Find({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.Extent.Text.StartsWith("Add-Type -TypeDefinition @'") }, $true)
    Assert-True ($null -ne $watcher) 'Parent EOF watcher definition missing'
    $watcherSource = $watcher.CommandElements[2].Value
    $harness = Join-Path $root 'watch-parent.ps1'
    $readyFile = Join-Path $root 'watch-ready'
    $doneFile = Join-Path $root 'child-survived'
    $childScript = Join-Path $root 'mock-ssh.ps1'
    [IO.File]::WriteAllText($childScript, 'param([string]$DoneFile); Start-Sleep -Seconds 4; [IO.File]::WriteAllText($DoneFile, "orphan")')
    $harnessSource = @'
param([string]$Pwsh, [string]$ChildScript, [string]$DoneFile, [string]$ReadyFile)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
__WATCHER__
"@
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $Pwsh
$info.Arguments = '-NoProfile -File "' + $ChildScript + '" -DoneFile "' + $DoneFile + '"'
$info.UseShellExecute = $false
$child = [Diagnostics.Process]::Start($info)
[AskGptParentWatch]::Start($child)
[IO.File]::WriteAllText($ReadyFile, [string]$child.Id)
Start-Sleep -Seconds 30
'@
    [IO.File]::WriteAllText($harness, $harnessSource.Replace('__WATCHER__', $watcherSource))
    $hostProcess = [Diagnostics.Process]::GetCurrentProcess()
    $pwsh = $hostProcess.MainModule.FileName
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $pwsh
    $info.Arguments = '-NoProfile -File "' + $harness + '" -Pwsh "' + $pwsh + '" -ChildScript "' + $childScript + '" -DoneFile "' + $doneFile + '" -ReadyFile "' + $readyFile + '"'
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $watchProcess = [Diagnostics.Process]::Start($info)
    $sshProcess = $null
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while (-not [IO.File]::Exists($readyFile) -and [DateTime]::UtcNow -lt $deadline) {
            if ($watchProcess.HasExited) { throw 'Parent watcher harness exited before ready' }
            Start-Sleep -Milliseconds 50
        }
        Assert-True ([IO.File]::Exists($readyFile)) 'Parent watcher harness did not become ready'
        $sshProcess = [Diagnostics.Process]::GetProcessById([int][IO.File]::ReadAllText($readyFile))
        Start-Sleep -Milliseconds 500
        Assert-True (-not $watchProcess.HasExited -and -not $sshProcess.HasExited) 'Open parent stdin terminated watcher or SSH'
        $watchProcess.StandardInput.Close()
        Assert-True ($watchProcess.WaitForExit(6000)) 'Parent stdin EOF did not terminate worker promptly'
        Assert-True ($watchProcess.ExitCode -eq 1) 'Parent stdin EOF must exit worker with error'
        Assert-True ($sshProcess.WaitForExit(2000)) 'Parent stdin EOF left mock SSH alive'
        Assert-True (-not [IO.File]::Exists($doneFile)) 'Mock SSH survived to write completion marker'
    } finally {
        if (-not $watchProcess.HasExited) { $watchProcess.Kill() }
        if ($null -ne $sshProcess) {
            if (-not $sshProcess.HasExited) { $sshProcess.Kill() }
            $sshProcess.Dispose()
        }
        $watchProcess.Dispose()
        $hostProcess.Dispose()
    }
    Write-Output 'PASS: parent pipe stays open; EOF terminates worker and mock SSH'
    Write-Output 'PASS: parse, hashes, empty files, source retention, size limit, empty cleanup, reparse rejection'
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
