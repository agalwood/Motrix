#Requires -Version 5.1
<#
.SYNOPSIS
Owns one temporary, current-user diagnostic Native Messaging registration.
.DESCRIPTION
Uses only app.motrix.bridge.store.p0. Inspect is read-only. Register requires
explicit permission and a new directory. Remove requires the receipt digest
returned by Register; it never removes vendor parents or recursively deletes.
Browser/package verification belongs to the caller. No production host is used.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('Inspect', 'Register', 'Remove')][string]$Action,
  [Parameter(Mandatory = $true)][ValidateSet('chrome', 'edge', 'firefox')][string]$Browser,
  [Parameter(Mandatory = $true)][string]$RunDirectory,
  [string]$ExtensionId,
  [string]$AliasPath,
  [string]$ExpectedPackageVersion,
  [string]$ProbeSha256,
  [string]$SourceCommit,
  [string]$ReceiptSha256,
  [string]$RelayPath,
  [string]$RelaySha256,
  [switch]$AllowTemporaryRegistration
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Action = @{ inspect = 'Inspect'; register = 'Register'; remove = 'Remove' }[$Action.ToLowerInvariant()]
$Browser = $Browser.ToLowerInvariant()

function Get-RegistrationSpec([string]$BrowserName) {
  $vendors = [ordered]@{
    chrome = 'Software\Google\Chrome\NativeMessagingHosts'
    edge = 'Software\Microsoft\Edge\NativeMessagingHosts'
    firefox = 'Software\Mozilla\NativeMessagingHosts'
    chromium = 'Software\Chromium\NativeMessagingHosts'
  }
  if (-not $vendors.Contains($BrowserName)) { throw 'invalid-browser' }
  return [pscustomobject]@{
    hostName = 'app.motrix.bridge.store.p0'
    keyPath = "$($vendors[$BrowserName])\app.motrix.bridge.store.p0"
    pathRole = $BrowserName
  }
}

function Get-RegistrationTargets {
  foreach ($hive in @('CurrentUser', 'LocalMachine')) {
    foreach ($view in @('Registry32', 'Registry64')) {
      foreach ($vendor in @('chrome', 'edge', 'firefox', 'chromium')) {
        [pscustomobject]@{ hive = $hive; view = $view; keyPath = (Get-RegistrationSpec $vendor).keyPath }
      }
    }
  }
}

function Get-BytesHash([byte[]]$Bytes) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
  } finally { $algorithm.Dispose() }
}

function Get-JsonBytes([object]$Value) {
  return ,([Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 6 -Compress) + "`n"))
}

function Assert-RegistrationInputs(
  [string]$BrowserName, [string]$Id, [string]$CandidateAlias, [string]$KnownAlias,
  [string]$Version, [string]$ProbeHash, [string]$Commit
) {
  if ($BrowserName -cnotin @('chrome', 'edge', 'firefox')) { throw 'invalid-browser' }
  if (($BrowserName -ceq 'firefox' -and $Id -cne 'motrix-store-p0@motrix.invalid') -or
      ($BrowserName -cne 'firefox' -and $Id -cnotmatch '^[a-p]{32}$')) { throw 'invalid-extension-id' }
  if ($CandidateAlias -cnotmatch '^[A-Za-z]:\\' -or $CandidateAlias -ine $KnownAlias -or
      $KnownAlias -cnotmatch '\\Microsoft\\WindowsApps\\motrix-store-p0-native-host\.exe$') { throw 'invalid-alias-path' }
  if ($Version -cnotmatch '^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$') { throw 'invalid-package-version' }
  foreach ($part in $Version.Split('.')) { if ([int]$part -gt 65535) { throw 'invalid-package-version' } }
  if ($ProbeHash -cnotmatch '^[0-9a-f]{64}$' -or $Commit -cnotmatch '^[0-9a-f]{40}$') { throw 'invalid-build-digest' }
}

