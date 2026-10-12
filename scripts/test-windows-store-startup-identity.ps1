#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PreparedDirectory,
    [Parameter(Mandatory = $true)][string]$SdkBinDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
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
function Invoke-Tool([string]$File, [string[]]$Arguments) {
    $settings = [Diagnostics.ProcessStartInfo]::new($File)
    $settings.UseShellExecute = $false
    $settings.CreateNoWindow = $true
    $settings.RedirectStandardOutput = $true
    $settings.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $settings.ArgumentList.Add($argument) }
    $child = [Diagnostics.Process]::new()
    $child.StartInfo = $settings
    try {
        if (-not $child.Start()) { throw 'Test tool did not start.' }
        $stdout = $child.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
        $stderr = $child.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
        if (-not $child.WaitForExit(120000)) { $child.Kill($true); $child.WaitForExit(); throw 'Test tool exceeded its deadline.' }
        $null = $stdout.GetAwaiter().GetResult()
        $null = $stderr.GetAwaiter().GetResult()
        if ($child.ExitCode -ne 0) { throw 'Test tool returned a failure.' }
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
New-Item -ItemType Directory -Path $output | Out-Null
$signed = Join-Path $output 'owned-test-signed.appx'
$publicCertificate = Join-Path $output 'owned-test-public.cer'
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
    Add-AppxPackage -Path $signed
    $packages = @(Get-AppxPackage -Name 'Motrix.Store.Test')
    if ($packages.Count -ne 1) { throw 'Expected one owned package.' }
    $package = $packages[0]
    if ($package.Publisher -cne $metadata.identity.publisher -or $package.PackageFamilyName -ine $runtime.expected.familyName -or $package.Version.ToString() -cne $metadata.packageVersion) { throw 'Installed identity differs.' }
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
    $startup = $null
    $consumed = 0
    while ($timer.ElapsedMilliseconds -lt 30000 -and $null -eq $startup) {
        if ($main.HasExited) { $null = $stdoutPump.Wait(1000); $null = $stderrPump.Wait(1000) }
        $lines = $stdoutCapture.Snapshot().Split("`n")
        while ($consumed -lt $lines.Length - 1) {
            $value = $lines[$consumed++].TrimEnd("`r")
            if ($value.Length -gt 32768 -or $consumed -gt 32) { $stage = 'main-output-limit'; throw 'Startup output exceeded its bounds.' }
            try { $candidate = $value | ConvertFrom-Json; if ($candidate.scope -ceq 'windows-package-startup-identity') { $startup = $candidate; break } } catch { }
            $report.stdoutLinesIgnored++
        }
        if ($null -ne $startup) { break }
        if ($stdoutCapture.Truncated) { $stage = 'main-output-limit'; throw 'Startup output exceeded its bounds.' }
        if ($main.HasExited) { $stage = 'main-exited-before-report'; throw 'Owned main exited without an identity report.' }
        Start-Sleep -Milliseconds 100
    }
    if ($null -eq $startup) { $stage = 'main-report-timeout'; throw 'Startup identity report was not produced.' }
    $report.startupReportFound = $true
    $stage = 'main-report-source'
    if ($startup.version -ne 1 -or $startup.scope -cne 'windows-package-startup-identity' -or $startup.sourceCommit -cne $metadata.source.commit -or $startup.productVersion -cne $metadata.productVersion) { throw 'Startup identity report differs.' }
    $stage = 'main-report-identity'
    if ($startup.identity.publisher -cne $package.Publisher -or $startup.identity.familyName -ine $package.PackageFamilyName -or $startup.identity.fullName -ine $package.PackageFullName -or $startup.identity.version -cne $package.Version.ToString() -or $startup.identity.architecture -cne 'x64') { throw 'Parent and child package identities differ.' }
    $report.mainPreflightVerified = $true; $report.parentAndChildPackageIdentityMatched = $true
} catch { $failureStage = $stage; $report.failureType = $_.Exception.GetType().Name }
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
                if ($package.Publisher -cne $metadata.identity.publisher -or $package.Version.ToString() -cne $metadata.packageVersion -or $package.PackageFamilyName -ine $runtime.expected.familyName) { throw 'Unfamiliar package is never removed.' }
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
    foreach ($file in @($signed, $publicCertificate)) { try { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }; if (Test-Path -LiteralPath $file) { throw 'Transient file remains.' } } catch { $cleanupErrors.Add('transient-test-file') } }
    $report.cleanupVerified = $cleanupErrors.Count -eq 0
    $report.cleanupErrors = @($cleanupErrors.ToArray())
    $report.failureStage = $failureStage
    $report.ok = $null -eq $failureStage -and $report.cleanupVerified -and $report.mainPreflightVerified
    [IO.File]::WriteAllText((Join-Path $output 'startup-identity-test.json'), ($report | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
}
if (-not $report.ok) { throw 'Signed test startup identity verification failed; inspect the redacted JSON report.' }
