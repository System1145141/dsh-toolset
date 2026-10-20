<#
    dsh-toolset — safe restart helper.

    The Host half creates this script through WMI `Win32_Process.Create` so it
    is parented by WmiPrvSE and therefore survives the Electron process tree
    teardown. It reads `restart-request.json` from its own directory, terminates
    the recorded application tree, and starts `appExe` again.

    Request schema (written by lib/restart.js):
      { armed: true, appPid: <int>, appExe: "<absolute path>",
        appArgs?: [string], logPath?: "<absolute path>", ... }

    The helper never deletes the request; the next Host boot claims it, resumes
    the session and removes it.
#>
[CmdletBinding()]
param(
    [string]$RequestPath,
    [string]$LogPath,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$scriptDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($RequestPath)) {
    $requestPath = Join-Path $scriptDir 'restart-request.json'
} else {
    $requestPath = $RequestPath
}
if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $logPath = Join-Path $scriptDir 'restart.log'
} else {
    $logPath = $LogPath
}

function Write-Log {
    param([string]$Message)
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fff'), $Message
    try {
        Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    } catch {
        # Logging must never break the restart.
    }
}

function Get-ProcessOrNull {
    param([int]$ProcessId)
    try {
        return Get-Process -Id $ProcessId -ErrorAction Stop
    } catch {
        return $null
    }
}

function Wait-ProcessExit {
    param([int]$ProcessId, [int]$TimeoutMs)
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
        if ($null -eq (Get-ProcessOrNull -ProcessId $ProcessId)) { return $true }
        Start-Sleep -Milliseconds 200
    }
    return ($null -eq (Get-ProcessOrNull -ProcessId $ProcessId))
}

try {
    Write-Log 'helper started'
    if (-not (Test-Path -LiteralPath $requestPath)) {
        Write-Log 'no restart request; nothing to do'
        exit 0
    }
    $request = Get-Content -LiteralPath $requestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($request.armed -ne $true) {
        Write-Log 'restart request is not armed; nothing to do'
        exit 0
    }

    $appPid = 0
    [void][int]::TryParse([string]$request.appPid, [ref]$appPid)
    $appExe = [string]$request.appExe
    $appArgs = @()
    if ($null -ne $request.appArgs) { $appArgs = @($request.appArgs | ForEach-Object { [string]$_ }) }

    # Timing knobs travel in the request so the Host owns the defaults; the
    # helper only clamps them to a safe range.
    function Read-Ms {
        param($Value, [int]$Default, [int]$Min, [int]$Max)
        $parsed = 0
        if (-not [int]::TryParse([string]$Value, [ref]$parsed)) { return $Default }
        if ($parsed -lt $Min) { return $Min }
        if ($parsed -gt $Max) { return $Max }
        return $parsed
    }
    $startDelayMs = Read-Ms -Value $request.startDelayMs -Default 700 -Min 0 -Max 5000
    $graceTimeoutMs = Read-Ms -Value $request.graceTimeoutMs -Default 4000 -Min 0 -Max 30000
    $forceTimeoutMs = Read-Ms -Value $request.forceTimeoutMs -Default 5000 -Min 1000 -Max 60000
    $settleMs = Read-Ms -Value $request.settleMs -Default 800 -Min 0 -Max 10000

    Write-Log ("request parsed: appPid={0} appExe={1} appArgs={2} dryRun={3} startDelayMs={4} graceTimeoutMs={5} forceTimeoutMs={6} settleMs={7}" -f $appPid, $appExe, ($appArgs -join ' '), $DryRun, $startDelayMs, $graceTimeoutMs, $forceTimeoutMs, $settleMs)

    if ($appPid -le 0 -or [string]::IsNullOrWhiteSpace($appExe)) {
        Write-Log 'invalid restart request (appPid/appExe); aborting'
        exit 1
    }
    if ($DryRun) {
        Write-Log 'dry run: skipping termination and relaunch'
        exit 0
    }

    # Give the caller's tool-result and HTTP writes a moment to settle.
    Start-Sleep -Milliseconds $startDelayMs

    if ($null -eq (Get-ProcessOrNull -ProcessId $appPid)) {
        Write-Log 'app process already gone; relaunching directly'
    } else {
        if ([bool]$request.gracefulClose -eq $true) {
            Write-Log 'requesting graceful close of the app'
            & taskkill.exe /PID $appPid 2>&1 | Out-Null
            if (Wait-ProcessExit -ProcessId $appPid -TimeoutMs $graceTimeoutMs) {
                Write-Log 'app closed gracefully'
            } else {
                Write-Log 'graceful close did not exit the app; forcing termination'
            }
        }
        if ($null -ne (Get-ProcessOrNull -ProcessId $appPid)) {
            Write-Log 'terminating the app process tree'
            & taskkill.exe /PID $appPid /T /F 2>&1 | Out-Null
            if (-not (Wait-ProcessExit -ProcessId $appPid -TimeoutMs $forceTimeoutMs)) {
                Write-Log 'app process still alive after forced termination; aborting relaunch'
                exit 1
            }
        }
        Write-Log 'app process tree is gone'
    }

    # Let listeners, ports and files settle before a fresh single-instance start.
    Start-Sleep -Milliseconds $settleMs

    $workingDirectory = Split-Path -Parent $appExe
    $startArguments = @{ FilePath = $appExe; ErrorAction = 'Stop' }
    if (-not [string]::IsNullOrWhiteSpace($workingDirectory)) { $startArguments.WorkingDirectory = $workingDirectory }
    if ($appArgs.Count -gt 0) { $startArguments.ArgumentList = $appArgs }
    try {
        Start-Process @startArguments | Out-Null
        Write-Log 'relaunch issued'
    } catch {
        Write-Log ("Start-Process failed ({0}); falling back to cmd start" -f $_.Exception.Message)
        try {
            $quoted = '"{0}"' -f $appExe.Replace('"', '""')
            if ($appArgs.Count -gt 0) {
                $argText = ($appArgs | ForEach-Object { '"{0}"' -f $_.Replace('"', '""') }) -join ' '
                & cmd.exe /c ("start `"`" {0} {1}" -f $quoted, $argText) | Out-Null
            } else {
                & cmd.exe /c ("start `"`" {0}" -f $quoted) | Out-Null
            }
            Write-Log 'relaunch issued through cmd start'
        } catch {
            Write-Log ("relaunch failed: {0}" -f $_.Exception.Message)
            exit 1
        }
    }

    Write-Log 'helper done'
    exit 0
} catch {
    Write-Log ("helper failed: {0}" -f $_.Exception.Message)
    exit 1
}
