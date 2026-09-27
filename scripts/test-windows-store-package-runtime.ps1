#Requires -Version 5.1
<#
.SYNOPSIS
Tests a fixed diagnostic AppX upgrade on a disposable GitHub-hosted runner.
.DESCRIPTION
Requires 64-bit Windows PowerShell 5.1 and workflow_dispatch. Signs new A/B copies
with one ephemeral non-exportable test key, installs A then upgrades to B for
the current user, and runs only the diagnostic alias before and after upgrade.
Then checks diagnostic Native Messaging in three branded browsers against B.
No production certificates, PFX, timestamp, main-app launch, or policy changes
are involved; no MBP1 or browser continuity across the upgrade is tested.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PreparedDirectory,
  [Parameter(Mandatory = $true)][string]$UpgradePreparedDirectory,
  [Parameter(Mandatory = $true)][string]$SdkBinDirectory,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-AbsolutePath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or $Path -notmatch '^[A-Za-z]:[\\/]') {
    throw 'An absolute local Windows path is required.'
  }
  return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Assert-RegularPath([string]$Path, [bool]$Directory = $false) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($Directory -and $item -isnot [IO.DirectoryInfo]) -or
      (-not $Directory -and ($item -isnot [IO.FileInfo] -or $item.Length -eq 0))) {
    throw 'Expected a nonempty regular input file or directory.'
  }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Reparse points are not accepted for runtime-test inputs.'
  }
  $parent = if ($item -is [IO.FileInfo]) { $item.Directory } else { $item.Parent }
  for ($current = $parent; $null -ne $current; $current = $current.Parent) {
    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Reparse points are not accepted for runtime-test input parents.'
    }
  }
  return $item
}

function Get-Hash([string]$Path) {
  $null = Assert-RegularPath $Path
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TextHash([string]$Text) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant()
  } finally { $algorithm.Dispose() }
}

function Read-Json([string]$Path) {
  $file = Assert-RegularPath $Path
  if ($file.Length -gt 1048576) { throw 'JSON input exceeds the runtime-test limit.' }
  return ([IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json)
}

function Write-NewText([string]$Path, [string]$Text) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
}

function Protect-Log([string]$Text) {
  foreach ($value in @($env:USERPROFILE, $env:RUNNER_TEMP, $env:GITHUB_WORKSPACE)) {
    if (-not [string]::IsNullOrEmpty($value)) { $Text = $Text.Replace($value, '<runner-path>') }
  }
  return [regex]::Replace($Text, 'S-1-[0-9]+(?:-[0-9]+)+', '<sid>')
}

function Get-Failure([Management.Automation.ErrorRecord]$Record, [string]$Stage) {
  $message = Protect-Log $Record.Exception.Message
  if ($message.Length -gt 2048) { $message = $message.Substring(0, 2048) }
  return [ordered]@{
    stage = $Stage
    hresult = ('0x{0:X8}' -f $Record.Exception.HResult)
    message = $message
  }
}

function Assert-True([object]$Value, [string]$Description) {
  if ($Value -isnot [bool] -or -not $Value) { throw $Description }
}

function Assert-False([object]$Value, [string]$Description) {
  if ($Value -isnot [bool] -or $Value) { throw $Description }
}

function Add-BoundedProcessType {
  # .NET Framework has no ProcessStartInfo.ArgumentList. Encode each array
  # element using the Windows CRT quoting rules; never pass through a shell.
  # https://learn.microsoft.com/cpp/c-language/parsing-c-command-line-arguments
  Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
public static class MotrixCiRuntimeProcess {
    public sealed class Result {
        public int ExitCode = -1;
        public int StartHResult;
        public int StartNativeErrorCode;
        public bool TimedOut, OutputLimitExceeded, ReadFailed;
        public byte[] Stdout = new byte[0], Stderr = new byte[0];
    }
    private sealed class Capture {
        public readonly MemoryStream Bytes = new MemoryStream();
        public volatile bool Limit, Failed;
        public byte[] Snapshot() { lock (Bytes) { return Bytes.ToArray(); } }
        public async Task Read(Stream stream, int maximum) {
            try {
                byte[] buffer = new byte[4096];
                while (true) {
                    int count = await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                    if (count == 0) return;
                    lock (Bytes) {
                        int keep = Math.Min(count, maximum - (int)Bytes.Length);
                        Bytes.Write(buffer, 0, keep);
                        if (keep != count) { Limit = true; return; }
                    }
                }
            } catch { Failed = true; }
        }
    }
    private static string Quote(string value) {
        StringBuilder b = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') b.Append('\\', slashes * 2 + 1);
            else b.Append('\\', slashes);
            b.Append(c); slashes = 0;
        }
        b.Append('\\', slashes * 2); b.Append('"'); return b.ToString();
    }
    private static void KillOwnedTree(Process child) {
        try {
            if (child.HasExited) return;
            using (Process kill = new Process()) {
                kill.StartInfo = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "taskkill.exe"),
                    "/PID " + child.Id.ToString(System.Globalization.CultureInfo.InvariantCulture) + " /T /F");
                kill.StartInfo.UseShellExecute = false; kill.StartInfo.CreateNoWindow = true;
                kill.StartInfo.RedirectStandardOutput = true; kill.StartInfo.RedirectStandardError = true;
                kill.Start(); if (!kill.WaitForExit(2000)) kill.Kill();
            }
        } catch { }
        try { if (!child.HasExited) child.Kill(); } catch { }
    }
    public static Result Run(string program, string[] args, string directory, int timeoutMilliseconds) {
        Result result = new Result();
        Capture output = new Capture(), error = new Capture();
        using (Process child = new Process()) {
            child.StartInfo.FileName = program;
            child.StartInfo.Arguments = String.Join(" ", Array.ConvertAll(args, Quote));
            child.StartInfo.WorkingDirectory = directory;
            child.StartInfo.UseShellExecute = false; child.StartInfo.CreateNoWindow = true;
            child.StartInfo.RedirectStandardInput = true;
            child.StartInfo.RedirectStandardOutput = true; child.StartInfo.RedirectStandardError = true;
            try { if (!child.Start()) throw new InvalidOperationException(); }
            catch (Exception ex) {
                result.StartHResult = ex.HResult;
                var native = ex as System.ComponentModel.Win32Exception;
                if (native != null) result.StartNativeErrorCode = native.NativeErrorCode;
                return result;
            }
            try {
                child.StandardInput.Close();
                Task stdout = output.Read(child.StandardOutput.BaseStream, 65536);
                Task stderr = error.Read(child.StandardError.BaseStream, 65536);
                Stopwatch timer = Stopwatch.StartNew();
                while (!child.HasExited || !stdout.IsCompleted || !stderr.IsCompleted) {
                    if (output.Limit || error.Limit || output.Failed || error.Failed) break;
                    if (timer.ElapsedMilliseconds >= timeoutMilliseconds) { result.TimedOut = true; break; }
                    Thread.Sleep(25);
                }
                if (!child.HasExited) KillOwnedTree(child);
                if (!child.WaitForExit(2000)) result.TimedOut = true;
                if (!Task.WaitAll(new Task[] { stdout, stderr }, 2000)) result.ReadFailed = true;
                if (child.HasExited) result.ExitCode = child.ExitCode;
                result.OutputLimitExceeded = output.Limit || error.Limit;
                result.ReadFailed = result.ReadFailed || output.Failed || error.Failed;
                result.Stdout = output.Snapshot(); result.Stderr = error.Snapshot();
            } finally { KillOwnedTree(child); }
        }
        return result;
    }
}
'@
}

