#Requires -Version 5.1
param(
  [ValidateRange(0, 2147483647)][int]$TargetPid = 0,
  [ValidateRange(0, 65535)][int]$Port = 0
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# This read-only query emits sensitive local paths only to the controller's
# bounded pipe. The controller retains digests and booleans, never this JSON.
try {
  if ($PSVersionTable.PSEdition -cne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) { exit 1 }
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $motrix = @(Get-Process -Name Motrix -ErrorAction SilentlyContinue)
  if ($TargetPid -eq 0) {
    $packages = @(Get-AppxPackage -Name 'Motrix.Store.Test' -ErrorAction Stop)
    if ($packages.Count -ne 1) { exit 1 }
    $root = $packages[0].InstallLocation.TrimEnd('\') + '\'
    $packageProcesses = @(Get-Process | Where-Object {
      $null -ne $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
    })
    [ordered]@{ processCount = $motrix.Count; packageProcessCount = $packageProcesses.Count } | ConvertTo-Json -Compress
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
  $target = Get-Process -Id $TargetPid -ErrorAction Stop
  $listeners = @()
  if ($Port -ne 0) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object {
      [ordered]@{ pid = [int]$_.OwningProcess; address = $_.LocalAddress }
    })
  }
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
