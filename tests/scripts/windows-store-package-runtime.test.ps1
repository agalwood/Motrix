#Requires -Version 5.1
<#
.SYNOPSIS
Tests the runtime script's pure upgrade and alias evidence guards.
.DESCRIPTION
Loads only five named top-level function definitions through the PowerShell AST.
Never executes the runtime script's main flow, installs packages, uses PKI, or
launches an alias. Synthetic records do not prove Windows runtime behavior.
#>
[CmdletBinding()]
param([string]$ReportPath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$results = [Collections.Generic.List[object]]::new()

function Get-FixtureHash([string]$Text) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant()
  } finally { $algorithm.Dispose() }
}

function New-ContractFixture {
  $commit = 'a' * 40
  $family = 'Motrix.Store.Test_abcde12345678'
  $helperHash = Get-FixtureHash "$family!MotrixNativeHostP0"
  $packages = @(
    foreach ($version in @('1.0.0.0', '1.0.1.0')) {
      $fullName = "Motrix.Store.Test_${version}_x64__abcde12345678"
      [pscustomobject]@{
        Version = $version
        ProbeHash = ('b' * 64)
        Metadata = [pscustomobject]@{
          packageVersion = $version
          productVersion = '2.0.0'
          source = [pscustomobject]@{ commit = $commit }
          architecture = 'x64'
          testDiagnostics = 'native-messaging-probe-v1'
          previousPackageVersions = @('1.0.0.0')
          identity = [pscustomobject]@{
            name = 'Motrix.Store.Test'
            publisher = 'CN=Motrix Store Test'
            publisherDisplayName = 'Motrix Store Test'
          }
        }
        ObservedFullName = $fullName
        ObservedFamilyName = $family
        ObservedAliasPath = 'C:\Synthetic\WindowsApps\motrix-store-p0-native-host.exe'
        Record = [pscustomobject]@{
          installedPackage = [pscustomobject]@{
            fullNameSha256 = (Get-FixtureHash $fullName)
            helperApplicationUserModelIdSha256 = $helperHash
          }
        }
      }
    }
  )
  $checks = @(
    [pscustomobject]@{ name = 'installed-state-before'; ok = $true }
    [pscustomobject]@{ name = 'installed-content-before'; ok = $true }
    [pscustomobject]@{ name = 'alias-none'; ok = $true; exitCode = 0; frameCount = 1; stdoutBytes = 512; stderrBytes = 0; callerEvidence = 'none' }
    [pscustomobject]@{ name = 'alias-syntheticChromium'; ok = $true; exitCode = 0; frameCount = 1; stdoutBytes = 512; stderrBytes = 0; callerEvidence = 'simulated-argv-only' }
    [pscustomobject]@{ name = 'alias-syntheticFirefox'; ok = $true; exitCode = 0; frameCount = 1; stdoutBytes = 512; stderrBytes = 0; callerEvidence = 'simulated-argv-only' }
    [pscustomobject]@{ name = 'installed-state-after'; ok = $true }
    [pscustomobject]@{ name = 'installed-content-after'; ok = $true }
  )
  return [pscustomobject]@{
    A = $packages[0]
    B = $packages[1]
    Current = @([pscustomobject]@{ PackageFullName = $packages[1].ObservedFullName; Version = [Version]'1.0.1.0' })
    SourceCommit = $commit
    Alias = [pscustomobject]@{
      schemaVersion = 1
      scope = 'windows-native-messaging-installed-alias'
      sourceCommit = $commit
      packageVersion = '1.0.1.0'
      executableSha256 = $packages[1].ProbeHash
      identity = [pscustomobject]@{
        packageFullNameSha256 = $packages[1].Record.installedPackage.fullNameSha256
        applicationUserModelIdSha256 = $helperHash
      }
      ok = $true
      aliasActivationVerified = $true
      packageIdentityVerified = $true
      testCount = 3
      checks = $checks
      browserNativeMessagingVerified = $false
      mbp1Verified = $false
      windows11AcceptanceVerified = $false
    }
  }
}

function Test-ContractCase(
  [string]$Name,
  [ValidateSet('pair', 'transition', 'alias')][string]$Contract,
  [bool]$Reject = $false,
  [scriptblock]$Mutate = {}
) {
  $fixture = New-ContractFixture
  # Fixture construction and mutation errors are harness failures, never an
  # expected validator rejection that could make a broken test pass.
  $null = & $Mutate $fixture
  $rejected = $false
  try {
    switch ($Contract) {
      'pair' { Assert-UpgradeInputs $fixture.A $fixture.B }
      'transition' { Assert-UpgradeRetargeting $fixture.A $fixture.B $fixture.Current }
      'alias' { Assert-AliasReport $fixture.Alias $fixture.B $fixture.SourceCommit }
    }
  } catch { $rejected = $true }
  $results.Add([ordered]@{
    name = $Name
    ok = ($rejected -eq $Reject)
    expected = $(if ($Reject) { 'rejected' } else { 'accepted' })
    observed = $(if ($rejected) { 'rejected' } else { 'accepted' })
  })
}

