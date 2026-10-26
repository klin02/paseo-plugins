param(
    [Parameter(Mandatory=$true)][string]$SshHost,
    [string]$RemoteScript = '.paseo/plugin-data/file-bridge/desktop_transfer.py',
    [Parameter(Mandatory=$true)][string]$DeviceId,
    [Parameter(Mandatory=$true)][string]$SessionId,
    [string]$DeviceName = $env:COMPUTERNAME,
    [switch]$WatchParent,
    [ValidateRange(10,1800)][int]$WaitSeconds = 300
)
$ErrorActionPreference = 'Stop'
$script:dialogsLoaded = $false
function Initialize-FileDialogs {
    if (-not $script:dialogsLoaded) {
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        $script:dialogsLoaded = $true
    }
}

function Get-Hash([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Find-PaseoFileDialog {
    Initialize-FileDialogs
    $editType = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::ControlTypeProperty,
        [Windows.Automation.ControlType]::Edit)
    $windows = [Windows.Automation.AutomationElement]::RootElement.FindAll(
        [Windows.Automation.TreeScope]::Children,
        [Windows.Automation.Condition]::TrueCondition)
    foreach ($window in $windows) {
        try {
            $owner = Get-Process -Id $window.Current.ProcessId -ErrorAction Stop
            if ($owner.ProcessName -notmatch '^Paseo$') { continue }
            if ($window.Current.ClassName -ne '#32770') { continue }
            $edits = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $editType)
            foreach ($edit in $edits) {
                if ($edit.Current.IsEnabled -and ($edit.Current.AutomationId -eq '1148' -or
                    $edit.Current.Name -match '^(File name|\u6587\u4ef6\u540d|\u6a94\u6848\u540d\u7a31)[:\uff1a]?$')) {
                    return [pscustomobject]@{ Window=$window; Edit=$edit }
                }
            }
        } catch { continue }
    }
    return $null
}

function Submit-PaseoFileDialog([string]$Path, [string]$Action) {
    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    [Console]::Error.WriteLine("Waiting for Paseo $Action file dialog. Keep Paseo visible.")
    while ([DateTime]::UtcNow -lt $deadline) {
        $dialog = Find-PaseoFileDialog
        if ($null -ne $dialog) {
            $pattern = $dialog.Edit.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
            $pattern.SetValue($Path)
            $buttons = $dialog.Window.FindAll([Windows.Automation.TreeScope]::Descendants,
                [Windows.Automation.PropertyCondition]::new(
                    [Windows.Automation.AutomationElement]::ControlTypeProperty,
                    [Windows.Automation.ControlType]::Button))
            foreach ($button in $buttons) {
                if ($button.Current.AutomationId -eq '1' -or
                    $button.Current.Name -match '^(Open|Save|\u6253\u5f00|\u958b\u555f|\u4fdd\u5b58|\u5132\u5b58)(\s*\([A-Z&]+\))?$') {
                    $invoke = $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
                    $invoke.Invoke()
                    return
                }
            }
            throw 'File name was set but the Open/Save button was not found. Complete the dialog manually.'
        }
        Start-Sleep -Milliseconds 250
    }
    throw "No Paseo file dialog within $WaitSeconds seconds. Staged file retained: $Path"
}

