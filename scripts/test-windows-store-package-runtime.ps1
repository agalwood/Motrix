#Requires -Version 5.1
<#
.SYNOPSIS
Tests the fixed diagnostic AppX on a disposable GitHub-hosted Windows runner.
.DESCRIPTION
Requires 64-bit Windows PowerShell 5.1 and workflow_dispatch. Signs a new copy
with an ephemeral non-exportable test key, installs for the current user, and
runs only the diagnostic alias. No production certificates, PFX, timestamp,
main-app launch, policy changes, or browser integration are involved.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PreparedDirectory,
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
    public static Result Run(string program, string[] args, string directory) {
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
                    if (timer.ElapsedMilliseconds >= 120000) { result.TimedOut = true; break; }
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

function Invoke-BoundedProgram([string]$Program, [string[]]$Arguments, [string]$Name) {
  $result = [MotrixCiRuntimeProcess]::Run($Program, $Arguments, $OutputDirectory)
  $stdout = [Text.Encoding]::UTF8.GetString($result.Stdout)
  $stderr = [Text.Encoding]::UTF8.GetString($result.Stderr)
  Write-NewText (Join-Path $OutputDirectory "$Name.stdout.log") (Protect-Log $stdout)
  Write-NewText (Join-Path $OutputDirectory "$Name.stderr.log") (Protect-Log $stderr)
  $report.commands.Add([ordered]@{
    name = $Name; exitCode = $result.ExitCode; timedOut = $result.TimedOut
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

function Assert-OwnedPackage([object]$Package) {
  if ($Package.Name -cne 'Motrix.Store.Test' -or $Package.Publisher -cne 'CN=Motrix Store Test' -or
      $Package.Version.ToString() -cne $packageVersion -or $Package.Architecture.ToString() -ine 'X64') {
    throw 'Installed package identity/version/architecture does not match this test.'
  }
  if ($Package.PublisherId -cnotmatch '^[0-9a-hjkmnp-tv-z]{13}$' -or
      $Package.PackageFullName -cne "Motrix.Store.Test_${packageVersion}_x64__$($Package.PublisherId)" -or
      $Package.PackageFamilyName -cne "Motrix.Store.Test_$($Package.PublisherId)") {
    throw 'Installed package has an unexpected full or family name.'
  }
  if ($null -ne $createdPackageFullName -and $Package.PackageFullName -cne $createdPackageFullName) {
    throw 'Cleanup candidate differs from the exact package observed after installation.'
  }
  $installedProbe = Join-Path $Package.InstallLocation 'diagnostics\motrix-store-p0-probe.exe'
  if ((Get-Hash $installedProbe) -cne $probeHash) { throw 'Installed probe hash does not match this test.' }
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
$SdkBinDirectory = Get-AbsolutePath $SdkBinDirectory
$OutputDirectory = Get-AbsolutePath $OutputDirectory
if ($PreparedDirectory -ine (Join-Path $runnerTemp 'motrix-windows-store-diagnostic\prepared') -or
    $OutputDirectory -ine (Join-Path $runnerTemp 'motrix-store-alias-runtime')) {
  throw 'Only the fixed diagnostic prepared and runtime output paths are permitted.'
}
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Runtime output must be a new directory.' }
$null = [IO.Directory]::CreateDirectory($OutputDirectory)
$report = [ordered]@{
  schemaVersion = 1; scope = 'github-hosted-server-test-package-runtime'; ok = $false
  sourceCommit = $env:GITHUB_SHA; stage = 'preflight'; context = $null
  commands = [Collections.Generic.List[object]]::new()
  cleanup = [Collections.Generic.List[object]]::new()
  signedTestCopyVerified = $false; currentUserInstallationVerified = $false
  aliasActivationVerified = $false; packageIdentityVerified = $false
  server2025InstalledProbeVerified = $false
  windows11AcceptanceVerified = $false; standardUserVerified = $false
  browserNativeMessagingVerified = $false; mbp1Verified = $false
  motrixMainRuntimeVerified = $false; upgradeVerified = $false; wackVerified = $false
  productionSigned = $false; storeReady = $false; storeSubmissionReady = $false
  error = $null
}
$stage = 'preflight'
$snapshots = [Collections.Generic.List[object]]::new()
$certificate = $null
$thumbprint = $null
$trustImportAttempted = $false
$installAttempted = $false
$createdPackageFullName = $null
$signedPackage = Join-Path $OutputDirectory 'diagnostic-ci-signed.appx'
$publicCer = Join-Path $OutputDirectory 'diagnostic-ci-public.cer'
$aliasRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Microsoft\WindowsApps'
$packageVersion = $null
$probeHash = $null
$testCompleted = $false
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
  $stage = 'validate-inputs'
  $metadata = Read-Json (Join-Path $PreparedDirectory 'release-metadata.json')
  $source = Read-Json (Join-Path $PreparedDirectory 'source-report.json')
  $layout = Read-Json (Join-Path $PreparedDirectory 'layout-report.json')
  $sdkDirectory = "$PreparedDirectory.sdk-output"
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
      $sdk.status -cne 'completed') { throw 'Completed SDK result and metadata versions must agree.' }
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
    @{ role = 'metadata'; path = (Join-Path $PreparedDirectory 'release-metadata.json') },
    @{ role = 'sourceReport'; path = (Join-Path $PreparedDirectory 'source-report.json') },
    @{ role = 'layoutReport'; path = (Join-Path $PreparedDirectory 'layout-report.json') }
  )) {
    $snapshots.Add(@{ role = $entry.role; path = $entry.path; sha256 = (Get-Hash $entry.path) })
  }
  $probeHash = $layout.diagnostics.executable.sha256
  if ($probeHash -cnotmatch '^[0-9a-f]{64}$') { throw 'Diagnostic executable hash is invalid.' }
  $verified = Invoke-BoundedProgram $node @((Join-Path $repository 'scripts\verify-windows-store-layout.mjs'), '--prepared', $PreparedDirectory, '--phase', 'indexed') 'verify-indexed'
  $verified = $verified | ConvertFrom-Json
  Assert-True $verified.ok 'Indexed verification failed.'
  if ($verified.phase -cne 'indexed' -or $verified.testDiagnostics -cne 'native-messaging-probe-v1' -or
      $verified.diagnostics.executable.sha256 -cne $probeHash) { throw 'Indexed diagnostic verification differs from the layout.' }
  $report.packageVersion = $packageVersion
  $report.unsignedPackageSha256 = $sdk.package.sha256
  $report.sdkResultSha256 = Get-Hash $sdkPath
  $report.probeExecutableSha256 = $probeHash
  $signTool = Join-Path $SdkBinDirectory 'signtool.exe'
  $report.signTool = [ordered]@{ sha256 = (Get-Hash $signTool); fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($signTool).FileVersion }
  $stage = 'check-clean-machine'
  if (@(Get-AppxPackage -AllUsers -Name 'Motrix.Store.Test' -ErrorAction Stop).Count -ne 0 -or (Test-AliasPresent)) {
    throw 'An existing test package or diagnostic alias prevents this experiment.'
  }
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
  $stage = 'sign-test-copy'
  [IO.File]::Copy($unsignedPackage, $signedPackage, $false)
  if ((Get-Hash $signedPackage) -cne $sdk.package.sha256) { throw 'Test copy differs before signing.' }
  $report.copyBeforeSigningSha256 = Get-Hash $signedPackage
  # /sha1 selects the certificate; /fd controls the package digest. No /sm,
  # automatic certificate selection, timestamp, or private-key export.
  # https://learn.microsoft.com/windows/win32/seccrypto/signtool
  $null = Invoke-BoundedProgram $signTool @('sign', '/sha1', $thumbprint, '/s', 'My', '/fd', 'SHA256', $signedPackage) 'sign-test-copy'
  $null = Invoke-BoundedProgram $signTool @('verify', '/pa', '/v', $signedPackage) 'verify-test-signature'
  $report.signedPackageSha256 = Get-Hash $signedPackage
  $report.signedTestCopyVerified = $true
  $stage = 'install-current-user'
  $installAttempted = $true
  Add-AppxPackage -Path $signedPackage -ErrorAction Stop
  $packages = @(Get-CurrentTestPackages)
  if ($packages.Count -ne 1) { throw 'Expected exactly one current-user test package after installation.' }
  Assert-OwnedPackage $packages[0]
  $createdPackageFullName = $packages[0].PackageFullName
  $report.installedPackage = [ordered]@{
    fullNameSha256 = Get-TextHash $packages[0].PackageFullName
    familyNameSha256 = Get-TextHash $packages[0].PackageFamilyName
    helperApplicationUserModelIdSha256 = Get-TextHash "$($packages[0].PackageFamilyName)!MotrixNativeHostP0"
    installedProbeSha256 = $probeHash
  }
  $report.currentUserInstallationVerified = $true
  $stage = 'test-installed-alias'
  $aliasReportPath = Join-Path $OutputDirectory 'alias-report.json'
  $null = Invoke-BoundedProgram $node @((Join-Path $repository 'scripts\test-windows-store-native-messaging-alias.mjs'), '--prepared', $PreparedDirectory, '--expected-package-version', $packageVersion, '--report', $aliasReportPath) 'test-installed-alias'
  $aliasReport = Read-Json $aliasReportPath
  if ($aliasReport.schemaVersion -ne 1 -or $aliasReport.scope -cne 'windows-native-messaging-installed-alias' -or
      $aliasReport.sourceCommit -cne $env:GITHUB_SHA -or $aliasReport.packageVersion -cne $packageVersion -or
      $aliasReport.executableSha256 -cne $probeHash -or
      $aliasReport.identity.packageFullNameSha256 -cne $report.installedPackage.fullNameSha256 -or
      $aliasReport.identity.applicationUserModelIdSha256 -cne $report.installedPackage.helperApplicationUserModelIdSha256) {
    throw 'Alias checker report does not match this diagnostic package.'
  }
  foreach ($name in @('ok', 'aliasActivationVerified', 'packageIdentityVerified')) {
    Assert-True $aliasReport.$name 'Installed alias verification failed.'
  }
  $aliasCases = @($aliasReport.checks | Where-Object { $null -ne $_.PSObject.Properties['exitCode'] })
  if ($aliasReport.testCount -ne 3 -or $aliasCases.Count -ne 3) {
    throw 'Alias checker did not complete all three cases.'
  }
  foreach ($check in $aliasReport.checks) {
    if ($check -is [array]) { throw 'Alias checks must be flat records.' }
    Assert-True $check.ok 'An installed alias case failed.'
  }
  foreach ($check in $aliasCases) {
    if ($check.exitCode -ne 0 -or $check.frameCount -ne 1 -or $check.stderrBytes -ne 0 -or
        $check.stdoutBytes -le 4 -or $check.stdoutBytes -gt 4100) {
      throw 'An installed alias case has unexpected exit, frame or output bounds.'
    }
  }
  foreach ($name in @('browserNativeMessagingVerified', 'mbp1Verified', 'windows11AcceptanceVerified')) {
    Assert-False $aliasReport.$name 'Alias report overstates the scope of this experiment.'
  }
  $report.aliasActivationVerified = $true
  $report.packageIdentityVerified = $true
  $report.server2025InstalledProbeVerified = $true
  $report.aliasReportSha256 = Get-Hash $aliasReportPath
  $report.signedPackageAfterProbeSha256 = Get-Hash $signedPackage
  if ($report.signedPackageAfterProbeSha256 -cne $report.signedPackageSha256) { throw 'Signed copy changed during installation or alias testing.' }
  $testCompleted = $true
} catch {
  $report.error = Get-Failure $_ $stage
} finally {
  if ($installAttempted) {
    Invoke-CleanupCheck 'remove-exact-created-package' {
      $remaining = @(Get-CurrentTestPackages)
      if ($remaining.Count -gt 1) { throw 'Ambiguous current-user packages; refusing cleanup.' }
      foreach ($package in $remaining) {
        # A failed installation may still register a package. Remove it only
        # after identity, version, architecture and installed probe hash match.
        Assert-OwnedPackage $package
        Remove-AppxPackage -Package $package.PackageFullName -ErrorAction Stop
      }
      if (@(Get-CurrentTestPackages).Count -ne 0) { throw 'Test package remains after removal.' }
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
  foreach ($path in @($signedPackage, $publicCer)) {
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
  $report.completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
  Write-NewText (Join-Path $OutputDirectory 'runtime-result.json') (($report | ConvertTo-Json -Depth 32) + "`n")
}
if (-not $report.ok) { throw "CI diagnostic package runtime test failed at $($report.stage); see runtime-result.json and bounded logs." }
Write-Host 'Server 2025 diagnostic package alias test and cleanup completed; Windows 11/browser/MBP1 acceptance remains unverified.'