function Invoke-BoundedProgram([string]$Program, [string[]]$Arguments, [string]$Name, [ValidateSet(120000, 360000)][int]$TimeoutMilliseconds = 120000) {
  $result = [MotrixCiRuntimeProcess]::Run($Program, $Arguments, $OutputDirectory, $TimeoutMilliseconds)
  $stdout = [Text.Encoding]::UTF8.GetString($result.Stdout)
  $stderr = [Text.Encoding]::UTF8.GetString($result.Stderr)
  Write-NewText (Join-Path $OutputDirectory "$Name.stdout.log") (Protect-Log $stdout)
  Write-NewText (Join-Path $OutputDirectory "$Name.stderr.log") (Protect-Log $stderr)
  $report.commands.Add([ordered]@{
    name = $Name; exitCode = $result.ExitCode; timedOut = $result.TimedOut
    timeoutMilliseconds = $TimeoutMilliseconds
    outputLimitExceeded = $result.OutputLimitExceeded; readFailed = $result.ReadFailed
    startHResult = ('0x{0:X8}' -f $result.StartHResult)
    startNativeErrorCode = $result.StartNativeErrorCode
    stdoutBytes = $result.Stdout.Length; stderrBytes = $result.Stderr.Length
  })
  if ($result.ExitCode -ne 0 -or $result.StartHResult -ne 0 -or $result.TimedOut -or
      $result.OutputLimitExceeded -or $result.ReadFailed) {
    throw "Bounded command failed: $Name. See its bounded stdout/stderr logs."
  }
  return $stdout
}

function Test-AliasPresent {
  if (-not [IO.Directory]::Exists($aliasRoot)) { return $false }
  # Enumerating the parent also detects a dangling/zero-byte alias reparse point.
  return @([IO.Directory]::EnumerateFileSystemEntries($aliasRoot, 'motrix-store-p0-native-host.exe')).Count -ne 0
}

function Get-CurrentTestPackages {
  return @(Get-AppxPackage -Name 'Motrix.Store.Test' -ErrorAction Stop)
}

function Complete-Phase([string]$Name) {
  $report.phases.Add([ordered]@{ name = $Name; ok = $true })
}