try {
  $runtimePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../scripts/test-windows-store-package-runtime.ps1'))
  $tokens = $null
  $parseErrors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($runtimePath, [ref]$tokens, [ref]$parseErrors)
  if (@($parseErrors).Count -ne 0) { throw 'Runtime source has parser errors.' }
  $definitions = @(
    foreach ($name in @('Assert-True', 'Assert-False', 'Assert-UpgradeInputs', 'Assert-UpgradeRetargeting', 'Assert-AliasReport')) {
      $matching = @($ast.EndBlock.Statements | Where-Object {
        $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name
      })
      if ($matching.Count -ne 1) { throw 'Expected exactly one top-level guard definition.' }
      $matching[0].Extent.Text
    }
  )
  # Define only the AST-selected guards. Do not dot-source the runtime file:
  # its parameters, environment checks and main lifecycle must never execute.
  . ([scriptblock]::Create(($definitions -join "`n")))

  Test-ContractCase 'pair-accepts-fixed-a-to-b' 'pair'
  Test-ContractCase 'transition-accepts-unique-b' 'transition'
  Test-ContractCase 'alias-accepts-complete-bound-evidence' 'alias'

  Test-ContractCase 'pair-rejects-equal-version' 'pair' $true { param($f) $f.B.Version = $f.A.Version }
  Test-ContractCase 'pair-rejects-lower-version' 'pair' $true { param($f) $f.B.Version = '0.9.0.0' }
  Test-ContractCase 'pair-rejects-source-change' 'pair' $true { param($f) $f.B.Metadata.source.commit = 'c' * 40 }
  Test-ContractCase 'pair-rejects-product-change' 'pair' $true { param($f) $f.B.Metadata.productVersion = '2.0.1' }
  Test-ContractCase 'pair-rejects-publisher-change' 'pair' $true { param($f) $f.B.Metadata.identity.publisher = 'CN=Different Publisher' }
  Test-ContractCase 'pair-rejects-name-change' 'pair' $true { param($f) $f.B.Metadata.identity.name = 'Motrix.Other.Test' }
  Test-ContractCase 'pair-rejects-architecture-change' 'pair' $true { param($f) $f.B.Metadata.architecture = 'arm64' }
  Test-ContractCase 'pair-rejects-missing-a-history' 'pair' $true { param($f) $f.B.Metadata.previousPackageVersions = @() }
  Test-ContractCase 'pair-rejects-diagnostic-mode-change' 'pair' $true { param($f) $f.B.Metadata.testDiagnostics = $null }

  Test-ContractCase 'transition-rejects-a-still-current' 'transition' $true {
    param($f)
    $f.Current = @([pscustomobject]@{ PackageFullName = $f.A.ObservedFullName; Version = [Version]$f.A.Version })
  }
  Test-ContractCase 'transition-rejects-a-alongside-b' 'transition' $true {
    param($f)
    $f.Current += [pscustomobject]@{ PackageFullName = $f.A.ObservedFullName; Version = [Version]$f.A.Version }
  }
  Test-ContractCase 'transition-rejects-no-current-package' 'transition' $true { param($f) $f.Current = @() }
  Test-ContractCase 'transition-rejects-current-version-mismatch' 'transition' $true { param($f) $f.Current[0].Version = [Version]'1.0.0.0' }
  Test-ContractCase 'transition-rejects-family-change' 'transition' $true { param($f) $f.B.ObservedFamilyName = 'Motrix.Store.Test_0123456789abc' }
  Test-ContractCase 'transition-rejects-helper-aumid-change' 'transition' $true { param($f) $f.B.Record.installedPackage.helperApplicationUserModelIdSha256 = 'd' * 64 }
  Test-ContractCase 'transition-rejects-alias-path-change' 'transition' $true { param($f) $f.B.ObservedAliasPath = 'C:\Synthetic\Other\motrix-store-p0-native-host.exe' }

  Test-ContractCase 'alias-rejects-absent-report' 'alias' $true { param($f) $f.Alias = $null }
  Test-ContractCase 'alias-rejects-missing-case' 'alias' $true { param($f) $f.Alias.checks = @($f.Alias.checks | Where-Object { $_.name -cne 'alias-syntheticFirefox' }) }
  Test-ContractCase 'alias-rejects-failed-check-despite-summary' 'alias' $true { param($f) $f.Alias.checks[3].ok = $false }
  Test-ContractCase 'alias-rejects-a-evidence-for-b' 'alias' $true {
    param($f)
    $f.Alias.packageVersion = $f.A.Version
    $f.Alias.identity.packageFullNameSha256 = $f.A.Record.installedPackage.fullNameSha256
  }
  Test-ContractCase 'alias-rejects-other-helper-identity' 'alias' $true { param($f) $f.Alias.identity.applicationUserModelIdSha256 = 'e' * 64 }
  Test-ContractCase 'alias-rejects-other-build-source' 'alias' $true { param($f) $f.Alias.sourceCommit = 'f' * 40 }
  Test-ContractCase 'alias-rejects-other-executable' 'alias' $true { param($f) $f.Alias.executableSha256 = 'a' * 64 }
  Test-ContractCase 'alias-rejects-extra-frame' 'alias' $true { param($f) $f.Alias.checks[2].frameCount = 2 }
  Test-ContractCase 'alias-rejects-simulated-browser-overclaim' 'alias' $true { param($f) $f.Alias.browserNativeMessagingVerified = $true }
} catch {
  $results.Add([ordered]@{ name = 'test-harness'; ok = $false; expected = 'completed'; observed = 'harness-error' })
}

$report = [ordered]@{
  schemaVersion = 1
  scope = 'windows-store-package-runtime-contract-tests'
  ok = (@($results | Where-Object { -not $_.ok }).Count -eq 0)
  testCount = $results.Count
  checks = $results.ToArray()
  packageInstallationPerformed = $false
  pkiUsed = $false
  windowsRuntimeVerified = $false
}
if (-not [string]::IsNullOrWhiteSpace($ReportPath)) {
  try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Depth 8) + "`n")
    $stream = [IO.File]::Open($ReportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
  } catch {
    $results.Add([ordered]@{ name = 'report-write'; ok = $false; expected = 'created'; observed = 'write-failed' })
    $report.ok = $false
    $report.testCount = $results.Count
    $report.checks = $results.ToArray()
  }
}
$report | ConvertTo-Json -Depth 8
if (-not $report.ok) { exit 1 }
