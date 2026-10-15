#Requires -Version 7.0
<#
.SYNOPSIS
Tests the real diagnostic executable using bounded binary stdin/stdout pipes.
.DESCRIPTION
Runs only the explicitly selected probe, directly and outside a package. Caller
arguments are fixed simulations, not browser evidence. No alias, registration,
profile, endpoint, pairing, or package installation is used. Failures throw and
can only produce an ok:false report; an existing report is never overwritten.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ProbePath,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) {
  throw 'This test requires Windows and PowerShell 7'
}
$probe = Get-Item -LiteralPath $ProbePath -Force -ErrorAction Stop
if ($probe -isnot [IO.FileInfo] -or $probe.Name -cne 'motrix-store-p0-probe.exe' -or
    $probe.Length -eq 0 -or ($probe.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Select the regular diagnostic probe executable'
}
$reportFile = [IO.Path]::GetFullPath($ReportPath)
if (Test-Path -LiteralPath $reportFile) { throw 'Use a new report path' }
$reportParent = Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($reportFile)) -Force -ErrorAction Stop
if ($reportParent -isnot [IO.DirectoryInfo] -or
    ($reportParent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'The report parent must be an existing regular directory'
}
$probeHash = (Get-FileHash -LiteralPath $probe.FullName -Algorithm SHA256).Hash.ToLowerInvariant()

function New-Frame([byte[]]$Body) {
  return ,([byte[]]([BitConverter]::GetBytes([uint32]$Body.Length) + $Body))
}

function Invoke-ProbeCase([hashtable]$Case) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $probe.FullName
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in $Case.arguments) { $start.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  $started = $false
  $clock = [Diagnostics.Stopwatch]::StartNew()
  # One byte beyond each limit detects overflow without unbounded allocation.
  $stdout = [byte[]]::new(4101)
  $stderr = [byte[]]::new(1025)
  $stdoutCount = 0
  $stderrCount = 0
  try {
    $started = $process.Start()
    if (-not $started) { throw 'probe-start-failed' }
    $stdoutTask = $process.StandardOutput.BaseStream.ReadAsync($stdout, 0, $stdout.Length)
    $stderrTask = $process.StandardError.BaseStream.ReadAsync($stderr, 0, $stderr.Length)
    if ($Case.input.Length -gt 0) {
      $write = $process.StandardInput.BaseStream.WriteAsync($Case.input, 0, $Case.input.Length)
      if (-not $write.Wait(2000)) { throw 'probe-write-timeout' }
      $null = $write.GetAwaiter().GetResult()
    }
    if (-not $Case.holdOpen) { $process.StandardInput.Close() }
    $stdoutEnded = $false
    $stderrEnded = $false
    while ($true) {
      if ($clock.ElapsedMilliseconds -gt 15000) { throw 'probe-total-timeout' }
      if (-not $stdoutEnded -and $stdoutTask.IsCompleted) {
        $read = $stdoutTask.GetAwaiter().GetResult()
        $stdoutCount += $read
        if ($stdoutCount -gt 4100) { throw 'probe-stdout-limit' }
        $stdoutEnded = $read -eq 0
        if (-not $stdoutEnded) {
          $stdoutTask = $process.StandardOutput.BaseStream.ReadAsync($stdout, $stdoutCount, $stdout.Length - $stdoutCount)
        }
      }
      if (-not $stderrEnded -and $stderrTask.IsCompleted) {
        $read = $stderrTask.GetAwaiter().GetResult()
        $stderrCount += $read
        if ($stderrCount -gt 1024) { throw 'probe-stderr-limit' }
        $stderrEnded = $read -eq 0
        if (-not $stderrEnded) {
          $stderrTask = $process.StandardError.BaseStream.ReadAsync($stderr, $stderrCount, $stderr.Length - $stderrCount)
        }
      }
      if ($process.HasExited -and $stdoutEnded -and $stderrEnded) { break }
      Start-Sleep -Milliseconds 10
    }
    if ($process.ExitCode -ne $Case.expectedExit) { throw 'unexpected-probe-exit-code' }
    if ($stderrCount -ne 0) { throw 'unexpected-probe-stderr' }
    $frameCount = 0
    if ($Case.expectedExit -eq 0) {
      if ($stdoutCount -lt 5) { throw 'missing-probe-frame' }
      $length = [BitConverter]::ToUInt32($stdout, 0)
      if ($length -lt 1 -or $length -gt 4096 -or ($length + 4) -ne $stdoutCount) {
        throw 'invalid-or-extra-probe-frame'
      }
      $json = [Text.UTF8Encoding]::new($false, $true).GetString($stdout, 4, $length)
      $reply = $json | ConvertFrom-Json -AsHashtable -Depth 8
      $fields = @('schemaVersion', 'probe', 'packageIdentityPresent', 'expectedPackageName', 'packageVersion',
        'applicationIdentityPresent', 'expectedHelperApplication', 'chromiumCallerShape', 'firefoxTestCallerShape',
        'packageFullNameSha256', 'applicationUserModelIdSha256')
      if ($reply -isnot [Collections.IDictionary] -or $reply.Count -ne $fields.Count) { throw 'invalid-probe-reply-fields' }
      foreach ($field in $fields) {
        if ($reply.Keys -cnotcontains $field) { throw 'missing-probe-reply-field' }
      }
      if ($reply.schemaVersion -isnot [long] -or $reply.schemaVersion -ne 1 -or
          $reply.probe -cne 'motrix-store-p0' -or $reply.packageVersion -cne '') {
        throw 'unexpected-probe-reply-contract'
      }
      foreach ($field in @('packageIdentityPresent', 'expectedPackageName', 'applicationIdentityPresent', 'expectedHelperApplication')) {
        if ($reply[$field] -isnot [bool] -or $reply[$field]) { throw 'direct-probe-must-have-no-package-identity' }
      }
      foreach ($field in @('packageFullNameSha256', 'applicationUserModelIdSha256')) {
        if ($reply[$field] -isnot [string] -or $reply[$field] -cne '') { throw 'direct-probe-must-have-empty-identity-hashes' }
      }
      foreach ($field in @('chromiumCallerShape', 'firefoxTestCallerShape')) {
        if ($reply[$field] -isnot [bool] -or $reply[$field] -ne $Case[$field]) { throw 'unexpected-simulated-caller-shape' }
      }
      $frameCount = 1
    } elseif ($stdoutCount -ne 0) { throw 'rejected-probe-request-produced-stdout' }
    return [ordered]@{
      name = $Case.name
      ok = $true
      expectedChildExit = $Case.expectedExit
      childExit = $process.ExitCode
      stdoutBytes = $stdoutCount
      stderrBytes = $stderrCount
      frameCount = $frameCount
      callerEvidence = if ($Case.arguments.Count -gt 0) { 'simulated-argv-only' } else { 'none' }
    }
  } finally {
    if ($started -and -not $process.HasExited) {
      $process.Kill($true)
      if (-not $process.WaitForExit(2000)) { throw 'probe-cleanup-timeout' }
    }
    $process.Dispose()
    $clock.Stop()
  }
}