function Get-HostLaunchBinding([string]$BrowserName, [string]$CandidateRelay, [string]$RelayDigest) {
  $hasPath = -not [string]::IsNullOrEmpty($CandidateRelay)
  $hasDigest = -not [string]::IsNullOrEmpty($RelayDigest)
  if ($hasPath -ne $hasDigest) { throw 'relay-parameters-incomplete' }
  if (-not $hasPath) {
    return [pscustomobject]@{ mode = 'execution-alias'; relayPath = $null; relaySha256 = $null }
  }
  if ($BrowserName -cne 'firefox' -or $RelayDigest -cnotmatch '^[0-9a-f]{64}$' -or
      $CandidateRelay -cnotmatch '^[A-Za-z]:\\' -or $CandidateRelay -match '[\x00-\x1f/<>"|?*]' -or
      $CandidateRelay.Substring(2).Contains(':')) { throw 'invalid-relay-binding' }
  $parts = $CandidateRelay.Substring(3).Split('\')
  if ($parts[-1] -cne 'motrix-store-p0-firefox-relay.exe') { throw 'invalid-relay-binding' }
  foreach ($part in $parts) {
    if ([string]::IsNullOrEmpty($part) -or $part -in @('.', '..') -or $part.EndsWith('.') -or $part.EndsWith(' ')) { throw 'invalid-relay-binding' }
  }
  return [pscustomobject]@{ mode = 'firefox-alias-relay'; relayPath = $CandidateRelay; relaySha256 = $RelayDigest }
}

function Get-ReceiptLaunchBinding([object]$Receipt) {
  if ($null -ne $Receipt.PSObject.Properties['relayPath'] -or $null -ne $Receipt.PSObject.Properties['relaySha256']) {
    $binding = Get-HostLaunchBinding $Receipt.browser $Receipt.relayPath $Receipt.relaySha256
    if ($binding.mode -cne 'firefox-alias-relay') { throw 'invalid-receipt' }
    return $binding
  }
  return (Get-HostLaunchBinding $Receipt.browser $null $null)
}

function Assert-RelayFileProperties([bool]$IsRegularFile, [long]$Length, [IO.FileAttributes[]]$PathAttributes) {
  if (-not $IsRegularFile -or $Length -le 0 -or $Length -gt 1048576 -or $PathAttributes.Count -eq 0) { throw 'invalid-relay-file' }
  foreach ($attributes in $PathAttributes) {
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'relay-reparse-path-rejected' }
  }
}

function Assert-RelayContent([byte[]]$Bytes, [string]$ExpectedHash) {
  if ($ExpectedHash -cnotmatch '^[0-9a-f]{64}$' -or $Bytes.Length -lt 256 -or $Bytes.Length -gt 1048576 -or
      (Get-BytesHash $Bytes) -cne $ExpectedHash -or $Bytes[0] -ne 0x4d -or $Bytes[1] -ne 0x5a) { throw 'invalid-relay-content' }
  $pe = [BitConverter]::ToUInt32($Bytes, 0x3c)
  if ($pe -lt 64 -or $pe -gt ($Bytes.Length - 94)) { throw 'invalid-relay-pe' }
  $optionalSize = [BitConverter]::ToUInt16($Bytes, $pe + 20)
  $characteristics = [BitConverter]::ToUInt16($Bytes, $pe + 22)
  if ([BitConverter]::ToUInt32($Bytes, $pe) -ne 0x4550 -or
      [BitConverter]::ToUInt16($Bytes, $pe + 4) -ne 0x8664 -or
      $optionalSize -lt 70 -or ($pe + 24 + $optionalSize) -gt $Bytes.Length -or
      ($characteristics -band 2) -eq 0 -or ($characteristics -band 0x2000) -ne 0 -or
      [BitConverter]::ToUInt16($Bytes, $pe + 24) -ne 0x20b -or
      [BitConverter]::ToUInt16($Bytes, $pe + 92) -ne 3) { throw 'invalid-relay-pe' }
}

function Assert-RelayFile([object]$Binding) {
  if ([IO.Path]::GetFullPath($Binding.relayPath) -cne $Binding.relayPath) { throw 'invalid-relay-binding' }
  $item = Get-Item -LiteralPath $Binding.relayPath -Force -ErrorAction Stop
  $attributes = @(
    for ($current = $item; $null -ne $current; $current = $(if ($current -is [IO.DirectoryInfo]) { $current.Parent } else { $current.Directory })) {
      $current.Attributes
    }
  )
  $isFile = $item -is [IO.FileInfo]
  $length = if ($isFile) { $item.Length } else { 0 }
  Assert-RelayFileProperties $isFile $length $attributes
  # Bound the read again while holding a share-read handle, so a concurrent
  # writer cannot grow the file between the size check and reading its bytes.
  $stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($stream.Length -ne $length) { throw 'relay-content-changed' }
    $bytes = [byte[]]::new($length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
      if ($count -eq 0) { throw 'relay-content-changed' }
      $offset += $count
    }
    Assert-RelayContent $bytes $Binding.relaySha256
  } finally { $stream.Dispose() }
}