function Read-VerifiedPackageInput([string]$Directory, [string]$Label, [string]$ExpectedVersion) {
  $null = Assert-RegularPath $Directory $true
  $metadata = Read-Json (Join-Path $Directory 'release-metadata.json')
  $source = Read-Json (Join-Path $Directory 'source-report.json')
  $layout = Read-Json (Join-Path $Directory 'layout-report.json')
  $sdkDirectory = "$Directory.sdk-output"
  $sdkPath = Join-Path $sdkDirectory 'sdk-result.json'
  $sdk = Read-Json $sdkPath
  if ($metadata.schemaVersion -ne 1 -or $source.schemaVersion -ne 1 -or $sdk.schemaVersion -ne 1 -or
      $source.scope -cne 'local-git-checkout-only' -or $sdk.scope -cne 'windows-test-sdk-smoke') {
    throw 'Unexpected metadata, source or SDK report schema.'
  }
  foreach ($value in @($metadata, $sdk)) {
    if ($value.profile -cne 'test' -or $value.testDiagnostics -cne 'native-messaging-probe-v1' -or
        $value.identity.name -cne 'Motrix.Store.Test' -or $value.identity.publisher -cne 'CN=Motrix Store Test' -or
        $value.identity.publisherDisplayName -cne 'Motrix Store Test') { throw 'Only the fixed diagnostic test identity is permitted.' }
  }
  Assert-True $source.ok 'Source report failed.'
  foreach ($check in $source.checks) { Assert-True $check.ok 'A source check failed.' }
  if ($metadata.architecture -cne 'x64' -or $metadata.source.commit -cne $env:GITHUB_SHA -or
      $source.observed.commit -cne $env:GITHUB_SHA -or $layout.sourceCommit -cne $env:GITHUB_SHA -or
      $layout.diagnostics.source.commit -cne $env:GITHUB_SHA -or
      $layout.diagnostics.mode -cne 'native-messaging-probe-v1') { throw 'Source or diagnostic layout does not match this run.' }
  $packageVersion = $metadata.packageVersion
  if ($packageVersion -cnotmatch '^[1-9][0-9]*\.[0-9]+\.[0-9]+\.[0-9]+$' -or
      $sdk.packageVersion -cne $packageVersion -or $sdk.productVersion -cne $metadata.productVersion -or
      $sdk.status -cne 'completed' -or $packageVersion -cne $ExpectedVersion) { throw 'Completed SDK result and metadata versions must agree.' }
  Assert-True $sdk.windowsSdkExecuted 'SDK execution is missing.'
  foreach ($name in @('signed', 'installed', 'windowsRuntimeVerified', 'storeReady', 'storeSubmissionReady')) {
    Assert-False $sdk.$name 'The input must remain the unsigned, uninstalled test SDK result.'
  }
  foreach ($phase in @('prepared', 'indexed', 'unpacked')) {
    Assert-True $sdk.verification.$phase.ok 'An SDK layout phase failed.'
    if ($sdk.verification.$phase.phase -cne $phase -or $sdk.verification.$phase.command.exitCode -ne 0) {
      throw 'An SDK layout phase is incomplete.'
    }
  }
  foreach ($command in @('makepriNew', 'makepriDump', 'makeappxPack', 'makeappxUnpack')) {
    if ($sdk.verification.$command.exitCode -ne 0) { throw 'An SDK command failed.' }
  }
  $unsignedPackage = Join-Path $sdkDirectory "Motrix-Store-Test-$packageVersion-x64.appx"
  if ((Get-AbsolutePath $sdk.package.path) -ine $unsignedPackage -or
      (Get-Hash $unsignedPackage) -cne $sdk.package.sha256 -or
      (Get-Item -LiteralPath $unsignedPackage).Length -ne $sdk.package.bytes) {
    throw 'Unsigned package does not match the completed SDK record.'
  }
  foreach ($entry in @(
    @{ role = 'unsignedPackage'; path = $unsignedPackage },
    @{ role = 'sdkResult'; path = $sdkPath },
    @{ role = 'metadata'; path = (Join-Path $Directory 'release-metadata.json') },
    @{ role = 'sourceReport'; path = (Join-Path $Directory 'source-report.json') },
    @{ role = 'layoutReport'; path = (Join-Path $Directory 'layout-report.json') }
  )) {
    $snapshots.Add(@{ role = "$Label-$($entry.role)"; path = $entry.path; sha256 = (Get-Hash $entry.path) })
  }
  if ($layout.packageVersion -cne $packageVersion -or $layout.productVersion -cne $metadata.productVersion) {
    throw 'Layout versions differ from metadata.'
  }
  $probeHash = $layout.diagnostics.executable.sha256
  if ($probeHash -cnotmatch '^[0-9a-f]{64}$') { throw 'Diagnostic executable hash is invalid.' }
  $verified = Invoke-BoundedProgram $node @((Join-Path $repository 'scripts\verify-windows-store-layout.mjs'), '--prepared', $Directory, '--phase', 'indexed') "verify-indexed-$Label"
  $verified = $verified | ConvertFrom-Json
  Assert-True $verified.ok 'Indexed verification failed.'
  if ($verified.phase -cne 'indexed' -or $verified.testDiagnostics -cne 'native-messaging-probe-v1' -or
      $verified.diagnostics.executable.sha256 -cne $probeHash) { throw 'Indexed diagnostic verification differs from the layout.' }

  $record = [ordered]@{
    packageVersion = $packageVersion; productVersion = $metadata.productVersion
    sourceCommit = $metadata.source.commit; unsignedPackageSha256 = $sdk.package.sha256
    sdkResultSha256 = Get-Hash $sdkPath; probeExecutableSha256 = $probeHash
    signedTestCopyVerified = $false; currentUserInstallationVerified = $false
    aliasActivationVerified = $false; packageIdentityVerified = $false
  }
  $report.packages[$Label] = $record
  return @{
    Label = $Label; Prepared = $Directory; Metadata = $metadata; Record = $record
    Version = $packageVersion; UnsignedPackage = $unsignedPackage; ProbeHash = $probeHash
    SignedPackage = (Join-Path $OutputDirectory "diagnostic-ci-signed-$Label.appx")
    InstallAttempted = $false; ObservedFullName = $null; ObservedFamilyName = $null
    ObservedAliasPath = $null
  }
}

function Assert-UpgradeInputs([object]$Before, [object]$After) {
  if ($Before.Version -cne '1.0.0.0' -or $After.Version -cne '1.0.1.0' -or
      [Version]$After.Version -le [Version]$Before.Version -or
      @($After.Metadata.previousPackageVersions) -cnotcontains $Before.Version -or
      $After.Metadata.productVersion -cne $Before.Metadata.productVersion -or
      $After.Metadata.source.commit -cne $Before.Metadata.source.commit -or
      $After.Metadata.architecture -cne $Before.Metadata.architecture -or
      $After.Metadata.testDiagnostics -cne $Before.Metadata.testDiagnostics) {
    throw 'B must advance A with matching source/product/architecture/mode and supplied A version history.'
  }
  foreach ($name in @('name', 'publisher', 'publisherDisplayName')) {
    if ($After.Metadata.identity.$name -cne $Before.Metadata.identity.$name) {
      throw 'Upgrade identities must be identical.'
    }
  }
}

function Assert-UpgradeRetargeting([object]$Before, [object]$After, [object[]]$Current) {
  if ($before.Version -cne '1.0.0.0' -or $after.Version -cne '1.0.1.0' -or
      $before.ObservedFamilyName -cne $after.ObservedFamilyName -or
      $before.Record.installedPackage.helperApplicationUserModelIdSha256 -cne $after.Record.installedPackage.helperApplicationUserModelIdSha256 -or
      $before.ObservedAliasPath -ine $after.ObservedAliasPath -or
      $before.ObservedFullName -ceq $after.ObservedFullName) {
    throw 'Upgrade must retain the family, helper AUMID and alias path while changing the full package name.'
  }
  if ($current.Count -ne 1 -or $current[0].PackageFullName -cne $after.ObservedFullName -or
      $current[0].Version.ToString() -cne $after.Version -or
      @($current | Where-Object { $_.PackageFullName -ceq $before.ObservedFullName }).Count -ne 0) {
    throw 'A remains registered or B is not the unique current-user test package.'
  }
}