$utf8 = [Text.UTF8Encoding]::new($false, $true)
$challenge = New-Frame ($utf8.GetBytes('{"probe":"motrix-store-p0"}'))
$cases = @(
  @{ name = 'fixed-challenge'; input = $challenge; expectedExit = 0 },
  @{ name = 'json-whitespace'; input = (New-Frame ($utf8.GetBytes(" `t`r`n{ `n`"probe`"`t : `r`"motrix-store-p0`" } `t`r`n"))); expectedExit = 0 },
  @{ name = 'simulated-chromium-argv'; input = $challenge; expectedExit = 0; arguments = @('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'); chromiumCallerShape = $true },
  @{ name = 'simulated-firefox-argv'; input = $challenge; expectedExit = 0; arguments = @('unused-manifest-argument', 'motrix-store-p0@motrix.invalid'); firefoxTestCallerShape = $true },
  @{ name = 'zero-length'; input = [BitConverter]::GetBytes([uint32]0); expectedExit = 2 },
  @{ name = 'oversized-length'; input = [BitConverter]::GetBytes([uint32]257); expectedExit = 2 },
  @{ name = 'maximum-uint-length'; input = [BitConverter]::GetBytes([uint32]::MaxValue); expectedExit = 2 },
  @{ name = 'invalid-json'; input = (New-Frame ($utf8.GetBytes('{'))); expectedExit = 2 },
  @{ name = 'extra-json-field'; input = (New-Frame ($utf8.GetBytes('{"probe":"motrix-store-p0","extra":true}'))); expectedExit = 2 },
  @{ name = 'non-json-whitespace'; input = (New-Frame ($utf8.GetBytes(([string][char]0x00a0) + '{"probe":"motrix-store-p0"}'))); expectedExit = 2 },
  @{ name = 'invalid-utf8'; input = (New-Frame ([byte[]]@(0xc3, 0x28))); expectedExit = 3 },
  @{ name = 'truncated-prefix'; input = [byte[]]@(1, 0, 0); expectedExit = 3 },
  @{ name = 'truncated-body'; input = [byte[]]([BitConverter]::GetBytes([uint32]2) + [byte[]]@(0x7b)); expectedExit = 3 },
  @{ name = 'empty-input-eof'; input = [byte[]]@(); expectedExit = 3 },
  @{ name = 'hold-open-timeout'; input = [byte[]]@(); expectedExit = 4; holdOpen = $true }
)
$checks = [Collections.Generic.List[object]]::new()
$failedCase = $null
$failureCode = $null
try {
  foreach ($case in $cases) {
    $failedCase = $case.name
    foreach ($default in @{ arguments = [string[]]@(); holdOpen = $false; chromiumCallerShape = $false; firefoxTestCallerShape = $false }.GetEnumerator()) {
      if (-not $case.ContainsKey($default.Key)) { $case[$default.Key] = $default.Value }
    }
    $check = Invoke-ProbeCase $case
    if ($check -isnot [Collections.IDictionary] -or $check.name -cne $case.name -or $check.ok -ne $true) {
      throw 'invalid-case-result'
    }
    $checks.Add($check)
  }
  $failedCase = 'probe-file-unchanged'
  if ((Get-FileHash -LiteralPath $probe.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $probeHash) {
    throw 'The probe executable changed during testing'
  }
  $failedCase = $null
} catch {
  # Raw child output, arguments, paths, and exception text are not report data.
  $failureCode = if ($_.Exception.Message -cmatch '\A[a-z]+(?:-[a-z]+)*\z') {
    $_.Exception.Message
  } else { 'test-infrastructure-error' }
  $checks.Add([ordered]@{ name = $failedCase; ok = $false })
}
$report = [ordered]@{
  schemaVersion = 1
  scope = 'windows-native-messaging-direct-stdio-tests'
  ok = $null -eq $failedCase
  testCount = $checks.Count
  checks = $checks.ToArray()
  executable = [ordered]@{ path = 'motrix-store-p0-probe.exe'; sha256 = $probeHash }
  directStdioVerified = $null -eq $failedCase
  packageIdentityPresent = if ($null -eq $failedCase) { $false } else { $null }
  callerShapeEvidence = 'simulated-argv-only'
  packagedActivationVerified = $false
  browserNativeMessagingVerified = $false
  mbp1Verified = $false
}
if ($null -ne $failedCase) {
  $report.failedCase = $failedCase
  $report.failureCode = $failureCode
}
$json = ($report | ConvertTo-Json -Depth 10) + "`n"
$stream = [IO.File]::Open($reportFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
  $encoded = [Text.UTF8Encoding]::new($false).GetBytes($json)
  $stream.Write($encoded, 0, $encoded.Length)
} finally { $stream.Dispose() }
Write-Output $json
if ($null -ne $failedCase) { throw "Native Messaging direct probe test failed: $failedCase ($failureCode)" }