function Assert-LaunchTargetForAction([string]$RequestedAction, [object]$Binding) {
  if ($RequestedAction -cnotin @('Register', 'Inspect', 'Remove')) { throw 'invalid-action' }
  # The caller owns the relay. Removing our exact registry/manifest registration
  # must remain possible after that caller removes or replaces its relay file.
  if ($RequestedAction -ceq 'Remove' -or $Binding.mode -ceq 'execution-alias') { return }
  Assert-RelayFile $Binding
}

function New-HostManifest([string]$BrowserName, [string]$Id, [string]$HostAlias) {
  $manifest = [ordered]@{
    name = 'app.motrix.bridge.store.p0'
    description = 'Temporary Motrix Store diagnostic probe'
    path = $HostAlias
    type = 'stdio'
  }
  if ($BrowserName -ceq 'firefox') { $manifest.allowed_extensions = @($Id) }
  else { $manifest.allowed_origins = @("chrome-extension://$Id/") }
  return $manifest
}

function Assert-NewKeyDisposition([int]$Disposition) {
  if ($Disposition -ne 1) { throw 'registry-key-already-exists' }
}

function Assert-OwnedKey([object]$Snapshot, [string]$ManifestPath) {
  if ($Snapshot.exists -isnot [bool] -or -not $Snapshot.exists -or
      $Snapshot.valueCount -ne 1 -or $Snapshot.subKeyCount -ne 0 -or
      $Snapshot.defaultKind -cne 'String' -or $Snapshot.defaultValue -cne $ManifestPath -or
      @($Snapshot.valueNames).Count -ne 1 -or $Snapshot.valueNames[0] -cne '') { throw 'registry-ownership-mismatch' }
}

function Assert-RollbackKey([object]$Snapshot, [bool]$CreatedNew, [string]$ManifestPath) {
  if (-not $CreatedNew -or $Snapshot.exists -isnot [bool]) { throw 'rollback-key-not-owned' }
  if (-not $Snapshot.exists) { return }
  # Only this invocation's disposition=1 is sufficient to own a still-empty
  # key when SetValue failed. A persisted receipt never grants that exception.
  if ($Snapshot.valueCount -eq 0 -and $Snapshot.subKeyCount -eq 0 -and @($Snapshot.valueNames).Count -eq 0) { return }
  Assert-OwnedKey $Snapshot $ManifestPath
}

function Assert-RegistrySurvey([object[]]$Snapshots, [object]$Receipt = $null) {
  $targets = @(Get-RegistrationTargets)
  if ($Snapshots.Count -ne $targets.Count) { throw 'registry-survey-incomplete' }
  $ownedFound = $false
  for ($i = 0; $i -lt $targets.Count; $i++) {
    $expected = $targets[$i]
    $snapshot = $Snapshots[$i]
    if ($snapshot.hive -cne $expected.hive -or $snapshot.view -cne $expected.view -or
        $snapshot.keyPath -cne $expected.keyPath -or $snapshot.exists -isnot [bool]) { throw 'registry-survey-incomplete' }
    if (-not $snapshot.exists) { continue }
    if ($null -eq $Receipt -or $snapshot.hive -cne 'CurrentUser' -or
        $snapshot.keyPath -cne $Receipt.registryPath) { throw 'registration-collision' }
    # HKCU Software may be shared across views. Only the receipt's created view
    # is ever deleted; a visible other view must have the same exact contents.
    Assert-OwnedKey $snapshot $Receipt.manifestPath
    if ($snapshot.view -ceq $Receipt.registryView) { $ownedFound = $true }
  }
  if ($null -ne $Receipt -and -not $ownedFound) { throw 'owned-registration-missing' }
}

