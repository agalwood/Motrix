#Requires -Version 5.1
param(
  [ValidateRange(0, 2147483647)][int]$TargetPid = 0,
  [ValidateRange(0, 65535)][int]$Port = 0
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Resolve-MainListenerOwner([object[]]$Listeners) {
  # These records are ordered dictionaries. Select-Object -ExpandProperty
  # cannot read their keys, so project the PID through dictionary adaptation.
  $owners = @($Listeners | ForEach-Object {
    if ($_.pid -isnot [int] -or $_.pid -lt 1) { throw 'Invalid listener owner.' }
    $_.pid
  } | Sort-Object -Unique)
  if ($owners.Count -ne 1) { throw 'Expected one listener owner.' }
  return $owners[0]
}
# This read-only query emits sensitive local paths only to the controller's
# bounded pipe. The controller retains digests and booleans, never this JSON.
try {
  if ($PSVersionTable.PSEdition -cne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) { exit 1 }
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $motrix = @(Get-Process -Name Motrix -ErrorAction SilentlyContinue)
  if ($TargetPid -eq 0 -and $Port -eq 0) {
    $packages = @(Get-AppxPackage -Name 'Motrix.Store.Test' -ErrorAction Stop)
    if ($packages.Count -ne 1) { exit 1 }
    $root = $packages[0].InstallLocation.TrimEnd('\') + '\'
    $packageProcesses = @(Get-Process | Where-Object {
      $null -ne $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
    })
    $mainPath = Join-Path $packages[0].InstallLocation 'app\Motrix.exe'
    $mainRoots = @(Get-CimInstance Win32_Process -Filter "Name='Motrix.exe'" -ErrorAction Stop | Where-Object {
      $_.ExecutablePath -ieq $mainPath -and $null -ne $_.CommandLine -and -not $_.CommandLine.Contains('--type=')
    } | ForEach-Object { [int]$_.ProcessId })
    [ordered]@{ processCount = $motrix.Count; packageProcessCount = $packageProcesses.Count; mainRoots = $mainRoots; queriedAtTicks = [DateTime]::UtcNow.Ticks.ToString() } | ConvertTo-Json -Compress
    exit 0
  }
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MotrixMainIdentity {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder name);
    public static string Read(IntPtr process, bool application) {
        uint length = 0;
        int result = application ? GetApplicationUserModelId(process, ref length, null) : GetPackageFullName(process, ref length, null);
        if (result != 122 || length < 2 || length > 512) throw new InvalidOperationException();
        StringBuilder value = new StringBuilder((int)length);
        result = application ? GetApplicationUserModelId(process, ref length, value) : GetPackageFullName(process, ref length, value);
        if (result != 0) throw new InvalidOperationException();
        return value.ToString();
    }
}
'@
  $listeners = @()
  if ($Port -ne 0) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object {
      [ordered]@{ pid = [int]$_.OwningProcess; address = $_.LocalAddress }
    })
  }
  if ($TargetPid -eq 0) {
    $TargetPid = Resolve-MainListenerOwner $listeners
  }
  $target = Get-Process -Id $TargetPid -ErrorAction Stop
  [ordered]@{
    pid = $target.Id
    executable = $target.Path
    startTicks = $target.StartTime.ToUniversalTime().Ticks.ToString()
    sessionId = $target.SessionId
    sameSession = $target.SessionId -eq [Diagnostics.Process]::GetCurrentProcess().SessionId
    packageFullName = [MotrixMainIdentity]::Read($target.Handle, $false)
    applicationUserModelId = [MotrixMainIdentity]::Read($target.Handle, $true)
    listeners = $listeners
  } | ConvertTo-Json -Compress -Depth 4
} catch { exit 1 }