function Assert-OwnedPackage([object]$Package, [object]$PackageInput) {
  $version = $PackageInput.Version
  if ($Package.Name -cne 'Motrix.Store.Test' -or $Package.Publisher -cne 'CN=Motrix Store Test' -or
      $Package.Version.ToString() -cne $version -or $Package.Architecture.ToString() -ine 'X64') {
    throw 'Installed package identity/version/architecture does not match this test.'
  }
  if ($Package.PublisherId -cnotmatch '^[0-9a-hjkmnp-tv-z]{13}$' -or
      $Package.PackageFullName -cne "Motrix.Store.Test_${version}_x64__$($Package.PublisherId)" -or
      $Package.PackageFamilyName -cne "Motrix.Store.Test_$($Package.PublisherId)") {
    throw 'Installed package has an unexpected full or family name.'
  }
  if ($null -ne $PackageInput.ObservedFullName -and $Package.PackageFullName -cne $PackageInput.ObservedFullName) {
    throw 'Cleanup candidate differs from the exact package observed after installation.'
  }
  $installedProbe = Join-Path $Package.InstallLocation 'diagnostics\motrix-store-p0-probe.exe'
  if ((Get-Hash $installedProbe) -cne $PackageInput.ProbeHash) { throw 'Installed probe hash does not match this test version.' }
}

function Get-InstalledAliasPath {
  if (-not [IO.Directory]::Exists($aliasRoot)) { throw 'Diagnostic alias directory is absent.' }
  $paths = @([IO.Directory]::EnumerateFileSystemEntries($aliasRoot, 'motrix-store-p0-native-host.exe'))
  if ($paths.Count -ne 1) { throw 'Expected exactly one diagnostic alias.' }
  # Compare the absolute alias path, not its version-dependent reparse target.
  return (Get-AbsolutePath $paths[0])
}

function Confirm-InstalledPackage([object]$PackageInput) {
  $packages = @(Get-CurrentTestPackages)
  if ($packages.Count -ne 1) { throw 'Expected exactly one current-user test package.' }
  $package = $packages[0]
  Assert-OwnedPackage $package $PackageInput
  $PackageInput.ObservedFullName = $package.PackageFullName
  $PackageInput.ObservedFamilyName = $package.PackageFamilyName
  $PackageInput.ObservedAliasPath = Get-InstalledAliasPath
  $PackageInput.Record.installedPackage = [ordered]@{
    fullNameSha256 = Get-TextHash $package.PackageFullName
    familyNameSha256 = Get-TextHash $package.PackageFamilyName
    helperApplicationUserModelIdSha256 = Get-TextHash "$($package.PackageFamilyName)!MotrixNativeHostP0"
    installedProbeSha256 = $PackageInput.ProbeHash
    absoluteAliasPathSha256 = Get-TextHash $PackageInput.ObservedAliasPath
  }
  $PackageInput.Record.currentUserInstallationVerified = $true
}

function Sign-TestCopy([object]$PackageInput) {
  $signed = $PackageInput.SignedPackage
  [IO.File]::Copy($PackageInput.UnsignedPackage, $signed, $false)
  if ((Get-Hash $signed) -cne $PackageInput.Record.unsignedPackageSha256) { throw 'Test copy differs before signing.' }
  $PackageInput.Record.copyBeforeSigningSha256 = Get-Hash $signed
  # /sha1 selects the certificate; /fd controls the package digest. No /sm,
  # automatic certificate selection, timestamp, or private-key export.
  # https://learn.microsoft.com/windows/win32/seccrypto/signtool
  $null = Invoke-BoundedProgram $signTool @('sign', '/sha1', $thumbprint, '/s', 'My', '/fd', 'SHA256', $signed) "sign-test-copy-$($PackageInput.Label)"
  $null = Invoke-BoundedProgram $signTool @('verify', '/pa', '/v', $signed) "verify-test-signature-$($PackageInput.Label)"
  $PackageInput.Record.signedPackageSha256 = Get-Hash $signed
  $PackageInput.Record.signedTestCopyVerified = $true
}

function Assert-AliasReport([object]$AliasReport, [object]$PackageInput, [string]$ExpectedSourceCommit) {
  $installed = $PackageInput.Record.installedPackage
  if ($aliasReport.schemaVersion -ne 1 -or $aliasReport.scope -cne 'windows-native-messaging-installed-alias' -or
      $aliasReport.sourceCommit -cne $ExpectedSourceCommit -or $aliasReport.packageVersion -cne $PackageInput.Version -or
      $aliasReport.executableSha256 -cne $PackageInput.ProbeHash -or
      $aliasReport.identity.packageFullNameSha256 -cne $installed.fullNameSha256 -or
      $aliasReport.identity.applicationUserModelIdSha256 -cne $installed.helperApplicationUserModelIdSha256) {
    throw 'Alias checker report does not match this diagnostic package version.'
  }
  foreach ($name in @('ok', 'aliasActivationVerified', 'packageIdentityVerified')) {
    Assert-True $aliasReport.$name 'Installed alias verification failed.'
  }
  $expectedChecks = @('installed-state-before', 'installed-content-before', 'alias-none', 'alias-syntheticChromium', 'alias-syntheticFirefox', 'installed-state-after', 'installed-content-after')
  if (@($aliasReport.checks).Count -ne $expectedChecks.Count) { throw 'Alias checker records are incomplete.' }
  for ($index = 0; $index -lt $expectedChecks.Count; $index++) {
    if ($aliasReport.checks[$index] -is [array] -or $aliasReport.checks[$index].name -cne $expectedChecks[$index]) {
      throw 'Alias checker records must have the fixed flat check names.'
    }
  }
  $aliasCases = @($aliasReport.checks | Where-Object { $null -ne $_.PSObject.Properties['exitCode'] })
  if ($aliasReport.testCount -ne 3 -or $aliasCases.Count -ne 3) { throw 'Alias checker did not complete all three cases.' }
  foreach ($check in $aliasReport.checks) {
    if ($check -is [array]) { throw 'Alias checks must be flat records.' }
    Assert-True $check.ok 'An installed alias check failed.'
  }
  foreach ($check in $aliasCases) {
    if ($check.exitCode -ne 0 -or $check.frameCount -ne 1 -or $check.stderrBytes -ne 0 -or
        $check.stdoutBytes -le 4 -or $check.stdoutBytes -gt 4100) {
      throw 'An installed alias case has unexpected exit, frame or output bounds.'
    }
  }
  if ($aliasCases[0].callerEvidence -cne 'none' -or
      $aliasCases[1].callerEvidence -cne 'simulated-argv-only' -or
      $aliasCases[2].callerEvidence -cne 'simulated-argv-only') { throw 'Unexpected alias caller evidence.' }
  foreach ($name in @('browserNativeMessagingVerified', 'mbp1Verified', 'windows11AcceptanceVerified')) {
    Assert-False $aliasReport.$name 'Alias report overstates the scope of this experiment.'
  }
}