function Assert-NoReparsePath([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        try { $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop }
        catch {
            if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { $item = $null } else { throw }
        }
        if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing link or reparse point: $current"
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Read-TransferFile([string]$Path) {
    Assert-NoReparsePath $Path
    if (-not [IO.File]::Exists($Path)) { throw "File does not exist: $Path" }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try {
        if ($stream.Length -gt 32MB) { throw 'File exceeds 32 MiB limit.' }
        $bytes = New-Object byte[] $stream.Length
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $n = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($n -eq 0) { throw 'Incomplete file read.' }
            $offset += $n
        }
        return ,$bytes
    } finally { $stream.Dispose() }
}

function Remove-EmptyStage([string]$Stage, [string]$Folder) {
    foreach ($directory in @($Stage, $Folder)) {
        Assert-NoReparsePath $directory
        if ([IO.Directory]::Exists($directory) -and @(Get-ChildItem -LiteralPath $directory -Force).Count -eq 0) {
            Remove-Item -LiteralPath $directory -Force
        }
    }
}

function Write-Message($Message) {
    $json = $Message | ConvertTo-Json -Compress -Depth 8
    $asciiJson = [regex]::Replace($json, '[^\x00-\x7f]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
    $bridge.StandardInput.WriteLine($asciiJson)
    $bridge.StandardInput.Flush()
}

if ($SshHost -cnotmatch '\A(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*\z') { throw 'Use an SSH host alias or user@hostname, with options in your SSH config.' }
if ($RemoteScript -cnotmatch '\A(?:/|\.)[A-Za-z0-9_./-]+\z' -or $RemoteScript.Split('/') -contains '..') { throw 'RemoteScript must be a simple Unix path without parent traversal.' }
if ($DeviceId -cnotmatch '\A[a-f0-9]{32}\z' -or $SessionId -cnotmatch '\A[a-f0-9]{32}\z') { throw 'DeviceId and SessionId must be lowercase UUID hex strings.' }
if ($DeviceName -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\z') { throw 'DeviceName must be a simple computer name.' }
$base = Join-Path ([IO.Path]::GetTempPath()) 'file-bridge'
Assert-NoReparsePath $base
[IO.Directory]::CreateDirectory($base) | Out-Null
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = 'ssh.exe'
$info.Arguments = "-T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 $SshHost python3 -u $RemoteScript worker --device-id $DeviceId --device-name $DeviceName --session-id $SessionId"
$info.UseShellExecute = $false
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
if ($info.PSObject.Properties['StandardInputEncoding']) {
    $info.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
}
$info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
$info.CreateNoWindow = $true
$bridge = [Diagnostics.Process]::new()
$bridge.StartInfo = $info
$started = $false
try {
    $started = $bridge.Start()
    if (-not $started) { throw 'Could not start SSH.' }
    if ($WatchParent) {
        Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Threading;
public static class AskGptParentWatch {
    public static void Start(Process ssh) {
        Thread thread = new Thread(delegate() {
            try {
                using (System.IO.Stream input = Console.OpenStandardInput()) {
                    while (input.ReadByte() != -1) { }
                }
            } catch { }
            try {
                if (!ssh.HasExited) { ssh.Kill(); }
                ssh.WaitForExit(3000);
            } catch { }
            Environment.Exit(1);
        });
        thread.IsBackground = true;
        thread.Start();
    }
}
'@
        [AskGptParentWatch]::Start($bridge)
    }
    $readyTask = $bridge.StandardOutput.ReadLineAsync()
    if (-not $readyTask.Wait(30000)) { throw 'SSH worker ready handshake timed out.' }
    if ($null -eq $readyTask.Result) { throw 'SSH disconnected before worker ready handshake.' }
    $ready = $readyTask.Result | ConvertFrom-Json
    if ($ready.type -ne 'ready' -or $ready.device_id -cne $DeviceId -or
        $ready.session_id -cne $SessionId -or $ready.device_name -cne $DeviceName) {
        throw 'SSH worker ready identity mismatch.'
    }
    [Console]::Out.WriteLine((@{ event='connected'; deviceId=$DeviceId; sessionId=$SessionId; deviceName=$DeviceName } | ConvertTo-Json -Compress))
    [Console]::Error.WriteLine("file-bridge file worker active. Temp root: $base")
    while ($null -ne ($line = $bridge.StandardOutput.ReadLine())) {
        $job = $line | ConvertFrom-Json
        if ($job.ack) { throw 'Unexpected acknowledgement outside a transfer.' }
        if ([string]::IsNullOrWhiteSpace($job.filename) -or $job.filename -in @('.', '..') -or $job.id -cnotmatch '\A[a-f0-9]{32}\z' -or [IO.Path]::GetFileName($job.filename) -ne $job.filename -or
            $job.filename -match '[<>:"/\\|?*\x00-\x1f]|[. ]$' -or
            $job.filename -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$') {
            throw 'Rejected invalid transfer ID or filename.'
        }
        $folder = Join-Path $base $job.id
        $direction = if ($job.action -in @('upload','push','cleanup-upload')) { 'upload' } else { 'download' }
        if ($job.action -eq 'cleanup-upload') {
            if ($job.upload_id -cnotmatch '\A[a-f0-9]{32}\z') { throw 'Invalid original upload ID.' }
            $folder = Join-Path $base $job.upload_id
        }
        $stage = Join-Path $folder $direction
        $path = Join-Path $stage $job.filename
        $completed = $false
        try {
            Assert-NoReparsePath $path
            if ($job.action -notin @('cleanup-upload', 'pull')) { [IO.Directory]::CreateDirectory($stage) | Out-Null }
            if ($job.action -notin @('cleanup-upload', 'pull') -and (Test-Path -LiteralPath $path)) { throw "Refusing to overwrite existing staged file: $path" }
            if ($job.action -in @('upload', 'push')) {
                if ($job.size -lt 0 -or $job.size -gt 32MB -or $job.sha256 -cnotmatch '\A[a-f0-9]{64}\z' -or $job.data_base64.Length -gt 44739244) {
                    throw 'Invalid upload size or digest.'
                }
                $bytes = [Convert]::FromBase64String($job.data_base64)
                if ($bytes.Length -gt 32MB -or $bytes.Length -ne $job.size -or (Get-Hash $bytes) -ne $job.sha256) {
                    throw 'Upload integrity or size check failed.'
                }
                $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
                if ($job.action -eq 'upload') {
                    Write-Message @{ id=$job.id; phase='staged'; stage_path=$path }
                    Submit-PaseoFileDialog $path 'upload'
                }
                $verified = Read-TransferFile $path
                $hash = Get-Hash $verified
                if ($verified.Length -ne $job.size -or $hash -cne $job.sha256) { throw 'Staged upload changed.' }
                Write-Message @{ id=$job.id; ok=$true; staged=$true; stage_path=$path; size=$verified.Length; sha256=$hash }
            } elseif ($job.action -eq 'pull') {
                if ($job.windows_source -notmatch '^[A-Za-z]:[\\/]' -or $job.windows_source.Substring(2) -match '[<>:"|?*\x00-\x1f]') { throw 'windows_source must be an absolute Windows drive path.' }
                $bytes = Read-TransferFile $job.windows_source
                Write-Message @{ id=$job.id; ok=$true; size=$bytes.Length; sha256=(Get-Hash $bytes); data_base64=[Convert]::ToBase64String($bytes) }
            } elseif ($job.action -eq 'download') {
                Write-Message @{ id=$job.id; phase='staged'; stage_path=$path }
                Submit-PaseoFileDialog $path 'download'
                $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
                $bytes = $null
                while ([DateTime]::UtcNow -lt $deadline) {
                    Assert-NoReparsePath $path
                    if (Test-Path -LiteralPath $path) {
                        try {
                            $bytes = Read-TransferFile $path
                            break
                        } catch [IO.IOException] { }
                    }
                    Start-Sleep -Milliseconds 300
                }
                if ($null -eq $bytes) { throw "Download did not complete: $path" }
                Write-Message @{ id=$job.id; ok=$true; size=$bytes.Length; sha256=(Get-Hash $bytes); data_base64=[Convert]::ToBase64String($bytes) }
            } elseif ($job.action -eq 'cleanup-upload') {
                if (Test-Path -LiteralPath $path) {
                    $bytes = Read-TransferFile $path
                    if ($bytes.Length -ne $job.size -or (Get-Hash $bytes) -ne $job.sha256) { throw 'Staged upload changed; refusing cleanup.' }
                    Assert-NoReparsePath $path
                    Remove-Item -LiteralPath $path -Force
                }
                Remove-EmptyStage $stage $folder
                Write-Message @{ id=$job.id; ok=$true; windows_temp_removed=$true }
            } else { throw 'Unknown transfer action.' }
            $completed = $true
        } catch {
            [Console]::Error.WriteLine($_.Exception.Message)
            Write-Message @{ id=$job.id; ok=$false; error=$_.Exception.Message; stage_path=$path }
        }
        $ackLine = $bridge.StandardOutput.ReadLine()
        if ($null -eq $ackLine) { throw 'SSH disconnected before server acknowledgement; staged file retained.' }
        $ack = $ackLine | ConvertFrom-Json
        if (-not $ack.ack -or $ack.id -ne $job.id) { throw 'Unexpected acknowledgement; staged file retained.' }
        if ($ack.ok -eq $true -and $completed) {
            if ($job.action -eq 'download') {
                if ([IO.File]::Exists($path)) {
                    $currentBytes = Read-TransferFile $path
                    if ($currentBytes.Length -ne $bytes.Length -or (Get-Hash $currentBytes) -cne (Get-Hash $bytes)) {
                        throw 'Downloaded temp changed; refusing cleanup.'
                    }
                    Assert-NoReparsePath $path
                    Remove-Item -LiteralPath $path -Force
                }
                Remove-EmptyStage $stage $folder
                [Console]::Error.WriteLine("Download verified on server; Windows temp removed ($($job.id)).")
            } elseif ($job.action -in @('upload', 'push')) {
                [Console]::Error.WriteLine("Upload temp retained until confirmed cleanup. Job: $($job.id)")
            }
        } else { [Console]::Error.WriteLine("Server rejected result; temp retained: $folder") }
    }
    $bridge.WaitForExit()
    if ($bridge.ExitCode -ne 0) { throw "SSH exited with code $($bridge.ExitCode). Check SSH key/agent authentication in a normal terminal first." }
    throw 'SSH worker disconnected.'
} catch {
    [Console]::Error.WriteLine("Disconnected: $($_.Exception.Message)")
    exit 1
} finally {
    if ($started -and -not $bridge.HasExited) { $bridge.Kill(); $bridge.WaitForExit() }
    $bridge.Dispose()
}