function Assert-ReceiptBinding(
  [object]$Receipt, [byte[]]$ReceiptBytes, [string]$ExpectedHash,
  [string]$BrowserName, [string]$DirectoryPath, [byte[]]$ManifestBytes
) {
  if ($ExpectedHash -cnotmatch '^[0-9a-f]{64}$' -or (Get-BytesHash $ReceiptBytes) -cne $ExpectedHash) { throw 'receipt-digest-mismatch' }
  $names = @('schemaVersion', 'runId', 'browser', 'hostName', 'extensionId', 'sourceCommit', 'packageVersion', 'probeSha256', 'aliasPath', 'registryHive', 'registryView', 'registryPath', 'createdNew', 'runDirectory', 'manifestPath', 'manifestSha256')
  $actualNames = @($Receipt.PSObject.Properties.Name)
  if ($actualNames -ccontains 'relayPath' -or $actualNames -ccontains 'relaySha256') { $names += @('relayPath', 'relaySha256') }
  if ($actualNames.Count -ne $names.Count -or @($actualNames | Where-Object { $_ -cnotin $names }).Count -ne 0) { throw 'invalid-receipt' }
  $spec = Get-RegistrationSpec $BrowserName
  if ($Receipt.schemaVersion -ne 1 -or $Receipt.runId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or
      $Receipt.browser -cne $BrowserName -or $Receipt.hostName -cne $spec.hostName -or
      $Receipt.registryHive -cne 'CurrentUser' -or $Receipt.registryView -cne 'Registry32' -or $Receipt.registryPath -cne $spec.keyPath -or
      $Receipt.createdNew -isnot [bool] -or -not $Receipt.createdNew -or
      $Receipt.runDirectory -cne $DirectoryPath -or $Receipt.manifestPath -cne "$DirectoryPath\host-manifest.json" -or
      $Receipt.manifestSha256 -cnotmatch '^[0-9a-f]{64}$' -or (Get-BytesHash $ManifestBytes) -cne $Receipt.manifestSha256) { throw 'invalid-receipt' }
  Assert-RegistrationInputs $Receipt.browser $Receipt.extensionId $Receipt.aliasPath $Receipt.aliasPath $Receipt.packageVersion $Receipt.probeSha256 $Receipt.sourceCommit
  $binding = Get-ReceiptLaunchBinding $Receipt
  $manifestTarget = if ($binding.mode -ceq 'firefox-alias-relay') { $binding.relayPath } else { $Receipt.aliasPath }
  $expectedManifest = Get-JsonBytes (New-HostManifest $Receipt.browser $Receipt.extensionId $manifestTarget)
  if ((Get-BytesHash $expectedManifest) -cne $Receipt.manifestSha256) { throw 'manifest-binding-mismatch' }
}

function Assert-RegularPath([string]$Path, [bool]$Directory = $false) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($Directory -and $item -isnot [IO.DirectoryInfo]) -or
      (-not $Directory -and ($item -isnot [IO.FileInfo] -or $item.Length -gt 65536))) { throw 'invalid-owned-path' }
  for ($current = $item; $null -ne $current; $current = $(if ($current -is [IO.DirectoryInfo]) { $current.Parent } else { $current.Directory })) {
    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse-path-rejected' }
  }
}