function Test-InstalledAlias([object]$PackageInput) {
  $aliasReportPath = Join-Path $OutputDirectory "alias-report-$($PackageInput.Label).json"
  $null = Invoke-BoundedProgram $node @((Join-Path $repository 'scripts\test-windows-store-native-messaging-alias.mjs'), '--prepared', $PackageInput.Prepared, '--expected-package-version', $PackageInput.Version, '--report', $aliasReportPath) "test-installed-alias-$($PackageInput.Label)"
  $aliasReport = Read-Json $aliasReportPath
  Assert-AliasReport $aliasReport $PackageInput $env:GITHUB_SHA
  if ((Get-InstalledAliasPath) -ine $PackageInput.ObservedAliasPath) { throw 'Alias path changed during its checks.' }
  $PackageInput.Record.aliasReportSha256 = Get-Hash $aliasReportPath
  $PackageInput.Record.aliasActivationVerified = $true
  $PackageInput.Record.packageIdentityVerified = $true
}

function Assert-BrowserCleanupReport([object]$BrowserReport, [object]$PackageInput, [string]$ExpectedSourceCommit) {
  $installed = $PackageInput.Record.installedPackage
  if ($BrowserReport.schemaVersion -ne 1 -or $BrowserReport.scope -cne 'windows-native-messaging-branded-browsers' -or
      $BrowserReport.sourceCommit -cne $ExpectedSourceCommit -or $BrowserReport.packageVersion -cne $PackageInput.Version -or
      $BrowserReport.executableSha256 -cne $PackageInput.ProbeHash -or
      $BrowserReport.identity.packageFullNameSha256 -cne $installed.fullNameSha256 -or
      $BrowserReport.identity.applicationUserModelIdSha256 -cne $installed.helperApplicationUserModelIdSha256) {
    throw 'Browser report does not match the installed B diagnostic package.'
  }
  Assert-True $BrowserReport.cleanupVerified 'Browser runner did not verify cleanup.'
  foreach ($browser in $BrowserReport.browsers) {
    if ($browser -is [array]) { throw 'Browser cleanup records must be flat.' }
    Assert-True $browser.cleanupVerified 'A browser did not verify cleanup.'
  }
}

function Assert-BrowserReport([object]$BrowserReport, [object]$PackageInput, [string]$ExpectedSourceCommit) {
  Assert-BrowserCleanupReport $BrowserReport $PackageInput $ExpectedSourceCommit
  foreach ($name in @('ok', 'cleanupVerified', 'browserNativeMessagingVerified', 'diagnosticProbeOnly')) {
    Assert-True $BrowserReport.$name 'Branded browser verification is incomplete.'
  }
  foreach ($name in @('mbp1Verified', 'windows11AcceptanceVerified', 'motrixMainRuntimeVerified', 'browserUpgradeVerified', 'signatureVerified', 'packageInstallationPerformed')) {
    Assert-False $BrowserReport.$name 'Browser report overstates this diagnostic experiment.'
  }
  if ($BrowserReport.testCount -ne 9 -or @($BrowserReport.browsers).Count -ne 3) {
    throw 'Expected exactly three branded browsers and nine cases.'
  }
  $summaryNames = @('installed-before', 'installed-after')
  if (@($BrowserReport.checks).Count -ne 2) { throw 'Browser summary checks are incomplete.' }
  for ($index = 0; $index -lt 2; $index++) {
    $check = $BrowserReport.checks[$index]
    if ($check -is [array] -or $check.name -cne $summaryNames[$index]) { throw 'Unexpected browser summary check.' }
    Assert-True $check.ok 'A browser summary check failed.'
  }
  $brands = @('chrome', 'edge', 'firefox')
  $products = @('Google Chrome', 'Microsoft Edge', 'Firefox')
  $caseNames = @('unregistered-before', 'registered', 'unregistered-after')
  for ($index = 0; $index -lt 3; $index++) {
    $browser = $BrowserReport.browsers[$index]
    if ($browser -is [array] -or $browser.browser -cne $brands[$index] -or $browser.product -cne $products[$index] -or
        $browser.executableSha256 -cnotmatch '^[0-9a-f]{64}$' -or $browser.fixtureSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        [string]::IsNullOrWhiteSpace($browser.fileVersion) -or [string]::IsNullOrWhiteSpace($browser.extensionId) -or
        @($browser.checks).Count -ne 3) { throw 'Unexpected browser identity, digest or case set.' }
    $automationMode = if ($index -eq 2) { 'firefox-headless-bidi' } else { 'chromium-headed-cdp' }
    if ($browser.automationMode -cne $automationMode -or
        ($index -eq 2 -and $browser.extensionId -cne 'motrix-store-p0@motrix.invalid') -or
        ($index -lt 2 -and $browser.extensionId -cnotmatch '^[a-p]{32}$')) {
      throw 'Unexpected browser automation mode or extension identity.'
    }
    $versionPattern = if ($index -eq 2) { '^[0-9]+(?:\.[0-9]+){1,3}$' } else { '^[0-9]+(?:\.[0-9]+){3}$' }
    if ($browser.version -cnotmatch $versionPattern) { throw 'Unexpected branded browser version.' }
    foreach ($name in @('ok', 'brandedBinaryVerified', 'cleanupVerified')) {
      Assert-True $browser.$name 'A browser or its cleanup was not verified.'
    }
    for ($caseIndex = 0; $caseIndex -lt 3; $caseIndex++) {
      $case = $browser.checks[$caseIndex]
      if ($case -is [array] -or $case.name -cne $caseNames[$caseIndex]) { throw 'Unexpected browser case.' }
      Assert-True $case.ok 'A browser case failed.'
      if ($caseIndex -eq 1) {
        if ($case.status -cne 'reply' -or $case.messageCount -ne 1) { throw 'Registered browser case did not return one reply.' }
        # The one-response native host then exits. Chromium may report EOF as
        # runtime.lastError on disconnect after a valid reply; preserve the bool.
        if ($case.errorPresent -isnot [bool]) { throw 'Browser disconnect evidence must be boolean.' }
      } else {
        if ($case.status -cne 'disconnected' -or $case.messageCount -ne 0) { throw 'Unregistered browser case unexpectedly returned a reply.' }
        Assert-True $case.errorPresent 'Unregistered browser case did not report disconnection.'
      }
    }
  }
}

