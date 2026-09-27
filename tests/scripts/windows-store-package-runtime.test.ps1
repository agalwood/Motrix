#Requires -Version 5.1
<#
.SYNOPSIS
Tests the runtime script's pure upgrade and alias evidence guards.
.DESCRIPTION
Loads only seven named top-level function definitions through the PowerShell AST.
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

function New-BrowserFixture([object]$PackageInput, [string]$Commit) {
  $brands = @('chrome', 'edge', 'firefox')
  $products = @('Google Chrome', 'Microsoft Edge', 'Firefox')
  $browsers = @(
    for ($index = 0; $index -lt 3; $index++) {
      [pscustomobject]@{
        browser = $brands[$index]; product = $products[$index]; version = '123.0.1.2'; fileVersion = '123.0.1.2'
        executableSha256 = ('c' * 64); fixtureSha256 = ('d' * 64)
        extensionId = $(if ($index -eq 2) { 'motrix-store-p0@motrix.invalid' } else { 'a' * 32 })
        hostLaunchMode = $(if ($index -eq 2) { 'firefox-alias-relay' } else { 'execution-alias' })
        automationMode = $(if ($index -eq 2) { 'firefox-headless-bidi' } else { 'chromium-headed-cdp' })
        ok = $true; brandedBinaryVerified = $true; cleanupVerified = $true
        checks = @(
          [pscustomobject]@{ name = 'unregistered-before'; ok = $true; status = 'disconnected'; messageCount = 0; errorPresent = $true }
          [pscustomobject]@{ name = 'registered'; ok = $true; status = 'reply'; messageCount = 1; errorPresent = $false }
          [pscustomobject]@{ name = 'unregistered-after'; ok = $true; status = 'disconnected'; messageCount = 0; errorPresent = $true }
        )
      }
    }
  )
  $relay = [pscustomobject]@{ sourceSha256 = ('e' * 64); executableSha256 = ('f' * 64); buildReportSha256 = ('b' * 64); bytes = 512 }
  $PackageInput | Add-Member -NotePropertyName RelayEvidence -NotePropertyValue $relay
  return [pscustomobject]@{
    firefoxRelay = ($relay | ConvertTo-Json | ConvertFrom-Json)
    schemaVersion = 1; scope = 'windows-native-messaging-branded-browsers'
    sourceCommit = $Commit; packageVersion = $PackageInput.Version; executableSha256 = $PackageInput.ProbeHash
    identity = [pscustomobject]@{
      packageFullNameSha256 = $PackageInput.Record.installedPackage.fullNameSha256
      applicationUserModelIdSha256 = $PackageInput.Record.installedPackage.helperApplicationUserModelIdSha256
    }
    ok = $true; cleanupVerified = $true; diagnosticProbeOnly = $true; browserNativeMessagingVerified = $true
    testCount = 9; browsers = $browsers
    checks = @([pscustomobject]@{ name = 'installed-before'; ok = $true }, [pscustomobject]@{ name = 'installed-after'; ok = $true })
    mbp1Verified = $false; windows11AcceptanceVerified = $false; motrixMainRuntimeVerified = $false
    browserUpgradeVerified = $false; signatureVerified = $false; packageInstallationPerformed = $false
  }
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
    Browser = (New-BrowserFixture $packages[1] $commit)
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
  [ValidateSet('pair', 'transition', 'alias', 'browser', 'browser-cleanup')][string]$Contract,
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
      'browser' { Assert-BrowserReport $fixture.Browser $fixture.B $fixture.SourceCommit }
      'browser-cleanup' { Assert-BrowserCleanupReport $fixture.Browser $fixture.B $fixture.SourceCommit }
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
    foreach ($name in @('Assert-True', 'Assert-False', 'Assert-UpgradeInputs', 'Assert-UpgradeRetargeting', 'Assert-AliasReport', 'Assert-BrowserCleanupReport', 'Assert-BrowserReport')) {
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
  Test-ContractCase 'browser-accepts-three-brands-on-b' 'browser'
  Test-ContractCase 'browser-rejects-relay-digest-substitution' 'browser' $true { param($f) $f.Browser.firefoxRelay.executableSha256 = 'a' * 64 }
  Test-ContractCase 'browser-rejects-relay-source-substitution' 'browser' $true { param($f) $f.Browser.firefoxRelay.sourceSha256 = 'a' * 64 }
  Test-ContractCase 'browser-rejects-relay-report-substitution' 'browser' $true { param($f) $f.Browser.firefoxRelay.buildReportSha256 = 'a' * 64 }
  Test-ContractCase 'browser-rejects-relay-route-substitution' 'browser' $true { param($f) $f.Browser.browsers[2].hostLaunchMode = 'execution-alias' }
  Test-ContractCase 'browser-rejects-wrong-schema' 'browser' $true { param($f) $f.Browser.schemaVersion = 2 }
  Test-ContractCase 'browser-rejects-wrong-scope' 'browser' $true { param($f) $f.Browser.scope = 'simulated-browser' }
  Test-ContractCase 'browser-rejects-a-version' 'browser' $true { param($f) $f.Browser.packageVersion = '1.0.0.0' }
  Test-ContractCase 'browser-rejects-other-source' 'browser' $true { param($f) $f.Browser.sourceCommit = 'f' * 40 }
  Test-ContractCase 'browser-rejects-other-probe' 'browser' $true { param($f) $f.Browser.executableSha256 = 'e' * 64 }
  Test-ContractCase 'browser-rejects-a-package-fullname' 'browser' $true { param($f) $f.Browser.identity.packageFullNameSha256 = $f.A.Record.installedPackage.fullNameSha256 }
  Test-ContractCase 'browser-rejects-other-aumid' 'browser' $true { param($f) $f.Browser.identity.applicationUserModelIdSha256 = 'e' * 64 }
  Test-ContractCase 'browser-rejects-summary-failure' 'browser' $true { param($f) $f.Browser.ok = $false }
  Test-ContractCase 'browser-rejects-global-cleanup-failure' 'browser' $true { param($f) $f.Browser.cleanupVerified = $false }
  Test-ContractCase 'browser-rejects-missing-brand' 'browser' $true { param($f) $f.Browser.browsers = @($f.Browser.browsers[0], $f.Browser.browsers[1]) }
  Test-ContractCase 'browser-rejects-duplicate-brand' 'browser' $true { param($f) $f.Browser.browsers[2] = $f.Browser.browsers[1] }
  Test-ContractCase 'browser-rejects-unbranded-binary' 'browser' $true { param($f) $f.Browser.browsers[0].brandedBinaryVerified = $false }
  Test-ContractCase 'browser-rejects-product-substitution' 'browser' $true { param($f) $f.Browser.browsers[0].product = 'Chromium' }
  Test-ContractCase 'browser-rejects-invalid-version' 'browser' $true { param($f) $f.Browser.browsers[2].version = 'simulated' }
  Test-ContractCase 'browser-rejects-invalid-fixture-hash' 'browser' $true { param($f) $f.Browser.browsers[1].fixtureSha256 = 'bad' }
  Test-ContractCase 'browser-rejects-brand-cleanup-failure' 'browser' $true { param($f) $f.Browser.browsers[1].cleanupVerified = $false }
  Test-ContractCase 'browser-rejects-missing-case' 'browser' $true { param($f) $f.Browser.browsers[0].checks = @($f.Browser.browsers[0].checks[1]) }
  Test-ContractCase 'browser-rejects-failed-case' 'browser' $true { param($f) $f.Browser.browsers[0].checks[1].ok = $false }
  Test-ContractCase 'browser-rejects-reply-before-registration' 'browser' $true { param($f) $f.Browser.browsers[0].checks[0].messageCount = 1 }
  Test-ContractCase 'browser-rejects-no-registered-reply' 'browser' $true { param($f) $f.Browser.browsers[1].checks[1].messageCount = 0 }
  Test-ContractCase 'browser-accepts-reply-then-error-disconnect' 'browser' $false { param($f) $f.Browser.browsers[0].checks[1].errorPresent = $true }
  Test-ContractCase 'browser-rejects-nonboolean-disconnect-evidence' 'browser' $true { param($f) $f.Browser.browsers[2].checks[1].errorPresent = 'true' }
  Test-ContractCase 'browser-rejects-reply-after-unregistration' 'browser' $true { param($f) $f.Browser.browsers[2].checks[2].status = 'reply' }
  Test-ContractCase 'browser-rejects-wrong-test-count' 'browser' $true { param($f) $f.Browser.testCount = 8 }
  Test-ContractCase 'browser-rejects-failed-summary-check' 'browser' $true { param($f) $f.Browser.checks[0].ok = $false }
  Test-ContractCase 'browser-rejects-cross-upgrade-overclaim' 'browser' $true { param($f) $f.Browser.browserUpgradeVerified = $true }
  Test-ContractCase 'browser-rejects-main-runtime-overclaim' 'browser' $true { param($f) $f.Browser.motrixMainRuntimeVerified = $true }
  Test-ContractCase 'browser-rejects-mbp1-overclaim' 'browser' $true { param($f) $f.Browser.mbp1Verified = $true }

  Test-ContractCase 'browser-cleanup-accepts-complete-proof' 'browser-cleanup'
  Test-ContractCase 'browser-cleanup-independent-of-case-success' 'browser-cleanup' $false { param($f) $f.Browser.ok = $false; $f.Browser.browserNativeMessagingVerified = $false }
  Test-ContractCase 'browser-cleanup-rejects-missing-report-after-timeout' 'browser-cleanup' $true { param($f) $f.Browser = $null }
  Test-ContractCase 'browser-cleanup-rejects-unverified-cleanup' 'browser-cleanup' $true { param($f) $f.Browser.cleanupVerified = $false }
  Test-ContractCase 'browser-cleanup-rejects-a-evidence' 'browser-cleanup' $true { param($f) $f.Browser.packageVersion = '1.0.0.0' }
  Test-ContractCase 'browser-cleanup-rejects-brand-cleanup-failure' 'browser-cleanup' $true { param($f) $f.Browser.browsers[2].cleanupVerified = $false }

  Test-ContractCase 'browser-rejects-incomplete-summary-checks' 'browser' $true { param($f) $f.Browser.checks = @() }
  Test-ContractCase 'browser-rejects-wrong-summary-check' 'browser' $true { param($f) $f.Browser.checks[0].name = 'unknown' }
  Test-ContractCase 'browser-rejects-automation-mode-substitution' 'browser' $true { param($f) $f.Browser.browsers[0].automationMode = 'chromium-headless' }
  Test-ContractCase 'browser-rejects-extension-identity-substitution' 'browser' $true { param($f) $f.Browser.browsers[2].extensionId = 'other@example.invalid' }

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
exit 0