function Get-RunPath([string]$Path) {
  if ($Path -cnotmatch '^[A-Za-z]:\\' -or $Path.Contains('/') -or $Path.Contains('..') -or $Path.Substring(2).Contains(':')) { throw 'invalid-run-directory' }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($full -cne $Path -or [IO.Path]::GetPathRoot($full).TrimEnd('\') -ceq $full) { throw 'invalid-run-directory' }
  return $full
}

function Read-OwnedBundle([string]$DirectoryPath, [string]$BrowserName, [string]$Digest) {
  Assert-RegularPath $DirectoryPath $true
  $receiptPath = Join-Path $DirectoryPath 'receipt.json'
  $manifestPath = Join-Path $DirectoryPath 'host-manifest.json'
  Assert-RegularPath $receiptPath
  Assert-RegularPath $manifestPath
  $receiptBytes = [IO.File]::ReadAllBytes($receiptPath)
  $manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
  $receipt = [Text.UTF8Encoding]::new($false, $true).GetString($receiptBytes) | ConvertFrom-Json
  Assert-ReceiptBinding $receipt $receiptBytes $Digest $BrowserName $DirectoryPath $manifestBytes
  return [pscustomobject]@{ receipt = $receipt; receiptPath = $receiptPath; manifestPath = $manifestPath; launch = (Get-ReceiptLaunchBinding $receipt) }
}

function Read-KeySnapshot([Microsoft.Win32.RegistryKey]$Key) {
  if ($null -eq $Key) { return [ordered]@{ exists = $false } }
  $names = @($Key.GetValueNames())
  $hasDefault = $names -ccontains ''
  return [ordered]@{
    exists = $true
    valueCount = $Key.ValueCount
    subKeyCount = $Key.SubKeyCount
    valueNames = $names
    defaultKind = $(if ($hasDefault) { $Key.GetValueKind('').ToString() } else { $null })
    defaultValue = $(if ($hasDefault) { $Key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null })
  }
}

function Get-RegistrySurvey {
  foreach ($target in @(Get-RegistrationTargets)) {
    $hive = [Enum]::Parse([Microsoft.Win32.RegistryHive], $target.hive)
    $view = [Enum]::Parse([Microsoft.Win32.RegistryView], $target.view)
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
    try {
      $key = $base.OpenSubKey($target.keyPath, $false)
      try {
        $snapshot = Read-KeySnapshot $key
        $snapshot.hive = $target.hive
        $snapshot.view = $target.view
        $snapshot.keyPath = $target.keyPath
        [pscustomobject]$snapshot
      } finally { if ($null -ne $key) { $key.Dispose() } }
    } finally { $base.Dispose() }
  }
}

function Add-RegistrationNativeType {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;
public static class MotrixP0RegistrationNative {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateDirectory(string path, IntPtr attributes);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int RegCreateKeyEx(SafeRegistryHandle key, string subKey,
        int reserved, string keyClass, int options, int access, IntPtr attributes,
        out SafeRegistryHandle result, out int disposition);
    public static void CreateDirectoryNew(string path) {
        if (!CreateDirectory(path, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static RegistryKey CreateKey(string path, out int disposition) {
        using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry32)) {
            SafeRegistryHandle result;
            int status = RegCreateKeyEx(root.Handle, path, 0, null, 0, 0x2021f,
                IntPtr.Zero, out result, out disposition);
            if (status != 0) { if (result != null) result.Dispose(); throw new Win32Exception(status); }
            return RegistryKey.FromHandle(result, RegistryView.Registry32);
        }
    }
}
'@
}

function Write-NewBytes([string]$Path, [byte[]]$Bytes) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

function Invoke-RegistrationRollback([object]$Owned) {
  if ($Owned.keyCreated) {
    try {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry32)
      try {
        $key = $base.OpenSubKey($Owned.keyPath, $false)
        try { Assert-RollbackKey ([pscustomobject](Read-KeySnapshot $key)) $Owned.keyCreated $Owned.manifestPath }
        finally { if ($null -ne $key) { $key.Dispose() } }
        if ($null -ne $key) { $base.DeleteSubKey($Owned.keyPath, $false) }
      } finally { $base.Dispose() }
    } catch { return $false }
  }
  try {
    # Validate every completed write before removing any file. Preserve the
    # receipt when another file changed so independent recovery remains possible.
    foreach ($file in $Owned.files) {
      Assert-RegularPath $file.path
      if ((Get-BytesHash ([IO.File]::ReadAllBytes($file.path))) -cne $file.sha256) { throw 'rollback-file-changed' }
    }
    foreach ($file in $Owned.files) { [IO.File]::Delete($file.path) }
    if ($Owned.directoryCreated) {
      Assert-RegularPath $Owned.directory $true
      [IO.Directory]::Delete($Owned.directory, $false)
    }
    return $true
  } catch { return $false }
}

$result = [ordered]@{
  schemaVersion = 1; ok = $false; action = $Action; browser = $Browser
  hostName = 'app.motrix.bridge.store.p0'; registered = $false; cleanupVerified = $false
  registryView = 'Registry32'; registryPathRole = $Browser; hostLaunchMode = 'execution-alias'
}
$owned = [pscustomobject]@{
  directoryCreated = $false; directory = $null; manifestPath = $null
  keyCreated = $false; keyPath = $null; files = [Collections.Generic.List[object]]::new()
}
$stage = 'platform-required'
try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess) { throw 'windows-x64-required' }
  $spec = Get-RegistrationSpec $Browser
  $stage = 'invalid-run-directory'
  $directory = Get-RunPath $RunDirectory
  $stage = 'invalid-relay-binding'
  $launch = Get-HostLaunchBinding $Browser $RelayPath $RelaySha256
  $result.hostLaunchMode = $launch.mode
  if ($launch.mode -ceq 'firefox-alias-relay') { $result.relaySha256 = $launch.relaySha256 }
  if ($Action -ceq 'Inspect' -and [string]::IsNullOrEmpty($ReceiptSha256)) {
    $stage = 'relay-verification-failed'
    Assert-LaunchTargetForAction $Action $launch
    $stage = 'registration-collision'
    Assert-RegistrySurvey @(Get-RegistrySurvey)
    $result.ok = $true
  } elseif ($Action -ceq 'Register') {
    $stage = 'registration-not-authorized'
    if (-not $AllowTemporaryRegistration -or -not [string]::IsNullOrEmpty($ReceiptSha256)) { throw 'registration-not-authorized' }
    $stage = 'invalid-registration-input'
    $knownAlias = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'Microsoft\WindowsApps\motrix-store-p0-native-host.exe'
    Assert-RegistrationInputs $Browser $ExtensionId $AliasPath $knownAlias $ExpectedPackageVersion $ProbeSha256 $SourceCommit
    if (-not [IO.File]::Exists($knownAlias)) { throw 'diagnostic-alias-missing' }
    $stage = 'relay-verification-failed'
    Assert-LaunchTargetForAction $Action $launch
    $stage = 'registration-collision'
    Assert-RegistrySurvey @(Get-RegistrySurvey)
    $stage = 'registration-directory-unavailable'
    Assert-RegularPath ([IO.Path]::GetDirectoryName($directory)) $true
    if (Test-Path -LiteralPath $directory) { throw 'registration-directory-exists' }
    Add-RegistrationNativeType
    [MotrixP0RegistrationNative]::CreateDirectoryNew($directory)
    $owned.directoryCreated = $true
    $owned.directory = $directory
    Assert-RegularPath $directory $true
    $manifestPath = Join-Path $directory 'host-manifest.json'
    $owned.manifestPath = $manifestPath
    $manifestTarget = if ($launch.mode -ceq 'firefox-alias-relay') { $launch.relayPath } else { $knownAlias }
    $manifestBytes = Get-JsonBytes (New-HostManifest $Browser $ExtensionId $manifestTarget)
    Write-NewBytes $manifestPath $manifestBytes
    $owned.files.Add([pscustomobject]@{ path = $manifestPath; sha256 = (Get-BytesHash $manifestBytes) })
    $receipt = [ordered]@{
      schemaVersion = 1; runId = [Guid]::NewGuid().ToString('D'); browser = $Browser; hostName = $spec.hostName
      extensionId = $ExtensionId; sourceCommit = $SourceCommit; packageVersion = $ExpectedPackageVersion
      probeSha256 = $ProbeSha256; aliasPath = $knownAlias
      registryHive = 'CurrentUser'; registryView = 'Registry32'; registryPath = $spec.keyPath; createdNew = $true
      runDirectory = $directory; manifestPath = $manifestPath; manifestSha256 = (Get-BytesHash $manifestBytes)
    }
    if ($launch.mode -ceq 'firefox-alias-relay') {
      $receipt.relayPath = $launch.relayPath
      $receipt.relaySha256 = $launch.relaySha256
    }
    $stage = 'registration-collision'
    Assert-RegistrySurvey @(Get-RegistrySurvey)
    $disposition = 0
    $createdKey = [MotrixP0RegistrationNative]::CreateKey($spec.keyPath, [ref]$disposition)
    try {
      Assert-NewKeyDisposition $disposition
      $owned.keyCreated = $true
      $owned.keyPath = $spec.keyPath
      $stage = 'registration-write-failed'
      # Only a newly-created key may receive the default value or an ownership
      # receipt. An existing empty key is not ours and is never overwritten.
      $createdKey.SetValue('', $manifestPath, [Microsoft.Win32.RegistryValueKind]::String)
      Assert-OwnedKey ([pscustomobject](Read-KeySnapshot $createdKey)) $manifestPath
      $receiptBytes = Get-JsonBytes $receipt
      $receiptPath = Join-Path $directory 'receipt.json'
      Write-NewBytes $receiptPath $receiptBytes
      $owned.files.Add([pscustomobject]@{ path = $receiptPath; sha256 = (Get-BytesHash $receiptBytes) })
      $result.receiptSha256 = Get-BytesHash $receiptBytes
      $result.manifestSha256 = $receipt.manifestSha256
      $result.runId = $receipt.runId
    } finally { $createdKey.Dispose() }
    $stage = 'registration-postcheck-failed'
    $bundle = Read-OwnedBundle $directory $Browser $result.receiptSha256
    Assert-LaunchTargetForAction $Action $bundle.launch
    Assert-RegistrySurvey @(Get-RegistrySurvey) $bundle.receipt
    $result.registered = $true
    $result.ok = $true
  } else {
    $stage = 'ownership-check-failed'
    $bundle = Read-OwnedBundle $directory $Browser $ReceiptSha256
    $receipt = $bundle.receipt
    if ($launch.mode -ceq 'firefox-alias-relay' -and
        ($launch.relayPath -cne $bundle.launch.relayPath -or $launch.relaySha256 -cne $bundle.launch.relaySha256)) { throw 'relay-receipt-mismatch' }
    $launch = $bundle.launch
    $result.hostLaunchMode = $launch.mode
    if ($launch.mode -ceq 'firefox-alias-relay') { $result.relaySha256 = $launch.relaySha256 }
    $result.receiptSha256 = $ReceiptSha256
    $result.manifestSha256 = $receipt.manifestSha256
    $result.runId = $receipt.runId
    Assert-LaunchTargetForAction $Action $launch
    if ($Action -ceq 'Inspect') {
      Assert-RegistrySurvey @(Get-RegistrySurvey) $receipt
      $result.registered = $true
      $result.ok = $true
    } else {
      # Cleanup remains possible after package removal or a foreign fallback
      # collision. It checks and deletes only this exact HKCU leaf key.
      $stage = 'cleanup-key-mismatch'
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry32)
      try {
        $key = $base.OpenSubKey($receipt.registryPath, $false)
        try {
          if ($null -ne $key) {
            Assert-OwnedKey ([pscustomobject](Read-KeySnapshot $key)) $receipt.manifestPath
            $null = Read-OwnedBundle $directory $Browser $ReceiptSha256
          }
        } finally { if ($null -ne $key) { $key.Dispose() } }
        if ($null -ne $key) { $base.DeleteSubKey($receipt.registryPath, $false) }
      } finally { $base.Dispose() }
      $stage = 'cleanup-registration-remains'
      # Never delete a second view/fallback. Any remaining key is reported.
      Assert-RegistrySurvey @(Get-RegistrySurvey)
      $stage = 'cleanup-files-mismatch'
      $null = Read-OwnedBundle $directory $Browser $ReceiptSha256
      [IO.File]::Delete($bundle.manifestPath)
      Assert-RegularPath $bundle.receiptPath
      if ((Get-BytesHash ([IO.File]::ReadAllBytes($bundle.receiptPath))) -cne $ReceiptSha256) { throw 'receipt-digest-mismatch' }
      [IO.File]::Delete($bundle.receiptPath)
      # Nonrecursive removal refuses an unexpected extra file or child folder.
      [IO.Directory]::Delete($directory, $false)
      $result.cleanupVerified = $true
      $result.ok = $true
    }
  }
} catch {
  # Do not leak registry values, paths, raw identities, or exception messages.
  $result.code = $stage
  if ($Action -ceq 'Register' -and ($owned.directoryCreated -or $owned.keyCreated)) {
    $result.cleanupVerified = Invoke-RegistrationRollback $owned
    if ($result.cleanupVerified) {
      # No independent removal is necessary after successful local rollback.
      $result.Remove('receiptSha256')
      $result.registered = $false
    }
  }
}
$result | ConvertTo-Json -Depth 4 -Compress
if ($result.ok) { exit 0 }
exit 1