function Invoke-CleanupCheck([string]$Name, [scriptblock]$Action) {
  try {
    & $Action
    $report.cleanup.Add([ordered]@{ name = $Name; ok = $true })
  } catch {
    $report.cleanup.Add([ordered]@{ name = $Name; ok = $false; error = (Get-Failure $_ "cleanup:$Name") })
  }
}

# These environment checks restrict accidental use. They are not a replacement
# for workflow permissions or a security boundary against a hostile runner.
if ($PSVersionTable.PSEdition -cne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or
    $PSVersionTable.PSVersion.Minor -ne 1 -or -not [Environment]::Is64BitProcess -or
    [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'This test requires 64-bit Windows PowerShell 5.1 Desktop.'
}
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:GITHUB_SHA -cnotmatch '^[0-9a-f]{40}$') {
  throw 'This test requires an explicit GitHub-hosted workflow_dispatch run.'
}
$runnerTemp = Get-AbsolutePath $env:RUNNER_TEMP
$null = Assert-RegularPath $runnerTemp $true
$PreparedDirectory = Get-AbsolutePath $PreparedDirectory
$UpgradePreparedDirectory = Get-AbsolutePath $UpgradePreparedDirectory
$SdkBinDirectory = Get-AbsolutePath $SdkBinDirectory
$OutputDirectory = Get-AbsolutePath $OutputDirectory
if ($PreparedDirectory -ine (Join-Path $runnerTemp 'motrix-windows-store-diagnostic\prepared') -or
    $UpgradePreparedDirectory -ine (Join-Path $runnerTemp 'motrix-windows-store-diagnostic-upgrade\prepared') -or
    $OutputDirectory -ine (Join-Path $runnerTemp 'motrix-store-alias-runtime')) {
  throw 'Only the fixed diagnostic prepared and runtime output paths are permitted.'
}
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Runtime output must be a new directory.' }
$null = [IO.Directory]::CreateDirectory($OutputDirectory)
$report = [ordered]@{
  schemaVersion = 2; scope = 'github-hosted-server-test-package-runtime'; ok = $false
  sourceCommit = $env:GITHUB_SHA; stage = 'preflight'; context = $null
  packages = [ordered]@{}; phases = [Collections.Generic.List[object]]::new()
  commands = [Collections.Generic.List[object]]::new()
  cleanup = [Collections.Generic.List[object]]::new()
  signedTestCopyVerified = $false; currentUserInstallationVerified = $false
  aliasActivationVerified = $false; packageIdentityVerified = $false
  server2025InstalledProbeVerified = $false
  upgradeBeforeMainLaunchVerified = $false; sameAliasRetargetedVerified = $false
  windows11AcceptanceVerified = $false; standardUserVerified = $false
  browserNativeMessagingVerified = $false; browserUpgradeVerified = $false; mbp1Verified = $false
  motrixMainRuntimeVerified = $false; upgradeVerified = $false; wackVerified = $false
  productionSigned = $false; storeReady = $false; storeSubmissionReady = $false
  error = $null
}
$stage = 'preflight'
$snapshots = [Collections.Generic.List[object]]::new()
$packageInputs = @{}
$certificate = $null
$thumbprint = $null
$trustImportAttempted = $false
$publicCer = Join-Path $OutputDirectory 'diagnostic-ci-public.cer'
$aliasRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Microsoft\WindowsApps'
$testCompleted = $false
$browserTestCompleted = $false
$browserAttempted = $false
$browserReportPath = Join-Path (Join-Path $OutputDirectory 'browser') 'browser-report.json'
try {
  $null = Assert-RegularPath $PreparedDirectory $true
  $null = Assert-RegularPath $SdkBinDirectory $true
  $repository = Get-AbsolutePath (Join-Path $PSScriptRoot '..')
  if ($repository -ine (Get-AbsolutePath $env:GITHUB_WORKSPACE)) { throw 'Repository differs from GITHUB_WORKSPACE.' }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $elevated = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $elevated -or $identity.IsSystem) { throw 'An elevated non-SYSTEM runner user is required.' }
  $os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  $uac = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
  $services = @('AppXSvc', 'ClipSVC', 'StateRepository', 'mpssvc') | ForEach-Object {
    $service = Get-Service -Name $_ -ErrorAction SilentlyContinue
    [ordered]@{ name = $_; present = $null -ne $service; status = if ($null -ne $service) { $service.Status.ToString() } else { $null } }
  }
  $report.context = [ordered]@{
    productName = $os.ProductName; installationType = $os.InstallationType
    build = $os.CurrentBuildNumber; ubr = $os.UBR
    imageOS = $env:ImageOS; imageVersion = $env:ImageVersion
    elevated = $elevated; enableLUA = $uac.EnableLUA
    sidSha256 = Get-TextHash $identity.User.Value
    sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    userInteractive = [Environment]::UserInteractive; services = @($services)
  }
  if ($os.InstallationType -cne 'Server' -or $os.CurrentBuildNumber -cne '26100') {
    throw 'This experiment is limited to the current Server 2025 Desktop Experience image.'
  }
  Add-BoundedProcessType
  # PATH can contain several copies. Select one command before accessing Source;
  # coercing the whole Source array to a string produces an invalid executable.
  $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $git = (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $null = Assert-RegularPath (Get-AbsolutePath $node)
  $null = Assert-RegularPath (Get-AbsolutePath $git)
  $head = Invoke-BoundedProgram $git @('-C', $repository, 'rev-parse', 'HEAD') 'git-head'
  if ($head.Trim() -cne $env:GITHUB_SHA) { throw 'Checkout HEAD differs from GITHUB_SHA.' }
  Import-Module PKI -ErrorAction Stop
  Import-Module Appx -ErrorAction Stop
  Complete-Phase 'preflight'
  # Validate both complete SDK inputs before creating any certificate or package.
  $stage = 'validate-a'
  $packageInputs.a = Read-VerifiedPackageInput $PreparedDirectory 'a' '1.0.0.0'
  Complete-Phase $stage
  $stage = 'validate-b'
  $packageInputs.b = Read-VerifiedPackageInput $UpgradePreparedDirectory 'b' '1.0.1.0'
  Complete-Phase $stage
  $stage = 'validate-upgrade-inputs'
  Assert-UpgradeInputs $packageInputs.a $packageInputs.b
  Complete-Phase $stage
  $signTool = Join-Path $SdkBinDirectory 'signtool.exe'
  $report.signTool = [ordered]@{ sha256 = (Get-Hash $signTool); fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($signTool).FileVersion }
  $stage = 'check-clean-machine'
  if (@(Get-AppxPackage -AllUsers -Name 'Motrix.Store.Test' -ErrorAction Stop).Count -ne 0 -or (Test-AliasPresent)) {
    throw 'An existing test package or diagnostic alias prevents this experiment.'
  }
  Complete-Phase $stage
  $stage = 'create-test-certificate'
  # Publisher/EKU/end-entity requirements:
  # https://learn.microsoft.com/windows/msix/package/create-certificate-package-signing
  $certificate = New-SelfSignedCertificate -Type Custom -Subject 'CN=Motrix Store Test' `
    -FriendlyName "Motrix hosted CI test $env:GITHUB_RUN_ID" -CertStoreLocation 'Cert:\CurrentUser\My' `
    -Provider 'Microsoft Software Key Storage Provider' -KeyAlgorithm RSA -KeyLength 2048 `
    -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -KeyUsage DigitalSignature `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}') `
    -NotBefore (Get-Date).AddMinutes(-5) -NotAfter (Get-Date).AddDays(1)
  $thumbprint = $certificate.Thumbprint
  if ($thumbprint -cnotmatch '^[0-9A-F]{40}$' -or $certificate.Subject -cne 'CN=Motrix Store Test' -or -not $certificate.HasPrivateKey) {
    throw 'Generated test certificate has unexpected properties.'
  }
  if (Test-Path "Cert:\LocalMachine\TrustedPeople\$thumbprint") { throw 'Generated certificate already exists in the trust store.' }
  $null = Export-Certificate -Cert $certificate -Type CERT -FilePath $publicCer -NoClobber
  $trustImportAttempted = $true
  $null = Import-Certificate -FilePath $publicCer -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople'
  $trusted = Get-Item "Cert:\LocalMachine\TrustedPeople\$thumbprint"
  if ($trusted.Thumbprint -cne $thumbprint -or $trusted.HasPrivateKey) { throw 'Test trust must contain only the matching public certificate.' }
  $report.testCertificate = [ordered]@{ thumbprint = $thumbprint; subject = $certificate.Subject; privateKeyExported = $false; trustedPeopleOnly = $true }
  Complete-Phase $stage
  foreach ($label in @('a', 'b')) {
    $stage = "sign-$label"
    Sign-TestCopy $packageInputs[$label]
    Complete-Phase $stage
  }
  $report.signedTestCopyVerified = $true
  $stage = 'install-a'
  $packageInputs.a.InstallAttempted = $true
  Add-AppxPackage -Path $packageInputs.a.SignedPackage -ErrorAction Stop
  Confirm-InstalledPackage $packageInputs.a
  Complete-Phase $stage
  $stage = 'alias-a'
  Test-InstalledAlias $packageInputs.a
  Complete-Phase $stage

  # Add B directly over A. Never uninstall A between the two alias checks and
  # never launch the main Application; only the diagnostic checker is invoked.
  $stage = 'upgrade-b'
  Confirm-InstalledPackage $packageInputs.a
  $packageInputs.b.InstallAttempted = $true
  Add-AppxPackage -Path $packageInputs.b.SignedPackage -ErrorAction Stop
  Confirm-InstalledPackage $packageInputs.b
  $report.currentUserInstallationVerified = $true
  Complete-Phase $stage
  $stage = 'alias-b'
  Test-InstalledAlias $packageInputs.b
  Complete-Phase $stage
  $stage = 'verify-upgrade-retargeting'
  $before = $packageInputs.a
  $after = $packageInputs.b
  $current = @(Get-CurrentTestPackages)
  Assert-UpgradeRetargeting $before $after $current
  Assert-OwnedPackage $current[0] $after
  foreach ($label in @('a', 'b')) {
    $packageInput = $packageInputs[$label]
    $packageInput.Record.signedPackageAfterProbeSha256 = Get-Hash $packageInput.SignedPackage
    if ($packageInput.Record.signedPackageAfterProbeSha256 -cne $packageInput.Record.signedPackageSha256) {
      throw 'A signed copy changed during installation or alias testing.'
    }
  }
  $report.retargeting = [ordered]@{
    fromVersion = $before.Version; toVersion = $after.Version
    packageFamilyUnchanged = $true; helperApplicationUserModelIdUnchanged = $true
    absoluteAliasPathUnchanged = $true; packageFullNameChanged = $true
    oldVersionNoLongerRegistered = $true; mainApplicationLaunched = $false
  }
  Complete-Phase $stage
  $report.aliasActivationVerified = $true
  $report.packageIdentityVerified = $true
  $report.server2025InstalledProbeVerified = $true
  # These browser cases test the already installed B package. They do not
  # establish browser continuity across A-to-B, and never launch the main app.
  $stage = 'browser-b'
  $browserDirectory = Join-Path $OutputDirectory 'browser'
  $browserAttempted = $true
  $null = Invoke-BoundedProgram $node @((Join-Path $repository 'scripts\test-windows-store-native-messaging-browser.mjs'), '--prepared', $after.Prepared, '--expected-package-version', $after.Version, '--output-directory', $browserDirectory) 'test-installed-browsers-b' 360000
  $browserReport = Read-Json $browserReportPath
  Assert-BrowserReport $browserReport $after $env:GITHUB_SHA
  Confirm-InstalledPackage $after
  Assert-UpgradeRetargeting $before $after @(Get-CurrentTestPackages)
  $report.browser = [ordered]@{
    packageVersion = $after.Version; reportSha256 = Get-Hash $browserReportPath
    browserCount = 3; testCount = 9; cleanupVerified = $true; diagnosticProbeOnly = $true
    browserUpgradeVerified = $false
  }
  Complete-Phase $stage
  $browserTestCompleted = $true
  $testCompleted = $true
} catch {
  $report.error = Get-Failure $_ $stage
  $report.phases.Add([ordered]@{ name = $stage; ok = $false; error = $report.error })
} finally {
  if ($browserAttempted) {
    # A killed Node process may never reach its own finally. Package/certificate
    # cleanup alone cannot prove browser profiles or registrations were removed.
    Invoke-CleanupCheck 'browser-runner-cleanup' {
      $cleanupReport = Read-Json $browserReportPath
      Assert-BrowserCleanupReport $cleanupReport $packageInputs.b $env:GITHUB_SHA
    }
  }
  # Each attempted version is an independent cleanup action. A partial upgrade
  # may leave either version registered; unfamiliar versions are never removed.
  foreach ($label in @('a', 'b')) {
    if ($packageInputs.ContainsKey($label) -and $packageInputs[$label].InstallAttempted) {
      $packageInput = $packageInputs[$label]
      Invoke-CleanupCheck "remove-exact-created-package-$label" {
        $remaining = @(Get-CurrentTestPackages | Where-Object { $_.Version.ToString() -ceq $packageInput.Version })
        if ($remaining.Count -gt 1) { throw 'Ambiguous packages for this test version; refusing cleanup.' }
        foreach ($package in $remaining) {
          Assert-OwnedPackage $package $packageInput
          Remove-AppxPackage -Package $package.PackageFullName -ErrorAction Stop
        }
        if (@(Get-CurrentTestPackages | Where-Object { $_.Version.ToString() -ceq $packageInput.Version }).Count -ne 0) {
          throw 'This test package version remains after removal.'
        }
      }
    }
  }
  if (@($packageInputs.Values | Where-Object { $_.InstallAttempted }).Count -ne 0) {
    Invoke-CleanupCheck 'test-package-absent' {
      if (@(Get-CurrentTestPackages).Count -ne 0) { throw 'A test-named package remains; unfamiliar packages are not removed.' }
    }
    Invoke-CleanupCheck 'diagnostic-alias-removed' {
      if (Test-AliasPresent) { throw 'Diagnostic alias remains after package removal.' }
    }
  }
  if ($trustImportAttempted) {
    Invoke-CleanupCheck 'remove-exact-public-trust' {
      $path = "Cert:\LocalMachine\TrustedPeople\$thumbprint"
      if (Test-Path $path) { Remove-Item -Path $path }
      if (Test-Path $path) { throw 'Test trust certificate remains.' }
    }
  }
  if ($null -ne $certificate) {
    Invoke-CleanupCheck 'remove-exact-private-key' {
      if ($thumbprint -cnotmatch '^[0-9A-F]{40}$') { throw 'No safe certificate thumbprint is available for cleanup.' }
      $path = "Cert:\CurrentUser\My\$thumbprint"
      # Ordinary certificate removal leaves the private key behind.
      # https://learn.microsoft.com/powershell/module/microsoft.powershell.security/about/about_certificate_provider
      if (Test-Path $path) { Remove-Item -Path $path -DeleteKey }
      if (Test-Path $path) { throw 'Test private certificate remains.' }
    }
  }
  foreach ($path in @((Join-Path $OutputDirectory 'diagnostic-ci-signed-a.appx'), (Join-Path $OutputDirectory 'diagnostic-ci-signed-b.appx'), $publicCer)) {
    Invoke-CleanupCheck ([IO.Path]::GetFileName($path)) {
      if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
      if (Test-Path -LiteralPath $path) { throw 'Transient test file remains.' }
    }
  }
  foreach ($snapshot in $snapshots) {
    Invoke-CleanupCheck ("unchanged-" + $snapshot.role) {
      if ((Get-Hash $snapshot.path) -cne $snapshot.sha256) { throw 'An original input changed during the runtime test.' }
    }
  }
  $report.cleanupVerified = @($report.cleanup | Where-Object { -not $_.ok }).Count -eq 0
  $report.stage = if ($testCompleted -and $report.cleanupVerified) { 'completed' } elseif ($testCompleted) { 'cleanup' } else { $stage }
  if ($null -eq $report.error -and -not $report.cleanupVerified) {
    $report.error = @($report.cleanup | Where-Object { -not $_.ok })[0].error
  }
  $report.ok = $testCompleted -and $report.cleanupVerified
  # These narrow upgrade claims require both alias checks and complete cleanup.
  $report.upgradeBeforeMainLaunchVerified = $report.ok
  $report.sameAliasRetargetedVerified = $report.ok
  $report.browserNativeMessagingVerified = $report.ok -and $browserTestCompleted
  $report.completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
  Write-NewText (Join-Path $OutputDirectory 'runtime-result.json') (($report | ConvertTo-Json -Depth 32) + "`n")
}
if (-not $report.ok) { throw "CI diagnostic package runtime test failed at $($report.stage); see runtime-result.json and bounded logs." }
Write-Host 'Server 2025 diagnostic alias upgrade, branded browser checks on B and cleanup completed; Windows 11/main-app/MBP1 acceptance remains unverified.'
