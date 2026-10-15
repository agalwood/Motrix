#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PreparedDirectory,
    [Parameter(Mandatory = $true)][string]$SdkBinDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$CaseDirectory,
    [switch]$TestNativeAlias,
    [switch]$TestNativeBrowsers,
    [switch]$TestMainRuntime,
    [string]$FirefoxRelayBuildDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-store-test-output.ps1')

# This experiment owns a disposable hosted machine and a fixed test identity.
# It never exports a private key or captures profiles, endpoints or pairing data.
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
    throw 'Startup identity installation requires manual dispatch on a disposable GitHub-hosted runner.'
}
if (-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The disposable test runner must allow installation of its owned public test certificate.'
}
function Read-Json([string]$File) {
    $item = Get-Item -LiteralPath $File -Force
    if ($item -isnot [IO.FileInfo] -or $item.Length -gt 1048576 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid JSON input.' }
    return [IO.File]::ReadAllText($File) | ConvertFrom-Json
}
function Get-Hash([string]$File) { return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
function Invoke-Tool([string]$File, [string[]]$Arguments, [int]$TimeoutMs = 120000) {
    if ($TimeoutMs -lt 1 -or $TimeoutMs -gt 900000) { throw 'Invalid bounded tool deadline.' }
    $settings = [Diagnostics.ProcessStartInfo]::new($File)
    $settings.UseShellExecute = $false
    $settings.CreateNoWindow = $true
    $settings.RedirectStandardOutput = $true
    $settings.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $settings.ArgumentList.Add($argument) }
    $child = [Diagnostics.Process]::new()
    $child.StartInfo = $settings
    try {
        $report.toolPhase = 'process-start'
        if (-not $child.Start()) { throw 'Test tool did not start.' }
        $report.toolPhase = 'output-pumps'
        $stdout = $child.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
        $stderr = $child.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
        $report.toolPhase = 'wait-exit'
        if (-not $child.WaitForExit($TimeoutMs)) { $child.Kill($true); $child.WaitForExit(); throw 'Test tool exceeded its deadline.' }
        $report.toolProcessExitCode = $child.ExitCode
        $report.toolPhase = 'drain-output'
        $null = $stdout.GetAwaiter().GetResult()
        $null = $stderr.GetAwaiter().GetResult()
        $report.toolPhase = 'exit-result'
        if ($child.ExitCode -ne 0) { throw 'Test tool returned a failure.' }
        $report.toolPhase = $null
    } finally { $child.Dispose() }
}

$prepared = [IO.Path]::GetFullPath($PreparedDirectory).TrimEnd('\', '/')
$output = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\', '/')
$temporary = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\', '/')
if (-not $output.StartsWith($temporary + '\', [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $output)) { throw 'Use a fresh output under this runner temporary directory.' }
$metadata = Read-Json (Join-Path $prepared 'release-metadata.json')
$sdk = Read-Json ($prepared + '.sdk-output/sdk-result.json')
$layout = Read-Json (Join-Path $prepared 'layout-report.json')
if ($metadata.profile -cne 'test' -or $metadata.identity.name -cne 'Motrix.Store.Test' -or $metadata.identity.publisher -cne 'CN=Motrix Store Test' -or $metadata.source.commit -cne $env:GITHUB_SHA -or $sdk.status -cne 'completed' -or -not $sdk.windowsSdkExecuted -or $sdk.signed -or $sdk.installed) { throw 'Only the completed unsigned package from this exact test checkout is accepted.' }
if (@(Get-AppxPackage -AllUsers -Name 'Motrix.Store.Test').Count -ne 0 -or @(Get-Process -Name Motrix -ErrorAction SilentlyContinue).Count -ne 0) { throw 'An existing test package or application prevents this experiment.' }
$expectedResource = Join-Path $prepared 'layout/app/resources/windows-package-identity.json'
$runtime = Read-Json $expectedResource
if ($runtime.profile -cne 'test' -or $runtime.sourceCommit -cne $metadata.source.commit -or $runtime.expected.version -cne $metadata.packageVersion) { throw 'The runtime expectation does not match this test input.' }
if ((Get-Hash $sdk.package.path) -cne $sdk.package.sha256) { throw 'The unsigned package digest differs from its SDK report.' }
$unsigned = Join-Path ($prepared + '.sdk-output') "Motrix-Store-Test-$($metadata.packageVersion)-x64.appx"
if ([IO.Path]::GetFullPath($sdk.package.path) -ine [IO.Path]::GetFullPath($unsigned)) { throw 'Only the expected SDK output package is accepted.' }
$knownFamily = $runtime.expected.familyName
$cases = [Collections.Generic.List[object]]::new()
$cases.Add(@{ Label = 'baseline'; Metadata = $metadata; Sdk = $sdk; Layout = $layout; Runtime = $runtime; ExpectedStartup = 'accepted' })
if (-not [string]::IsNullOrEmpty($CaseDirectory)) {
    $caseRoot = [IO.Path]::GetFullPath($CaseDirectory)
    $casePlan = Read-Json (Join-Path $caseRoot 'identity-cases.json')
    if ($casePlan.scope -cne 'fixed-test-identity-upgrade-cases' -or $casePlan.sourceCommit -cne $metadata.source.commit -or $casePlan.packageFamilyName -ine $knownFamily -or @($casePlan.cases).Count -ne 2) { throw 'Invalid fixed case plan.' }
    foreach ($index in @(0, 1)) {
        $row = $casePlan.cases[$index]
        $label = @('rejected-family', 'recovered')[$index]
        $version = @('1.0.1.0', '1.0.2.0')[$index]
        $outcome = @('identity_mismatch', 'accepted')[$index]
        if ($row.label -cne $label -or $row.packageVersion -cne $version -or $row.expectedStartup -cne $outcome -or $row.preparedDirectory -cne "$label/prepared" -or -not $row.unchangedApplicationPayloadVerified) { throw 'Unexpected identity case.' }
        $directory = Join-Path $caseRoot "$label/prepared"
        $nextMetadata = Read-Json (Join-Path $directory 'release-metadata.json')
        $nextSdk = Read-Json ($directory + '.sdk-output/sdk-result.json')
        $nextLayout = Read-Json (Join-Path $directory 'layout-report.json')
        $nextRuntime = Read-Json (Join-Path $directory 'layout/app/resources/windows-package-identity.json')
        if ($nextMetadata.profile -cne 'test' -or $nextMetadata.identity.name -cne 'Motrix.Store.Test' -or $nextMetadata.identity.publisher -cne $metadata.identity.publisher -or $nextMetadata.source.commit -cne $metadata.source.commit -or $nextMetadata.packageVersion -cne $version -or $nextSdk.status -cne 'completed' -or $nextSdk.signed -or $nextSdk.installed -or (Get-Hash $nextSdk.package.path) -cne $nextSdk.package.sha256) { throw 'Case inputs differ from the fixed source.' }
        if ((Get-Hash (Join-Path $directory 'layout/app/resources/windows-package-identity.json')) -cne $row.runtimeIdentitySha256) { throw 'Case expectation digest differs.' }
        $cases.Add(@{ Label = $label; Metadata = $nextMetadata; Sdk = $nextSdk; Layout = $nextLayout; Runtime = $nextRuntime; ExpectedStartup = $outcome })
    }
}
if ($TestNativeAlias -and (-not [string]::IsNullOrEmpty($CaseDirectory) -or $metadata.testDiagnostics -cne 'native-messaging-probe-v1')) { throw 'Alias diagnostics require their explicit test mode and no upgrade cases.' }
if ($TestNativeBrowsers -and (-not $TestNativeAlias -or [string]::IsNullOrEmpty($FirefoxRelayBuildDirectory))) { throw 'Browser diagnostics require the native alias mode and its fixed relay build.' }
if ($TestMainRuntime -and (-not $TestNativeAlias -or [string]::IsNullOrEmpty($env:MOTRIX_STORE_EXTENSION_DIRECTORY) -or [string]::IsNullOrEmpty($env:MOTRIX_STORE_FIREFOX_EXTENSION_DIRECTORY) -or $env:MOTRIX_STORE_EXTENSION_COMMIT -cnotmatch '^[0-9a-f]{40}$')) { throw 'Main runtime checks require explicit alias mode and both verified extension builds.' }
New-Item -ItemType Directory -Path $output | Out-Null
$signed = Join-Path $output 'owned-test-signed.appx'
$publicCertificate = Join-Path $output 'owned-test-public.cer'
$signedCopies = [Collections.Generic.List[string]]::new()
$installedVersions = [Collections.Generic.List[string]]::new()
$caseResults = [Collections.Generic.List[object]]::new()
$certificate = $null
$thumbprint = $null
$keyName = $null
$keyProvider = $null
$trustAttempted = $false
$installAttempted = $false
$main = $null
$stdoutCapture = $null
$stderrCapture = $null
$stdoutPump = $null
$stderrPump = $null
$certificateAttempted = $false
$stage = 'create-certificate'
$failureStage = $null
$cleanupErrors = [Collections.Generic.List[string]]::new()
$report = [ordered]@{
    schemaVersion = 1; scope = 'windows-server-signed-test-startup-identity'; sourceCommit = $metadata.source.commit
    signatureKind = 'ephemeral-self-signed-test'; privateKeyExported = $false; windows11Verified = $false
    storeFlightVerified = $false; browserVerified = $false; firstRunConsentBypassed = $false
    mainPreflightVerified = $false; parentAndChildPackageIdentityMatched = $false; cleanupVerified = $false; ok = $false
    mainProcessStarted = $false; startupReportFound = $false; stdoutLinesIgnored = 0
    startupFailureCode = $null; naturalMainExitCode = $null; failureType = $null
    nativeQueriesVerified = $false; actualStartupMutationVerified = $false; defaultAppsUiVerified = $false
    nativeAliasVerified = $false
    sourceBuiltExtensionRuntimeVerified = $false
    nativeQueryFailureCode = $null
    nativeQueryPhase = $null; nativeProcessExitCode = $null; nativeErrorHresult = $null; nativeWin32ErrorCode = $null
    toolPhase = $null; toolProcessExitCode = $null
}
try {
    $certificateAttempted = $true
    $certificate = New-SelfSignedCertificate -Type Custom -Subject 'CN=Motrix Store Test' -CertStoreLocation 'Cert:\CurrentUser\My' `
        -Provider 'Microsoft Software Key Storage Provider' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
        -KeyExportPolicy NonExportable -KeyUsage DigitalSignature -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}') `
        -NotBefore (Get-Date).AddMinutes(-5) -NotAfter (Get-Date).AddDays(1)
    $thumbprint = $certificate.Thumbprint
    if ($thumbprint -cnotmatch '^[0-9A-F]{40}$' -or $certificate.Subject -cne $metadata.identity.publisher -or -not $certificate.HasPrivateKey) { throw 'Unexpected test certificate.' }
    $rsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
    try { $keyName = $rsa.Key.KeyName; $keyProvider = $rsa.Key.Provider; if ($rsa.Key.ExportPolicy -ne [Security.Cryptography.CngExportPolicies]::None) { throw 'Test key must be non-exportable.' } } finally { $rsa.Dispose() }
    $null = Export-Certificate -Cert $certificate -FilePath $publicCertificate -Type CERT -NoClobber
    if (Test-Path "Cert:\LocalMachine\TrustedPeople\$thumbprint") { throw 'Generated public trust already exists.' }
    $trustAttempted = $true
    $null = Import-Certificate -FilePath $publicCertificate -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople'
    foreach ($case in $cases) {
        $metadata = $case.Metadata; $sdk = $case.Sdk; $layout = $case.Layout; $runtime = $case.Runtime
        $signed = Join-Path $output ("owned-test-" + $case.Label + '.appx')
        $signedCopies.Add($signed)
        $report.mainPreflightVerified = $false; $report.parentAndChildPackageIdentityMatched = $false
        $report.mainProcessStarted = $false; $report.startupReportFound = $false; $report.stdoutLinesIgnored = 0
        $report.startupFailureCode = $null; $report.naturalMainExitCode = $null
        $nativeObservation = $null
        $stage = 'sign-test-copy'
        [IO.File]::Copy($sdk.package.path, $signed, $false)
        if ((Get-Hash $signed) -cne $sdk.package.sha256) { throw 'Test copy differs before signing.' }
        $signTool = Join-Path $SdkBinDirectory 'signtool.exe'
        Invoke-Tool $signTool @('sign', '/sha1', $thumbprint, '/s', 'My', '/fd', 'SHA256', $signed)
        Invoke-Tool $signTool @('verify', '/pa', $signed)
        $report.signedTestCopyVerified = $true
        $report.signedPackageSha256 = Get-Hash $signed
        $stage = 'install-test-copy'
        $installAttempted = $true
        $installedVersions.Add($metadata.packageVersion)
        Add-AppxPackage -Path $signed
        $packages = @(Get-AppxPackage -Name 'Motrix.Store.Test')
        if ($packages.Count -ne 1) { throw 'Expected one owned package.' }
        $package = $packages[0]
        if ($package.Publisher -cne $metadata.identity.publisher -or $package.PackageFamilyName -ine $knownFamily -or $package.Version.ToString() -cne $metadata.packageVersion) { throw 'Installed identity differs.' }
        foreach ($name in @('app/Motrix.exe', 'app/resources/app.asar', 'app/resources/bin/motrix-windows-platform.exe', 'app/resources/windows-package-identity.json')) {
            $relative = $name.Substring(4)
            $row = @($layout.payload | Where-Object { $_.path -ceq $relative })
            if ($row.Count -ne 1 -or (Get-Hash (Join-Path $package.InstallLocation $name)) -cne $row[0].sha256) { throw 'Installed payload digest differs.' }
        }
        $stage = 'main-process-start'
        $settings = [Diagnostics.ProcessStartInfo]::new((Join-Path $package.InstallLocation 'app/Motrix.exe'))
        $settings.UseShellExecute = $false; $settings.RedirectStandardOutput = $true; $settings.RedirectStandardError = $true
        $main = [Diagnostics.Process]::new(); $main.StartInfo = $settings
        if (-not $main.Start()) { throw 'Owned main executable did not start.' }
        $report.mainProcessStarted = $true
        $stdoutCapture = [MotrixStoreTest.BoundedOutput]::new(65536)
        $stderrCapture = [MotrixStoreTest.BoundedOutput]::new(16384)
        $stdoutPump = $stdoutCapture.PumpAsync($main.StandardOutput.BaseStream)
        $stderrPump = $stderrCapture.PumpAsync($main.StandardError.BaseStream)
        $stage = 'main-report-wait'
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $startup = $null; $nativeProbe = $null
        $consumed = 0
        while ($timer.ElapsedMilliseconds -lt 30000 -and ($null -eq $startup -or ($case.ExpectedStartup -ceq 'accepted' -and $null -eq $nativeProbe))) {
            if ($main.HasExited) { $null = $stdoutPump.Wait(1000); $null = $stderrPump.Wait(1000) }
            $lines = $stdoutCapture.Snapshot().Split("`n")
            while ($consumed -lt $lines.Length - 1) {
                $value = $lines[$consumed++].TrimEnd("`r")
                if ($value.Length -gt 32768 -or $consumed -gt 32) { $stage = 'main-output-limit'; throw 'Startup output exceeded its bounds.' }
                try {
                    $candidate = $value | ConvertFrom-Json
                    if ($candidate.scope -ceq 'windows-package-startup-identity') { $startup = $candidate; continue }
                    if ($candidate.scope -ceq 'windows-package-readonly-integration') { $nativeProbe = $candidate; continue }
                } catch { }
                $report.stdoutLinesIgnored++
            }
            if ($null -ne $startup -and ($case.ExpectedStartup -ceq 'identity_mismatch' -or $null -ne $nativeProbe)) { break }
            if ($stdoutCapture.Truncated) { $stage = 'main-output-limit'; throw 'Startup output exceeded its bounds.' }
            if ($main.HasExited) {
                if ($case.ExpectedStartup -ceq 'identity_mismatch') {
                    $code = [MotrixStoreTest.BoundedOutput]::StartupFailureCode($stderrCapture.Snapshot())
                    if ($main.ExitCode -eq 1 -and $code -ceq 'identity_mismatch') { break }
                }
                $stage = 'main-exited-before-report'; throw 'Owned main exited without the expected result.'
            }
            Start-Sleep -Milliseconds 100
        }
        if ($case.ExpectedStartup -ceq 'identity_mismatch') {
            $stage = 'main-rejection-result'
            if ($null -ne $startup -or -not $main.HasExited -or $main.ExitCode -ne 1 -or [MotrixStoreTest.BoundedOutput]::StartupFailureCode($stderrCapture.Snapshot()) -cne 'identity_mismatch') { throw 'The misbound installed package was not rejected.' }
        } else {
        if ($null -eq $startup) { $stage = 'main-report-timeout'; throw 'Startup identity report was not produced.' }
        $report.startupReportFound = $true
        $stage = 'main-report-source'
        if ($startup.version -ne 1 -or $startup.scope -cne 'windows-package-startup-identity' -or $startup.sourceCommit -cne $metadata.source.commit -or $startup.productVersion -cne $metadata.productVersion) { throw 'Startup identity report differs.' }
        $stage = 'main-report-identity'
        if ($startup.identity.publisher -cne $package.Publisher -or $startup.identity.familyName -ine $package.PackageFamilyName -or $startup.identity.fullName -ine $package.PackageFullName -or $startup.identity.version -cne $package.Version.ToString() -or $startup.identity.architecture -cne 'x64') { throw 'Parent and child package identities differ.' }
        $report.mainPreflightVerified = $true; $report.parentAndChildPackageIdentityMatched = $true
        }
        $naturalExit = if ($main.HasExited) { $main.ExitCode } else { $null }
        if (-not $main.HasExited) { $main.Kill($true); $main.WaitForExit() }
        if (-not $stdoutPump.Wait(5000) -or -not $stderrPump.Wait(5000)) { throw 'Owned process output did not close.' }
        $failureCode = [MotrixStoreTest.BoundedOutput]::StartupFailureCode($stderrCapture.Snapshot())
        $caseResults.Add([ordered]@{ label = $case.Label; packageVersion = $metadata.packageVersion; expectedStartup = $case.ExpectedStartup; installedIdentityVerified = $true; installedPayloadHashesVerified = $true; mainPreflightVerified = $report.mainPreflightVerified; startupReportFound = $report.startupReportFound; failureCode = $failureCode; naturalExitCode = $naturalExit; stdoutLinesIgnored = $report.stdoutLinesIgnored; ownedProcessStopped = $true; nativeObservation = $null })
        $main.Dispose(); $main = $null; $stdoutPump = $null; $stderrPump = $null
        if ($case.ExpectedStartup -ceq 'accepted') {
            $stage = 'main-child-native-probe'
            if ($null -eq $nativeProbe -or $nativeProbe.sourceCommit -cne $metadata.source.commit -or $nativeProbe.version -ne 1 -or $nativeProbe.scope -cne 'windows-package-readonly-integration') { throw 'Main child observation is missing or has a different source.' }
            if ($nativeProbe.ok -isnot [bool] -or -not $nativeProbe.ok) {
                $report.nativeQueryPhase = 'main-child-probe'
                if ($nativeProbe.PSObject.Properties.Name -ccontains 'code') { $report.nativeQueryFailureCode = Get-StoreNativeQueryFailureCode ([pscustomobject]@{version=1;ok=$false;code=$nativeProbe.code}) }
                throw 'Main child native observation failed.'
            }
            $value = $nativeProbe.observation
            if ($value.readOnlyVerified -ne $true -or $value.startupStateBefore -cne $value.startupStateAfter -or $value.mainAppAumid -ine ($knownFamily + '!Motrix')) { throw 'Main child observation differs from the installed package.' }
            $startupReply = [pscustomobject]@{version=1;ok=$true;packageIdentityPresent=$true;taskId='MotrixStartup';state=$value.startupStateBefore}
            Assert-StoreNativeQueryReply $startupReply 'startup_query' ($knownFamily + '!Motrix')
            $associationReply = [pscustomobject]@{version=1;ok=$true;packageIdentityPresent=$true;mainAppAumid=$value.mainAppAumid;torrent=$value.torrent;magnet=$value.magnet}
            Assert-StoreNativeQueryReply $associationReply 'associations_query' ($knownFamily + '!Motrix')
            $nativeObservation = [ordered]@{ packageVersion = $metadata.packageVersion; startupStateBefore = $value.startupStateBefore; startupStateAfter = $value.startupStateAfter; mainAppAumid = $knownFamily + '!Motrix'; torrent = $value.torrent; magnet = $value.magnet; readOnlyVerified = $true }
        }
        $caseResults[$caseResults.Count - 1]['nativeObservation'] = $nativeObservation
    }
    $report.cases = @($caseResults.ToArray())
    $report.installedRejectionVerified = $cases.Count -eq 3 -and $caseResults[1].failureCode -ceq 'identity_mismatch'
    $report.recoveryUpgradeVerified = $cases.Count -eq 3 -and $caseResults[2].mainPreflightVerified
    $report.nativeQueriesVerified = @($caseResults | Where-Object { $_.expectedStartup -ceq 'accepted' -and $null -eq $_.nativeObservation }).Count -eq 0
    $report.nativeAliasVerified = $false
    $report.diagnosticBrowserNativeMessagingVerified = $false
    if ($TestNativeAlias) {
        $stage = 'installed-native-alias'
        $aliasReport = Join-Path $output 'native-alias-test.json'
        # Use the actual runtime path, not CommandInfo's source/module label.
        $node = (& node -p 'process.execPath').Trim()
        if ($LASTEXITCODE -ne 0 -or -not [IO.Path]::IsPathFullyQualified($node)) { throw 'Cannot resolve the active Node executable.' }
        $nodeFile = Get-Item -LiteralPath $node -Force -ErrorAction Stop
        if ($nodeFile -isnot [IO.FileInfo] -or $nodeFile.Name -ine 'node.exe' -or ($nodeFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'The active Node runtime must be a regular executable.' }
        $report.nodeRuntimeFileVerified = $true
        Invoke-Tool $node @((Join-Path $PSScriptRoot 'test-windows-store-native-messaging-alias.mjs'), '--prepared', $prepared, '--expected-package-version', $metadata.packageVersion, '--report', $aliasReport)
        $alias = Read-Json $aliasReport
        if ($alias.ok -ne $true -or $alias.sourceCommit -cne $metadata.source.commit -or $alias.aliasActivationVerified -ne $true -or $alias.packageIdentityVerified -ne $true -or $alias.nativeHostAliasVerified -ne $true -or $alias.nativeHostProfileParityVerified -ne $false -or $alias.browserNativeMessagingVerified -ne $false -or $alias.mbp1Verified -ne $false) { throw 'Alias observation did not pass its bounded contract.' }
        $report.nativeAliasVerified = $true
        if ($TestNativeBrowsers) {
            $stage = 'native-branded-browsers'
            $browserOutput = Join-Path $output 'browser'
            Invoke-Tool $node @((Join-Path $PSScriptRoot 'test-windows-store-native-messaging-browser.mjs'), '--prepared', $prepared, '--expected-package-version', $metadata.packageVersion, '--output-directory', $browserOutput, '--firefox-relay-build-dir', $FirefoxRelayBuildDirectory) 420000
            $browser = Read-Json (Join-Path $browserOutput 'browser-report.json')
            if ($browser.ok -ne $true -or $browser.sourceCommit -cne $metadata.source.commit -or $browser.cleanupVerified -ne $true -or $browser.browserNativeMessagingVerified -ne $true -or $browser.diagnosticProbeOnly -ne $true -or $browser.mbp1Verified -ne $false -or $browser.windows11AcceptanceVerified -ne $false) { throw 'Browser diagnostics did not pass their bounded contract.' }
            $report.diagnosticBrowserNativeMessagingVerified = $true
        }
        if ($TestMainRuntime) {
            $stage = 'native-main-runtime'
            $mainRuntimeReport = Join-Path $output 'main-runtime-report.json'
            Invoke-Tool $node @((Join-Path $PSScriptRoot 'test-windows-store-main-runtime.mjs'), '--prepared', $prepared, '--expected-package-version', $metadata.packageVersion, '--report', $mainRuntimeReport) 900000
            $observed = Read-Json $mainRuntimeReport
            if ($observed.ok -ne $true -or $observed.scope -cne 'windows-installed-main-bridge-startup' -or $observed.sourceCommit -cne $metadata.source.commit -or $observed.mainBridgeEndpointVerified -ne $true -or $observed.installedMbp1TransportVerified -ne $true -or $observed.installedBootstrapTicketProofVerified -ne $true -or $observed.mbp1ClientCleanupVerified -ne $true -or $observed.coldLaunchVerified -ne $true -or $observed.packageUriLaunchVerified -ne $true -or $observed.windows11AcceptanceVerified -ne $false -or $observed.storeReady -ne $false) { throw 'Installed main runtime evidence is incomplete.' }
            foreach ($brand in @('chrome', 'edge')) {
                $extension = $observed.runtime.extensionRuntimes.$brand
                if ($extension.ok -ne $true -or $extension.sourceCommit -cne $env:MOTRIX_STORE_EXTENSION_COMMIT -or $extension.firstPairVerified -ne $true -or $extension.browserRestartReconnectVerified -ne $true -or $extension.serviceWorkerRestartReconnectVerified -ne $true -or $extension.cleanupVerified -ne $true -or $extension.windows11AcceptanceVerified -ne $false) { throw 'Source-built Chromium extension evidence is incomplete.' }
            }
            $firefox = $observed.runtime.firefoxExtensionRuntime
            if ($firefox.ok -ne $true -or $firefox.sourceCommit -cne $env:MOTRIX_STORE_EXTENSION_COMMIT -or $firefox.firstPairVerified -ne $true -or $firefox.popupReopenReconnectVerified -ne $true -or $firefox.temporaryInstallationVerified -ne $true -or $firefox.runtimeIdentityVerified -ne $true -or $firefox.cleanupVerified -ne $true -or $firefox.signedPersistentInstallationVerified -ne $false) { throw 'Source-built Firefox temporary-extension evidence is incomplete.' }
            $protocol = $observed.runtime.extensionRuntimes.edge
            if ($observed.runtime.protocolBrowser -cne 'edge' -or $protocol.protocolActivationVerified -ne $true -or $protocol.protocolCancellationVerified -ne $true -or $protocol.protocolConfirmation.confirmed -ne $true -or $protocol.protocolCancellation.cancelled -ne $true) { throw 'Normal browser protocol consent evidence is incomplete.' }
            $report.sourceBuiltExtensionRuntimeVerified = $true
        }
    }

} catch {
    $failureStage = $stage; $report.failureType = $_.Exception.GetType().Name
    if ($stage.StartsWith('native-', [StringComparison]::Ordinal) -or $stage -ceq 'installed-native-alias') {
        $exception = $_.Exception
        for ($depth = 0; $depth -lt 4 -and $null -ne $exception; $depth++) {
            $report.nativeErrorHresult = '0x' + $exception.HResult.ToString('X8')
            if ($exception -is [ComponentModel.Win32Exception]) { $report.nativeWin32ErrorCode = $exception.NativeErrorCode }
            $exception = $exception.InnerException
        }
    }
}
finally {
    if ($null -ne $main) {
        try {
            if ($report.mainProcessStarted) {
                if ($main.HasExited) { $report.naturalMainExitCode = $main.ExitCode } else { $main.Kill($true); $main.WaitForExit() }
                if ($null -ne $stdoutPump) { if (-not $stdoutPump.Wait(5000)) { throw 'Owned stdout pump did not close.' } }
                if ($null -ne $stderrPump) { if (-not $stderrPump.Wait(5000)) { throw 'Owned stderr pump did not close.' } }
                if ($null -ne $stderrCapture) { $report.startupFailureCode = [MotrixStoreTest.BoundedOutput]::StartupFailureCode($stderrCapture.Snapshot()) }
            }
        } catch { $cleanupErrors.Add('owned-process') }
        $main.Dispose()
    }
    if ($installAttempted) {
        try {
            foreach ($package in @(Get-AppxPackage -Name 'Motrix.Store.Test')) {
                if ($package.Publisher -cne $metadata.identity.publisher -or -not $installedVersions.Contains($package.Version.ToString()) -or $package.PackageFamilyName -ine $knownFamily) { throw 'Unfamiliar package is never removed.' }
                Remove-AppxPackage -Package $package.PackageFullName
            }
            if (@(Get-AppxPackage -Name 'Motrix.Store.Test').Count -ne 0) { throw 'Owned package remains.' }
        } catch { $cleanupErrors.Add('owned-package') }
    }
    if ($trustAttempted) {
        try { $path = "Cert:\LocalMachine\TrustedPeople\$thumbprint"; if (Test-Path $path) { Remove-Item $path }; if (Test-Path $path) { throw 'Owned trust remains.' } } catch { $cleanupErrors.Add('owned-public-trust') }
    }
    if ($null -ne $certificate) {
        try {
            if ($thumbprint -cnotmatch '^[0-9A-F]{40}$') { throw 'Invalid owned key identity.' }
            $path = "Cert:\CurrentUser\My\$thumbprint"; if (Test-Path $path) { Remove-Item $path -DeleteKey }
            if (Test-Path $path) { throw 'Owned certificate remains.' }
            if ($null -ne $keyName -and [Security.Cryptography.CngKey]::Exists($keyName, $keyProvider)) { throw 'Owned private key remains.' }
        } catch { $cleanupErrors.Add('owned-private-key') }
        $certificate.Dispose()
    }
    elseif ($certificateAttempted) { $cleanupErrors.Add('certificate-creation-not-confirmed') }
    foreach ($file in @($signedCopies.ToArray()) + @($publicCertificate)) { try { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }; if (Test-Path -LiteralPath $file) { throw 'Transient file remains.' } } catch { $cleanupErrors.Add('transient-test-file') } }
    $report.cleanupVerified = $cleanupErrors.Count -eq 0
    $report.cleanupErrors = @($cleanupErrors.ToArray())
    $report.failureStage = $failureStage
    $report.completedCases = @($caseResults.ToArray())
    $report.ok = $null -eq $failureStage -and $report.cleanupVerified -and $report.mainPreflightVerified -and $report.nativeQueriesVerified
    [IO.File]::WriteAllText((Join-Path $output 'startup-identity-test.json'), ($report | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
}
if (-not $report.ok) { throw 'Signed test startup identity verification failed; inspect the redacted JSON report.' }
