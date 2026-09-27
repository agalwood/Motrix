#Requires -Version 5.1
<#
.SYNOPSIS
Tests the runtime script's pure upgrade and alias evidence guards.
.DESCRIPTION
Loads named top-level guards and the listener-owner resolver through the PowerShell AST.
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
    Profile = [pscustomobject]@{
      schemaVersion = 1; scope = 'windows-native-host-profile-isolation'; sourceCommit = $commit
      packageVersion = '1.0.1.0'; nativeHostSha256 = ('e' * 64); ok = $true
      profileParityVerified = $false; mbp1Verified = $false; windows11AcceptanceVerified = $false; storeReady = $false
      checks = @([pscustomobject]@{ name = 'installed-content-before'; ok = $true }, [pscustomobject]@{ name = 'installed-content-after'; ok = $true })
      cases = [pscustomobject]@{
        ok = $true; cleanupVerified = $true; overrideConnectionRejected = $true
        profileParityVerified = $false; mbp1Verified = $false; mainApplicationLaunched = $false
        checks = @(
          foreach ($name in @('direct-control-before', 'alias-rejects-override', 'alias-without-endpoint', 'direct-control-after')) {
            [pscustomobject]@{ name = $name; ok = $true; fixtureRequests = $(if ($name.StartsWith('direct-')) { 2 } else { 0 }); exitCode = 0; stdoutBytes = 80; stderrBytes = 0 }
          }
        )
      }
    }
    Main = [pscustomobject]@{
      schemaVersion = 1; scope = 'windows-installed-main-bridge-startup'
      sourceCommit = $commit; packageVersion = '1.0.1.0'; nativeHostSha256 = ('e' * 64); mainExecutableSha256 = ('f' * 64); windowsPlatformSha256 = ('a' * 64)
      ok = $true; mainBridgeEndpointVerified = $true; coldLaunchVerified = $true; packageUriLaunchVerified = $true; mbp1Verified = $false; windows11AcceptanceVerified = $false; storeReady = $false
      installedMbp1TransportVerified = $true; installedBootstrapTicketProofVerified = $true; mbp1ClientCleanupVerified = $true; syntheticMbp1Client = $true
      coldLaunch = [pscustomobject]@{
        launchMethod = 'native-host'
        ok = $true; noLaunchBeforeVerified = $true; coldLaunchVerified = $true; processIdentityVerified = $true
        mainBridgeEndpointVerified = $true; noLaunchAfterVerified = $true; cleanupVerified = $true; mbp1Verified = $false
        mbp1TransportReconnectVerified = $true
        hostStdoutBytes = 94; noLaunchBeforeStdoutBytes = 34; noLaunchAfterStdoutBytes = 34
      }
      packageUriLaunch = [pscustomobject]@{
        launchMethod = 'package-uri'; ok = $true; noLaunchBeforeVerified = $true; coldLaunchVerified = $true; processIdentityVerified = $true
        mainBridgeEndpointVerified = $true; noLaunchAfterVerified = $true; cleanupVerified = $true; mbp1Verified = $false
        browserActivationVerified = $false; productionDiscoveryVerified = $false; mbp1TransportReconnectVerified = $true
        hostStdoutBytes = 94; noLaunchBeforeStdoutBytes = 34; noLaunchAfterStdoutBytes = 34
      }
      runtime = [pscustomobject]@{
        ok = $true; mainApplicationLaunched = $true; processIdentityVerified = $true; disclaimerUiVerified = $true
        mainUiVerified = $true; mainBridgeEndpointVerified = $true; cleanupVerified = $true
        mbp1TransportPairingVerified = $true; noCallerTicketlessVerified = $true; bootstrapTicketProofVerified = $true
        anonymousBootstrapStdoutBytes = 94; bootstrapStdoutBytes = 512
        mbp1Verified = $false; profilePathEqualityVerified = $false; hostStdoutBytes = 94
      }
    }
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
  [ValidateSet('pair', 'transition', 'alias', 'browser', 'browser-cleanup', 'profile', 'main', 'registry')][string]$Contract,
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
      'registry' { Assert-RegistryVisibilityReply $fixture.Registry }
      'main' { Assert-MainRuntimeReport $fixture.Main $fixture.SourceCommit $fixture.B.Version ('e' * 64) ('f' * 64) ('a' * 64) }
      'profile' { Assert-NativeHostProfileReport $fixture.Profile $fixture.SourceCommit $fixture.B.Version ('e' * 64) }
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
    foreach ($name in @('Assert-True', 'Assert-False', 'Assert-UpgradeInputs', 'Assert-UpgradeRetargeting', 'Assert-AliasReport', 'Assert-BrowserCleanupReport', 'Assert-BrowserReport', 'Assert-NativeHostProfileReport', 'Assert-MainRuntimeReport', 'Assert-RegistryVisibilityReply', 'Assert-RegistryParentCleanupState')) {
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

  $queryPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../scripts/query-windows-store-main-process.ps1'))
  $queryAst = [Management.Automation.Language.Parser]::ParseFile($queryPath, [ref]$tokens, [ref]$parseErrors)
  if (@($parseErrors).Count -ne 0) { throw 'Process query source has parser errors.' }
  $resolver = @($queryAst.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq 'Resolve-MainListenerOwner'
  })
  if ($resolver.Count -ne 1) { throw 'Expected one listener resolver definition.' }
  . ([scriptblock]::Create($resolver[0].Extent.Text))
  foreach ($case in @(
    @{ name = 'listener-owner-ordered-dictionary'; listeners = @([ordered]@{ pid = 42; address = '127.0.0.1' }); expected = 42 },
    @{ name = 'listener-owner-two-addresses-same-process'; listeners = @([ordered]@{ pid = 42; address = '127.0.0.1' }, [ordered]@{ pid = 42; address = '::1' }); expected = 42 },
    @{ name = 'listener-owner-custom-object'; listeners = @([pscustomobject]@{ pid = 42; address = '127.0.0.1' }); expected = 42 },
    @{ name = 'listener-owner-rejects-empty'; listeners = @(); expected = $null },
    @{ name = 'listener-owner-rejects-ambiguous'; listeners = @([ordered]@{ pid = 42 }, [ordered]@{ pid = 43 }); expected = $null },
    @{ name = 'listener-owner-rejects-zero'; listeners = @([ordered]@{ pid = 0 }); expected = $null },
    @{ name = 'listener-owner-rejects-string'; listeners = @([ordered]@{ pid = '42' }); expected = $null }
  )) {
    $observed = $null
    $rejected = $false
    try { $observed = Resolve-MainListenerOwner $case.listeners } catch { $rejected = $true }
    $ok = if ($null -eq $case.expected) { $rejected } else { -not $rejected -and $observed -eq $case.expected }
    $results.Add([ordered]@{ name = $case.name; ok = $ok })
  }

  foreach ($case in @(
    @{ name = 'parent-existing-kept'; before = $true; present = $true; subkeys = 0; values = 0; motrix = 0; reject = $false; restored = $true },
    @{ name = 'parent-empty-new-removed'; before = $false; present = $false; subkeys = 0; values = 0; motrix = 0; reject = $false; restored = $true },
    @{ name = 'parent-browser-subkeys-preserved'; before = $false; present = $true; subkeys = 2; values = 0; motrix = 0; reject = $false; restored = $false },
    @{ name = 'parent-browser-values-preserved'; before = $false; present = $true; subkeys = 0; values = 1; motrix = 0; reject = $false; restored = $false },
    @{ name = 'parent-existing-removal-rejected'; before = $true; present = $false; subkeys = 0; values = 0; motrix = 0; reject = $true; restored = $false },
    @{ name = 'parent-empty-new-leftover-rejected'; before = $false; present = $true; subkeys = 0; values = 0; motrix = 0; reject = $true; restored = $false },
    @{ name = 'parent-motrix-leftover-rejected'; before = $false; present = $true; subkeys = 1; values = 0; motrix = 1; reject = $true; restored = $false }
  )) {
    $before = @([pscustomobject]@{ view = 'Registry32'; path = 'Software\Google\Chrome\NativeMessagingHosts'; present = $case.before })
    $after = @([pscustomobject]@{ view = 'Registry32'; path = $before[0].path; present = $case.present; subKeyCount = $case.subkeys; valueCount = $case.values; motrixSubKeyCount = $case.motrix })
    $rejected = $false
    $result = $null
    try { $result = Assert-RegistryParentCleanupState $before $after } catch { $rejected = $true }
    $ok = $rejected -eq $case.reject
    if (-not $rejected) { $ok = $ok -and $result.inventoryRestored -eq $case.restored -and @($result.preservedNonemptyParents).Count -eq $(if ($case.restored) { 0 } else { 1 }) }
    $results.Add([ordered]@{ name = $case.name; ok = $ok })
  }

  Test-ContractCase 'main-accepts-bound-evidence' 'main'
  $previousExtensionDirectory = $env:MOTRIX_STORE_EXTENSION_DIRECTORY
  $previousExtensionCommit = $env:MOTRIX_STORE_EXTENSION_COMMIT
  $previousProtocolBrowser = $env:MOTRIX_STORE_PROTOCOL_BROWSER
  try {
    $env:MOTRIX_STORE_EXTENSION_DIRECTORY = 'synthetic-contract-only'
    $env:MOTRIX_STORE_EXTENSION_COMMIT = 'd' * 40
    Test-ContractCase 'extension-rejects-missing-runtime-evidence' 'main' $true
    foreach ($case in @('valid', 'wrong-source', 'missing-pair', 'missing-reconnect', 'missing-cleanup', 'string-boolean', 'windows11-overclaim', 'missing-edge', 'wrong-brand', 'wrong-scope', 'different-build', 'extra-browser', 'chrome-missing-pair', 'chrome-missing-cleanup', 'missing-protocol', 'chrome-protocol-overclaim', 'protocol-no-before', 'protocol-no-identity', 'protocol-no-endpoint', 'protocol-no-after', 'protocol-no-cleanup', 'protocol-string-boolean', 'valid-chrome', 'wrong-protocol-browser', 'consent-missing', 'consent-foreign', 'consent-string', 'invalid-browser-config', 'cancel-not-verified', 'cancel-not-clicked', 'cancel-accepted', 'cancel-foreign', 'cancel-string', 'cancel-launched', 'accept-cancelled', 'other-cancel-overclaim')) {
      Test-ContractCase "extension-$case" 'main' ($case -cnotin @('valid', 'valid-chrome')) {
        param($f)
        $env:MOTRIX_STORE_PROTOCOL_BROWSER = 'edge'
        $f.Main.runtime | Add-Member protocolBrowser 'edge'
        $records = [pscustomobject]@{}
        foreach ($brand in @('chrome', 'edge')) {
          $product = if ($brand -ceq 'chrome') { 'Google Chrome' } else { 'Microsoft Edge' }
          $proof = [pscustomobject]@{
            scope = "installed-appx-production-$brand-extension"; browserName = $brand; sourceCommit = ('d' * 40)
            browser = [pscustomobject]@{ product = $product }
            build = [pscustomobject]@{ sha256 = ('e' * 64) }; extensionId = ('a' * 32)
            ok = $true; firstPairVerified = $true; browserRestartReconnectVerified = $true; cleanupVerified = $true
            protocolCancellationVerified = $false; protocolActivationVerified = $false; firefoxVerified = $false; windows11AcceptanceVerified = $false
          }
          $records | Add-Member $brand $proof
        }
        $records.edge.protocolActivationVerified = $true
        $records.edge.protocolCancellationVerified = $true
        $records.edge | Add-Member protocolCancellation ([pscustomobject]@{ confirmed = $false; cancelled = $true; processIdentityVerified = $true })
        $records.edge | Add-Member protocolConfirmation ([pscustomobject]@{ confirmed = $true; cancelled = $false; processIdentityVerified = $true })
        $records.edge | Add-Member protocolLaunch ([pscustomobject]@{
          noLaunchBeforeVerified = $true; noLaunchAfterCancelVerified = $true; processIdentityVerified = $true; mainBridgeEndpointVerified = $true
          noLaunchAfterVerified = $true; cleanupVerified = $true
        })
        $proof = $records.edge
        switch ($case) {
          'valid-chrome' {
            $env:MOTRIX_STORE_PROTOCOL_BROWSER = 'chrome'
            $f.Main.runtime.protocolBrowser = 'chrome'
            $records.chrome.protocolActivationVerified = $true
            $records.chrome.protocolCancellationVerified = $true
            $records.edge.protocolCancellationVerified = $false
            $records.chrome | Add-Member protocolCancellation $proof.protocolCancellation
            $records.edge.PSObject.Properties.Remove('protocolCancellation')
            $records.edge.protocolActivationVerified = $false
            $records.chrome | Add-Member protocolLaunch $proof.protocolLaunch
            $records.chrome | Add-Member protocolConfirmation $proof.protocolConfirmation
            $records.edge.PSObject.Properties.Remove('protocolLaunch')
            $records.edge.PSObject.Properties.Remove('protocolConfirmation')
          }
          'cancel-not-verified' { $proof.protocolCancellationVerified = $false }
          'cancel-not-clicked' { $proof.protocolCancellation.cancelled = $false }
          'cancel-accepted' { $proof.protocolCancellation.confirmed = $true }
          'cancel-foreign' { $proof.protocolCancellation.processIdentityVerified = $false }
          'cancel-string' { $proof.protocolCancellation.cancelled = 'true' }
          'cancel-launched' { $proof.protocolLaunch.noLaunchAfterCancelVerified = $false }
          'accept-cancelled' { $proof.protocolConfirmation.cancelled = $true }
          'other-cancel-overclaim' { $records.chrome.protocolCancellationVerified = $true }
          'wrong-protocol-browser' { $f.Main.runtime.protocolBrowser = 'chrome' }
          'consent-missing' { $proof.protocolConfirmation.confirmed = $false }
          'consent-foreign' { $proof.protocolConfirmation.processIdentityVerified = $false }
          'consent-string' { $proof.protocolConfirmation.confirmed = 'true' }
          'invalid-browser-config' { $env:MOTRIX_STORE_PROTOCOL_BROWSER = 'firefox' }
          'missing-protocol' { $proof.protocolActivationVerified = $false }
          'chrome-protocol-overclaim' { $records.chrome.protocolActivationVerified = $true }
          'protocol-no-before' { $proof.protocolLaunch.noLaunchBeforeVerified = $false }
          'protocol-no-identity' { $proof.protocolLaunch.processIdentityVerified = $false }
          'protocol-no-endpoint' { $proof.protocolLaunch.mainBridgeEndpointVerified = $false }
          'protocol-no-after' { $proof.protocolLaunch.noLaunchAfterVerified = $false }
          'protocol-no-cleanup' { $proof.protocolLaunch.cleanupVerified = $false }
          'protocol-string-boolean' { $proof.protocolLaunch.cleanupVerified = 'true' }
          'wrong-source' { $proof.sourceCommit = 'f' * 40 }
          'missing-pair' { $proof.firstPairVerified = $false }
          'missing-reconnect' { $proof.browserRestartReconnectVerified = $false }
          'missing-cleanup' { $proof.cleanupVerified = $false }
          'string-boolean' { $proof.ok = 'true' }
          'windows11-overclaim' { $proof.windows11AcceptanceVerified = $true }
          'missing-edge' { $records.PSObject.Properties.Remove('edge') }
          'wrong-brand' { $proof.browser.product = 'Google Chrome' }
          'wrong-scope' { $proof.scope = 'installed-appx-production-chrome-extension' }
          'different-build' { $proof.build.sha256 = 'f' * 64 }
          'extra-browser' { $records | Add-Member firefox $proof }
          'chrome-missing-pair' { $records.chrome.firstPairVerified = $false }
          'chrome-missing-cleanup' { $records.chrome.cleanupVerified = $false }
        }
        $f.Main.runtime | Add-Member extensionRuntimes $records
      }
    }
  } finally {
    $env:MOTRIX_STORE_EXTENSION_DIRECTORY = $previousExtensionDirectory
    $env:MOTRIX_STORE_EXTENSION_COMMIT = $previousExtensionCommit
    $env:MOTRIX_STORE_PROTOCOL_BROWSER = $previousProtocolBrowser
  }
  Test-ContractCase 'main-rejects-missing-transport-proof' 'main' $true { param($f) $f.Main.installedMbp1TransportVerified = $false }
  Test-ContractCase 'main-rejects-missing-bootstrap-proof' 'main' $true { param($f) $f.Main.installedBootstrapTicketProofVerified = $false }
  Test-ContractCase 'main-rejects-callerless-ticket' 'main' $true { param($f) $f.Main.runtime.noCallerTicketlessVerified = $false }
  Test-ContractCase 'main-rejects-missing-ticket-pair' 'main' $true { param($f) $f.Main.runtime.bootstrapTicketProofVerified = $false }
  Test-ContractCase 'main-rejects-invalid-bootstrap-count' 'main' $true { param($f) $f.Main.runtime.bootstrapStdoutBytes = 0 }
  Test-ContractCase 'registry-accepts-six-matches' 'registry' $false { param($f) $f | Add-Member Registry ([pscustomobject]@{schemaVersion=1;packageIdentityVerified=$true;matches=@($true,$true,$true,$true,$true,$true)}) }
  foreach ($case in @('missing', 'false', 'string', 'extra', 'identity')) {
    Test-ContractCase ("registry-rejects-" + $case) 'registry' $true {
      param($f)
      $value = [pscustomobject]@{schemaVersion=1;packageIdentityVerified=$true;matches=@($true,$true,$true,$true,$true,$true)}
      switch ($case) {
        'missing' { $value.matches = @($true) }
        'false' { $value.matches[3] = $false }
        'string' { $value.matches[2] = 'true' }
        'extra' { $value | Add-Member unexpected 'withheld' }
        'identity' { $value.packageIdentityVerified = $false }
      }
      $f | Add-Member Registry $value
    }
  }
  Test-ContractCase 'main-rejects-client-cleanup-failure' 'main' $true { param($f) $f.Main.mbp1ClientCleanupVerified = $false }
  Test-ContractCase 'main-rejects-unlabelled-synthetic-client' 'main' $true { param($f) $f.Main.syntheticMbp1Client = $false }
  Test-ContractCase 'main-rejects-pairing-failure' 'main' $true { param($f) $f.Main.runtime.mbp1TransportPairingVerified = $false }
  Test-ContractCase 'main-rejects-reconnect-failure' 'main' $true { param($f) $f.Main.coldLaunch.mbp1TransportReconnectVerified = $false }
  Test-ContractCase 'main-rejects-other-source' 'main' $true { param($f) $f.Main.sourceCommit = 'b' * 40 }
  Test-ContractCase 'main-rejects-other-package' 'main' $true { param($f) $f.Main.packageVersion = '1.0.0.0' }
  Test-ContractCase 'main-rejects-other-native-host' 'main' $true { param($f) $f.Main.nativeHostSha256 = 'b' * 64 }
  Test-ContractCase 'main-rejects-other-main-executable' 'main' $true { param($f) $f.Main.mainExecutableSha256 = 'b' * 64 }
  Test-ContractCase 'main-rejects-no-identity' 'main' $true { param($f) $f.Main.runtime.processIdentityVerified = $false }
  Test-ContractCase 'main-rejects-no-consent-ui' 'main' $true { param($f) $f.Main.runtime.disclaimerUiVerified = $false }
  Test-ContractCase 'main-rejects-no-real-endpoint' 'main' $true { param($f) $f.Main.runtime.mainBridgeEndpointVerified = $false }
  Test-ContractCase 'main-rejects-no-cleanup' 'main' $true { param($f) $f.Main.runtime.cleanupVerified = $false }
  Test-ContractCase 'main-rejects-mbp1-overclaim' 'main' $true { param($f) $f.Main.runtime.mbp1Verified = $true }
  Test-ContractCase 'main-rejects-path-equality-overclaim' 'main' $true { param($f) $f.Main.runtime.profilePathEqualityVerified = $true }
  Test-ContractCase 'main-rejects-windows11-overclaim' 'main' $true { param($f) $f.Main.windows11AcceptanceVerified = $true }
  Test-ContractCase 'main-rejects-extra-output' 'main' $true { param($f) $f.Main.runtime.hostStdoutBytes = 4101 }
  Test-ContractCase 'main-rejects-other-platform-helper' 'main' $true { param($f) $f.Main.windowsPlatformSha256 = 'b' * 64 }
  Test-ContractCase 'main-rejects-no-cold-launch' 'main' $true { param($f) $f.Main.coldLaunchVerified = $false }
  Test-ContractCase 'main-rejects-no-package-uri-launch' 'main' $true { param($f) $f.Main.packageUriLaunchVerified = $false }
  Test-ContractCase 'main-rejects-package-uri-native-fallback' 'main' $true { param($f) $f.Main.packageUriLaunch.launchMethod = 'native-host' }
  Test-ContractCase 'main-rejects-package-uri-no-identity' 'main' $true { param($f) $f.Main.packageUriLaunch.processIdentityVerified = $false }
  Test-ContractCase 'main-rejects-package-uri-no-reconnect' 'main' $true { param($f) $f.Main.packageUriLaunch.mbp1TransportReconnectVerified = $false }
  Test-ContractCase 'main-rejects-package-uri-no-cleanup' 'main' $true { param($f) $f.Main.packageUriLaunch.cleanupVerified = $false }
  Test-ContractCase 'main-rejects-package-uri-browser-overclaim' 'main' $true { param($f) $f.Main.packageUriLaunch.browserActivationVerified = $true }
  Test-ContractCase 'main-rejects-package-uri-discovery-overclaim' 'main' $true { param($f) $f.Main.packageUriLaunch.productionDiscoveryVerified = $true }
  Test-ContractCase 'main-rejects-package-uri-extra-output' 'main' $true { param($f) $f.Main.packageUriLaunch.hostStdoutBytes = 4101 }
  Test-ContractCase 'main-rejects-no-cold-identity' 'main' $true { param($f) $f.Main.coldLaunch.processIdentityVerified = $false }
  Test-ContractCase 'main-rejects-launch-without-intent-before' 'main' $true { param($f) $f.Main.coldLaunch.noLaunchBeforeVerified = $false }
  Test-ContractCase 'main-rejects-launch-without-intent-after' 'main' $true { param($f) $f.Main.coldLaunch.noLaunchAfterVerified = $false }
  Test-ContractCase 'main-rejects-cold-cleanup-failure' 'main' $true { param($f) $f.Main.coldLaunch.cleanupVerified = $false }
  Test-ContractCase 'main-rejects-cold-mbp1-overclaim' 'main' $true { param($f) $f.Main.coldLaunch.mbp1Verified = $true }
  Test-ContractCase 'profile-accepts-complete-evidence'  'profile'
  Test-ContractCase 'profile-rejects-other-source' 'profile' $true { param($f) $f.Profile.sourceCommit = 'f' * 40 }
  Test-ContractCase 'profile-rejects-other-binary' 'profile' $true { param($f) $f.Profile.nativeHostSha256 = 'f' * 64 }
  Test-ContractCase 'profile-rejects-other-version' 'profile' $true { param($f) $f.Profile.packageVersion = '1.0.0.0' }
  Test-ContractCase 'profile-rejects-missing-control' 'profile' $true { param($f) $f.Profile.cases.checks = @($f.Profile.cases.checks | Select-Object -First 3) }
  Test-ContractCase 'profile-rejects-unproven-cleanup' 'profile' $true { param($f) $f.Profile.cases.cleanupVerified = $false }
  Test-ContractCase 'profile-rejects-alias-traffic' 'profile' $true { param($f) $f.Profile.cases.checks[1].fixtureRequests = 2 }
  Test-ContractCase 'profile-rejects-missing-positive-traffic' 'profile' $true { param($f) $f.Profile.cases.checks[0].fixtureRequests = 0 }
  Test-ContractCase 'profile-rejects-profile-parity-claim' 'profile' $true { param($f) $f.Profile.profileParityVerified = $true }
  Test-ContractCase 'profile-rejects-main-launch' 'profile' $true { param($f) $f.Profile.cases.mainApplicationLaunched = $true }
  Test-ContractCase 'profile-rejects-stderr' 'profile' $true { param($f) $f.Profile.cases.checks[1].stderrBytes = 1 }
  Test-ContractCase 'profile-rejects-partial-content-checks' 'profile' $true { param($f) $f.Profile.checks = @($f.Profile.checks | Select-Object -First 1) }
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
