#Requires -Version 5.1
<#
.SYNOPSIS
Exercises temporary registration ownership guards without registry access.
#>
[CmdletBinding()]
param([string]$ReportPath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$results = [Collections.Generic.List[object]]::new()

function New-OwnershipFixture {
  $directory = 'C:\Synthetic\browser\registration'
  $alias = 'C:\Synthetic\Local\Microsoft\WindowsApps\motrix-store-p0-native-host.exe'
  $id = 'abcdefghijklmnopabcdefghijklmnop'
  $manifest = Get-JsonBytes (New-HostManifest 'chrome' $id $alias)
  $receipt = [pscustomobject][ordered]@{
    schemaVersion = 1; runId = '12345678-1234-4123-8123-123456789abc'; browser = 'chrome'
    hostName = 'app.motrix.bridge.store.p0'; extensionId = $id; sourceCommit = ('a' * 40)
    packageVersion = '1.0.1.0'; probeSha256 = ('b' * 64); aliasPath = $alias
    registryHive = 'CurrentUser'; registryView = 'Registry32'
    registryPath = 'Software\Google\Chrome\NativeMessagingHosts\app.motrix.bridge.store.p0'
    createdNew = $true; runDirectory = $directory; manifestPath = "$directory\host-manifest.json"
    manifestSha256 = (Get-BytesHash $manifest)
  }
  $receiptBytes = Get-JsonBytes $receipt
  $snapshots = @(
    foreach ($target in @(Get-RegistrationTargets)) {
      [pscustomobject]@{
        hive = $target.hive; view = $target.view; keyPath = $target.keyPath
        exists = $false; valueCount = 0; subKeyCount = 0; valueNames = @()
        defaultKind = $null; defaultValue = $null
      }
    }
  )
  $ownedKey = [pscustomobject]@{
    hive = 'CurrentUser'; view = 'Registry32'; keyPath = $receipt.registryPath
    exists = $true; valueCount = 1; subKeyCount = 0; valueNames = @('')
    defaultKind = 'String'; defaultValue = $receipt.manifestPath
  }
  return [pscustomobject]@{
    directory = $directory; alias = $alias; knownAlias = $alias; id = $id; browser = 'chrome'
    receipt = $receipt; receiptBytes = $receiptBytes; digest = (Get-BytesHash $receiptBytes)
    manifestBytes = $manifest; snapshots = $snapshots; ownedKey = $ownedKey
    disposition = 1; createdNew = $true
  }
}

function Test-OwnershipCase(
  [string]$Name,
  [ValidateSet('absent', 'owned-survey', 'receipt', 'key', 'rollback', 'inputs', 'disposition')][string]$Guard,
  [bool]$Reject = $false,
  [scriptblock]$Mutate = {}
) {
  $fixture = New-OwnershipFixture
  if ($Guard -ceq 'owned-survey') { $fixture.snapshots[0] = $fixture.ownedKey }
  # Mutations run outside the expected-rejection catch, so a broken fixture
  # cannot masquerade as successful rejection by a production guard.
  $null = & $Mutate $fixture
  $rejected = $false
  try {
    switch ($Guard) {
      'absent' { Assert-RegistrySurvey $fixture.snapshots }
      'owned-survey' { Assert-RegistrySurvey $fixture.snapshots $fixture.receipt }
      'receipt' { Assert-ReceiptBinding $fixture.receipt $fixture.receiptBytes $fixture.digest $fixture.browser $fixture.directory $fixture.manifestBytes }
      'key' { Assert-OwnedKey $fixture.ownedKey $fixture.receipt.manifestPath }
      'rollback' { Assert-RollbackKey $fixture.ownedKey $fixture.createdNew $fixture.receipt.manifestPath }
      'inputs' { Assert-RegistrationInputs $fixture.browser $fixture.id $fixture.alias $fixture.knownAlias $fixture.receipt.packageVersion $fixture.receipt.probeSha256 $fixture.receipt.sourceCommit }
      'disposition' { Assert-NewKeyDisposition $fixture.disposition }
    }
  } catch { $rejected = $true }
  $results.Add([ordered]@{
    name = $Name; ok = ($rejected -eq $Reject)
    expected = $(if ($Reject) { 'rejected' } else { 'accepted' })
    observed = $(if ($rejected) { 'rejected' } else { 'accepted' })
  })
}

try {
  $source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../scripts/windows-store-browser-registration.ps1'))
  $tokens = $null
  $parseErrors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
  if (@($parseErrors).Count -ne 0) { throw 'registration-parser-failed' }
  $definitions = @(
    foreach ($name in @('Get-RegistrationSpec', 'Get-RegistrationTargets', 'Get-BytesHash', 'Get-JsonBytes', 'Assert-RegistrationInputs', 'New-HostManifest', 'Assert-NewKeyDisposition', 'Assert-OwnedKey', 'Assert-RollbackKey', 'Assert-RegistrySurvey', 'Assert-ReceiptBinding', 'Get-HostLaunchBinding', 'Get-ReceiptLaunchBinding', 'Assert-RelayFileProperties', 'Assert-RelayContent', 'Assert-LaunchTargetForAction')) {
      $matching = @($ast.EndBlock.Statements | Where-Object {
        $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name
      })
      if ($matching.Count -ne 1) { throw 'registration-guard-missing' }
      $matching[0].Extent.Text
    }
  )
  # No main script, registry API, filesystem mutation helper or native type is
  # loaded. Only the named pure definitions above can be executed by this test.
  . ([scriptblock]::Create(($definitions -join "`n")))

  function Relay-Check([string]$Name, [scriptblock]$Test, [bool]$Reject = $false) {
    $rejected = $false
    try { $null = & $Test } catch { $rejected = $true }
    $results.Add([ordered]@{ name = $Name; ok = ($rejected -eq $Reject); expected = $(if ($Reject) { 'rejected' } else { 'accepted' }); observed = $(if ($rejected) { 'rejected' } else { 'accepted' }) })
  }
  $relayPath = 'C:\Synthetic\relay\motrix-store-p0-firefox-relay.exe'
  $relayDigest = 'a' * 64
  Relay-Check 'accepts-explicit-firefox-relay-binding' { Get-HostLaunchBinding 'firefox' $relayPath $relayDigest }
  Relay-Check 'rejects-chrome-relay' { Get-HostLaunchBinding 'chrome' $relayPath $relayDigest } $true
  Relay-Check 'rejects-relay-without-digest' { Get-HostLaunchBinding 'firefox' $relayPath $null } $true
  Relay-Check 'rejects-digest-without-relay' { Get-HostLaunchBinding 'firefox' $null $relayDigest } $true
  Relay-Check 'rejects-other-relay-filename' { Get-HostLaunchBinding 'firefox' 'C:\Synthetic\other.exe' $relayDigest } $true
  Relay-Check 'rejects-relative-relay' { Get-HostLaunchBinding 'firefox' 'motrix-store-p0-firefox-relay.exe' $relayDigest } $true
  Relay-Check 'rejects-relay-parent-traversal' { Get-HostLaunchBinding 'firefox' 'C:\Synthetic\..\motrix-store-p0-firefox-relay.exe' $relayDigest } $true
  Relay-Check 'rejects-relay-empty-path-component' { Get-HostLaunchBinding 'firefox' 'C:\Synthetic\\motrix-store-p0-firefox-relay.exe' $relayDigest } $true
  Relay-Check 'rejects-empty-relay-file' { Assert-RelayFileProperties $true 0 @([IO.FileAttributes]::Normal) } $true
  Relay-Check 'rejects-oversized-relay-file' { Assert-RelayFileProperties $true 1048577 @([IO.FileAttributes]::Normal) } $true
  Relay-Check 'rejects-relay-parent-reparse' { Assert-RelayFileProperties $true 512 @([IO.FileAttributes]::Normal, [IO.FileAttributes]::ReparsePoint) } $true
  $peBytes = [byte[]]::new(512)
  $peBytes[0] = 0x4d; $peBytes[1] = 0x5a
  [BitConverter]::GetBytes([uint32]128).CopyTo($peBytes, 0x3c)
  [BitConverter]::GetBytes([uint32]0x4550).CopyTo($peBytes, 128)
  [BitConverter]::GetBytes([uint16]0x8664).CopyTo($peBytes, 132)
  [BitConverter]::GetBytes([uint16]112).CopyTo($peBytes, 148)
  [BitConverter]::GetBytes([uint16]2).CopyTo($peBytes, 150)
  [BitConverter]::GetBytes([uint16]0x20b).CopyTo($peBytes, 152)
  [BitConverter]::GetBytes([uint16]3).CopyTo($peBytes, 220)
  Relay-Check 'accepts-bound-x64-console-header' { Assert-RelayContent $peBytes (Get-BytesHash $peBytes) }
  Relay-Check 'rejects-relay-digest-mismatch' { Assert-RelayContent $peBytes ('f' * 64) } $true
  $peBytes[220] = 2
  Relay-Check 'rejects-gui-relay-header' { Assert-RelayContent $peBytes (Get-BytesHash $peBytes) } $true
  function Assert-RelayFile([object]$Binding) { throw 'pure-test-filesystem-sentinel' }
  $relayBinding = Get-HostLaunchBinding 'firefox' $relayPath $relayDigest
  Relay-Check 'remove-does-not-read-relay-after-caller-removes-it' { Assert-LaunchTargetForAction 'Remove' $relayBinding }
  Relay-Check 'inspect-does-read-relay' { Assert-LaunchTargetForAction 'Inspect' $relayBinding } $true
  Relay-Check 'register-does-read-relay' { Assert-LaunchTargetForAction 'Register' $relayBinding } $true
  $relayFixture = New-OwnershipFixture
  $relayFixture.browser = 'firefox'
  $relayFixture.receipt.browser = 'firefox'
  $relayFixture.receipt.extensionId = 'motrix-store-p0@motrix.invalid'
  $relayFixture.receipt.registryPath = 'Software\Mozilla\NativeMessagingHosts\app.motrix.bridge.store.p0'
  $relayFixture.receipt | Add-Member -NotePropertyName relayPath -NotePropertyValue $relayPath
  $relayFixture.receipt | Add-Member -NotePropertyName relaySha256 -NotePropertyValue $relayDigest
  $relayFixture.manifestBytes = Get-JsonBytes (New-HostManifest 'firefox' $relayFixture.receipt.extensionId $relayPath)
  $relayFixture.receipt.manifestSha256 = Get-BytesHash $relayFixture.manifestBytes
  $relayFixture.receiptBytes = Get-JsonBytes $relayFixture.receipt
  $relayFixture.digest = Get-BytesHash $relayFixture.receiptBytes
  Relay-Check 'accepts-relay-receipt-without-reading-owned-target' { Assert-ReceiptBinding $relayFixture.receipt $relayFixture.receiptBytes $relayFixture.digest 'firefox' $relayFixture.directory $relayFixture.manifestBytes }
  $relayFixture.receipt.relayPath = 'C:\Synthetic\changed\motrix-store-p0-firefox-relay.exe'
  $relayFixture.receiptBytes = Get-JsonBytes $relayFixture.receipt
  $relayFixture.digest = Get-BytesHash $relayFixture.receiptBytes
  Relay-Check 'rejects-rebound-relay-path-with-original-manifest' { Assert-ReceiptBinding $relayFixture.receipt $relayFixture.receiptBytes $relayFixture.digest 'firefox' $relayFixture.directory $relayFixture.manifestBytes } $true

  $targets = @(Get-RegistrationTargets)
  $targetLabels = @($targets | ForEach-Object { "$($_.hive)/$($_.view)/$($_.keyPath)" })
  $coverageOk = ($targets.Count -eq 16 -and @($targetLabels | Select-Object -Unique).Count -eq 16)
  foreach ($hive in @('CurrentUser', 'LocalMachine')) {
    foreach ($view in @('Registry32', 'Registry64')) {
      foreach ($vendorPath in @('Google\Chrome', 'Microsoft\Edge', 'Mozilla', 'Chromium')) {
        if ($targetLabels -cnotcontains "$hive/$view/Software\$vendorPath\NativeMessagingHosts\app.motrix.bridge.store.p0") { $coverageOk = $false }
      }
    }
  }
  $results.Add([ordered]@{ name = 'surveys-both-hives-views-and-fallbacks'; ok = $coverageOk; expected = '16-fixed-targets'; observed = $(if ($coverageOk) { '16-fixed-targets' } else { 'coverage-mismatch' }) })

  Test-OwnershipCase 'accepts-empty-registry-survey' 'absent'
  Test-OwnershipCase 'accepts-created-view-only' 'owned-survey'
  Test-OwnershipCase 'accepts-shared-hkcu-view-with-same-contents' 'owned-survey' $false {
    param($f)
    $f.snapshots[4].exists = $true
    $f.snapshots[4].valueCount = 1
    $f.snapshots[4].valueNames = @('')
    $f.snapshots[4].defaultKind = 'String'
    $f.snapshots[4].defaultValue = $f.receipt.manifestPath
  }
  Test-OwnershipCase 'accepts-receipt-and-manifest-bound-by-digest' 'receipt'
  Test-OwnershipCase 'accepts-firefox-receipt-with-single-allowed-extension' 'receipt' $false {
    param($f)
    $f.browser = 'firefox'
    $f.receipt.browser = 'firefox'
    $f.receipt.extensionId = 'motrix-store-p0@motrix.invalid'
    $f.receipt.registryPath = 'Software\Mozilla\NativeMessagingHosts\app.motrix.bridge.store.p0'
    $f.manifestBytes = Get-JsonBytes (New-HostManifest 'firefox' $f.receipt.extensionId $f.alias)
    $f.receipt.manifestSha256 = Get-BytesHash $f.manifestBytes
    $f.receiptBytes = Get-JsonBytes $f.receipt
    $f.digest = Get-BytesHash $f.receiptBytes
  }
  Test-OwnershipCase 'accepts-actual-chromium-extension-id-and-os-alias' 'inputs'
  Test-OwnershipCase 'accepts-fixed-firefox-extension-id' 'inputs' $false { param($f) $f.browser = 'firefox'; $f.id = 'motrix-store-p0@motrix.invalid' }
  Test-OwnershipCase 'accepts-new-key-disposition' 'disposition'

  Test-OwnershipCase 'rejects-existing-empty-hkcu-key' 'absent' $true { param($f) $f.snapshots[0].exists = $true }
  Test-OwnershipCase 'rejects-machine-64-bit-chromium-fallback' 'absent' $true { param($f) $f.snapshots[15].exists = $true }
  Test-OwnershipCase 'rejects-foreign-fallback-during-owned-inspection' 'owned-survey' $true { param($f) $f.snapshots[2].exists = $true }
  Test-OwnershipCase 'rejects-missing-created-view' 'owned-survey' $true { param($f) $f.snapshots[0].exists = $false }
  Test-OwnershipCase 'rejects-survey-with-omitted-view' 'absent' $true { param($f) $f.snapshots = $f.snapshots[0..11] }
  Test-OwnershipCase 'rejects-opened-existing-key-disposition' 'disposition' $true { param($f) $f.disposition = 2 }
  Test-OwnershipCase 'rejects-reg-expand-sz-default' 'key' $true { param($f) $f.ownedKey.defaultKind = 'ExpandString' }
  Test-OwnershipCase 'rejects-extra-named-value' 'key' $true { param($f) $f.ownedKey.valueCount = 2; $f.ownedKey.valueNames = @('', 'foreign') }
  Test-OwnershipCase 'rejects-foreign-subkey' 'key' $true { param($f) $f.ownedKey.subKeyCount = 1 }
  Test-OwnershipCase 'rejects-changed-default-path' 'key' $true { param($f) $f.ownedKey.defaultValue = 'C:\Foreign\manifest.json' }
  Test-OwnershipCase 'rejects-default-value-absent' 'key' $true { param($f) $f.ownedKey.valueNames = @('foreign') }
  Test-OwnershipCase 'rollback-after-receipt-write-failure-accepts-owned-default' 'rollback'
  Test-OwnershipCase 'rollback-after-default-write-failure-accepts-owned-empty-key' 'rollback' $false {
    param($f)
    $f.ownedKey.valueCount = 0; $f.ownedKey.valueNames = @(); $f.ownedKey.defaultKind = $null; $f.ownedKey.defaultValue = $null
  }
  Test-OwnershipCase 'rollback-refuses-preexisting-empty-key' 'rollback' $true {
    param($f)
    $f.createdNew = $false; $f.ownedKey.valueCount = 0; $f.ownedKey.valueNames = @()
  }
  Test-OwnershipCase 'rollback-refuses-foreign-added-value' 'rollback' $true { param($f) $f.ownedKey.valueCount = 2; $f.ownedKey.valueNames = @('', 'foreign') }
  Test-OwnershipCase 'rollback-refuses-foreign-added-subkey' 'rollback' $true { param($f) $f.ownedKey.subKeyCount = 1 }
  Test-OwnershipCase 'rollback-refuses-changed-default' 'rollback' $true { param($f) $f.ownedKey.defaultValue = 'C:\Foreign\manifest.json' }
  Test-OwnershipCase 'rejects-changed-receipt-bytes' 'receipt' $true { param($f) $f.receiptBytes[0] = 32 }
  Test-OwnershipCase 'rejects-changed-manifest-bytes' 'receipt' $true { param($f) $f.manifestBytes[0] = 32 }
  Test-OwnershipCase 'rejects-receipt-from-another-browser' 'receipt' $true { param($f) $f.browser = 'edge' }
  Test-OwnershipCase 'rejects-receipt-from-another-directory' 'receipt' $true { param($f) $f.directory = 'C:\Synthetic\another-run' }
  Test-OwnershipCase 'rejects-production-host-even-with-refreshed-receipt-hash' 'receipt' $true {
    param($f)
    $f.receipt.hostName = 'app.motrix.bridge'
    $f.receiptBytes = Get-JsonBytes $f.receipt
    $f.digest = Get-BytesHash $f.receiptBytes
  }
  Test-OwnershipCase 'rejects-machine-hive-even-with-refreshed-receipt-hash' 'receipt' $true {
    param($f)
    $f.receipt.registryHive = 'LocalMachine'
    $f.receiptBytes = Get-JsonBytes $f.receipt
    $f.digest = Get-BytesHash $f.receiptBytes
  }
  Test-OwnershipCase 'rejects-modified-manifest-even-with-both-refreshed-hashes' 'receipt' $true {
    param($f)
    $manifest = New-HostManifest 'chrome' ('b' * 32) $f.alias
    $f.manifestBytes = Get-JsonBytes $manifest
    $f.receipt.manifestSha256 = Get-BytesHash $f.manifestBytes
    $f.receiptBytes = Get-JsonBytes $f.receipt
    $f.digest = Get-BytesHash $f.receiptBytes
  }
  Test-OwnershipCase 'rejects-wildcard-extension-id' 'inputs' $true { param($f) $f.id = '*' }
  Test-OwnershipCase 'rejects-firefox-id-substitution' 'inputs' $true { param($f) $f.browser = 'firefox' }
  Test-OwnershipCase 'rejects-direct-exe-instead-of-os-alias' 'inputs' $true { param($f) $f.alias = 'C:\Synthetic\Package\diagnostics\motrix-store-p0-probe.exe' }
  Test-OwnershipCase 'rejects-out-of-range-package-version' 'inputs' $true { param($f) $f.receipt.packageVersion = '1.0.65536.0' }
} catch {
  $results.Add([ordered]@{ name = 'test-harness'; ok = $false; expected = 'completed'; observed = 'harness-error' })
}

$report = [ordered]@{
  schemaVersion = 1; scope = 'windows-store-browser-registration-contract-tests'
  ok = (@($results | Where-Object { -not $_.ok }).Count -eq 0)
  testCount = $results.Count; checks = $results.ToArray()
  registryAccessPerformed = $false; windowsRuntimeVerified = $false
}
if (-not [string]::IsNullOrWhiteSpace($ReportPath)) {
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Depth 6) + "`n")
    $stream = [IO.File]::Open($ReportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
  } catch {
    $results.Add([ordered]@{ name = 'report-write'; ok = $false; expected = 'created'; observed = 'write-failed' })
    $report.ok = $false; $report.testCount = $results.Count; $report.checks = $results.ToArray()
  }
}
$report | ConvertTo-Json -Depth 6
if ($report.ok) { exit 0 }
exit 1
