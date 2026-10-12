#Requires -Version 7.0
<#
.SYNOPSIS
Compiles a fixed, test-only diagnostic probe using Framework64 csc.
.DESCRIPTION
Kind selects the stdio challenge or registry visibility entrypoint; neither
accepts a caller-selected source. Creates a new directory with the executable and its build
report. Does not package, install, register, or run the probe. The report contains
relative names and hashes, never local absolute paths or compiler output.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$OutputDirectory,
  [ValidateSet('native-messaging', 'registry')][string]$Kind = 'native-messaging'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) {
  throw 'This build requires Windows and PowerShell 7'
}

$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Use a new output directory' }
$sourceName = if ($Kind -eq 'registry') { 'registry-probe.cs' } else { 'stdio-probe.cs' }
$executableName = if ($Kind -eq 'registry') { 'motrix-store-p0-registry.exe' } else { 'motrix-store-p0-probe.exe' }
$scope = if ($Kind -eq 'registry') { 'windows-registry-visibility-probe-build' } else { 'windows-native-messaging-probe-build' }
$sourceRelative = 'tests/fixtures/windows-store-native-messaging/' + $sourceName
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('../' + $sourceRelative)))
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
foreach ($path in @($source, $compiler)) {
  $file = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if ($file -isnot [IO.FileInfo] -or $file.Length -eq 0 -or
      ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The fixed source and Framework64 compiler must be nonempty regular files'
  }
}
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
New-Item -ItemType Directory -Path $output -ErrorAction Stop | Out-Null
$executable = Join-Path $output $executableName
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $compiler
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
foreach ($argument in @('/nologo', '/target:exe', '/platform:x64', '/optimize+', "/out:$executable", $source)) {
  $start.ArgumentList.Add($argument)
}
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
$started = $false
try {
  $started = $process.Start()
  if (-not $started) { throw 'Could not start the Framework64 compiler' }
  $process.StandardInput.Close()
  # Fixed-size reads bound retained compiler output; no compiler text is emitted.
  $stdout = [byte[]]::new(65537)
  $stderr = [byte[]]::new(65537)
  $stdoutTask = $process.StandardOutput.BaseStream.ReadAsync($stdout, 0, $stdout.Length)
  $stderrTask = $process.StandardError.BaseStream.ReadAsync($stderr, 0, $stderr.Length)
  if (-not $process.WaitForExit(60000)) { throw 'Diagnostic probe compilation timed out' }
  if (-not $stdoutTask.Wait(2000) -or -not $stderrTask.Wait(2000)) { throw 'Compiler output did not close' }
  if ($process.ExitCode -ne 0) { throw 'Diagnostic probe compilation failed; compiler output is withheld' }
} finally {
  if ($started -and -not $process.HasExited) {
    $process.Kill($true)
    if (-not $process.WaitForExit(2000)) { throw 'Could not stop the diagnostic compiler' }
  }
  $process.Dispose()
}
if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sourceHash) {
  throw 'The diagnostic source changed during compilation'
}
$exeFile = Get-Item -LiteralPath $executable -Force -ErrorAction Stop
if ($exeFile -isnot [IO.FileInfo] -or $exeFile.Length -lt 256 -or $exeFile.Length -gt 1048576 -or
    ($exeFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'The compiler did not produce a bounded regular executable'
}
$bytes = [IO.File]::ReadAllBytes($executable)
if ($bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { throw 'The probe has no DOS header' }
$peOffset = [BitConverter]::ToUInt32($bytes, 0x3c)
if ($peOffset -lt 64 -or $peOffset -gt ($bytes.Length - 94)) { throw 'The probe PE header is out of bounds' }
if ([BitConverter]::ToUInt32($bytes, $peOffset) -ne 0x00004550) { throw 'The probe has no PE signature' }
$machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
$optionalSize = [BitConverter]::ToUInt16($bytes, $peOffset + 20)
$characteristics = [BitConverter]::ToUInt16($bytes, $peOffset + 22)
if ($optionalSize -lt 70 -or ($peOffset + 24 + $optionalSize) -gt $bytes.Length) {
  throw 'The probe optional PE header is out of bounds'
}
$magic = [BitConverter]::ToUInt16($bytes, $peOffset + 24)
$subsystem = [BitConverter]::ToUInt16($bytes, $peOffset + 24 + 68)
if ($machine -ne 0x8664 -or $magic -ne 0x020b -or $subsystem -ne 3 -or
    ($characteristics -band 0x0002) -eq 0 -or ($characteristics -band 0x2000) -ne 0) {
  throw 'The probe must be an x64 PE32+ console executable, not a DLL'
}
$report = [ordered]@{
  schemaVersion = 1
  scope = $scope
  ok = $true
  compiled = $true
  compiler = 'Windows .NET Framework64 csc'
  source = [ordered]@{ path = $sourceRelative; sha256 = $sourceHash }
  executable = [ordered]@{
    path = $executableName
    bytes = $bytes.Length
    sha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
    peMachine = '0x8664'
    peMachineVerified = $true
    peOptionalHeaderMagic = '0x020b'
    peSubsystem = '0x0003'
    consoleSubsystemVerified = $true
  }
  directStdioVerified = $false
  packagedActivationVerified = $false
  browserNativeMessagingVerified = $false
  mbp1Verified = $false
}
$json = ($report | ConvertTo-Json -Depth 10) + "`n"
$stream = [IO.File]::Open((Join-Path $output 'build-report.json'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
  $encoded = [Text.UTF8Encoding]::new($false).GetBytes($json)
  $stream.Write($encoded, 0, $encoded.Length)
} finally { $stream.Dispose() }
Write-Output $json
