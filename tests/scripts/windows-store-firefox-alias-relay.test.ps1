#Requires -Version 7.0
<#
.SYNOPSIS
Compiles the fixed relay source and checks its pure argument/framing contracts.
.DESCRIPTION
Optional RelayPath checks only invalid-argument rejection in the compiled Windows
EXE. It never starts an alias. These tests do not prove packaged/browser behavior.
#>
[CmdletBinding()]
param([string]$ReportPath, [string]$RelayPath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$checks = [Collections.Generic.List[object]]::new()
function Check([string]$Name, [scriptblock]$Test) {
  try { $ok = (& $Test) -eq $true } catch { $ok = $false }
  $checks.Add([ordered]@{ name = $Name; ok = $ok })
}
function Frame([string]$Text) {
  $body = [Text.Encoding]::UTF8.GetBytes($Text)
  return ,([byte[]]([BitConverter]::GetBytes([uint32]$body.Length) + $body))
}
try {
  Add-Type -Path (Join-Path $PSScriptRoot '../fixtures/windows-store-native-messaging/firefox-alias-relay.cs')
  $id = 'motrix-store-p0@motrix.invalid'
  Check 'accepts-fixed-firefox-caller' { [FirefoxAliasRelay]::ValidArguments(@('C:\test folder\manifest.json', $id)) }
  Check 'rejects-missing-arguments' { -not [FirefoxAliasRelay]::ValidArguments(@()) }
  Check 'rejects-extra-target-argument' { -not [FirefoxAliasRelay]::ValidArguments(@('C:\manifest.json', $id, 'C:\other.exe')) }
  Check 'rejects-other-extension' { -not [FirefoxAliasRelay]::ValidArguments(@('C:\manifest.json', 'other@invalid')) }
  Check 'rejects-relative-manifest' { -not [FirefoxAliasRelay]::ValidArguments(@('manifest.json', $id)) }
  Check 'rejects-unc-manifest' { -not [FirefoxAliasRelay]::ValidArguments(@('\\server\manifest.json', $id)) }
  Check 'rejects-alternate-data-stream' { -not [FirefoxAliasRelay]::ValidArguments(@('C:\manifest:stream.json', $id)) }
  Check 'rejects-parent-traversal' { -not [FirefoxAliasRelay]::ValidArguments(@('C:\folder\..\manifest.json', $id)) }
  Check 'rejects-control-character' { -not [FirefoxAliasRelay]::ValidArguments(@("C:\test`n.json", $id)) }
  Check 'quotes-spaces-as-one-argument' { [FirefoxAliasRelay]::Quote('C:\a b\host.json') -ceq '"C:\a b\host.json"' }
  Check 'quotes-trailing-backslash' { [FirefoxAliasRelay]::Quote('C:\a\') -ceq '"C:\a\\"' }
  Check 'quotes-embedded-quote' { [FirefoxAliasRelay]::Quote('a"b') -ceq '"a\"b"' }
  $challenge = Frame '{"probe":"motrix-store-p0"}'
  Check 'accepts-fixed-challenge' { [FirefoxAliasRelay]::IsChallenge($challenge) }
  Check 'rejects-other-challenge' { -not [FirefoxAliasRelay]::IsChallenge((Frame '{"probe":"other"}')) }
  Check 'rejects-extra-challenge-member' { -not [FirefoxAliasRelay]::IsChallenge((Frame '{"probe":"motrix-store-p0","extra":1}')) }
  Check 'reads-complete-frame' {
    $stream = [IO.MemoryStream]::new($challenge)
    try { [Convert]::ToBase64String([FirefoxAliasRelay]::ReadFrame($stream, 256)) -ceq [Convert]::ToBase64String($challenge) } finally { $stream.Dispose() }
  }
  Check 'rejects-truncated-frame' {
    $stream = [IO.MemoryStream]::new([byte[]]@(2, 0, 0, 0, 123))
    try { try { $null = [FirefoxAliasRelay]::ReadFrame($stream, 256); $false } catch { $true } } finally { $stream.Dispose() }
  }
  Check 'rejects-oversized-frame-before-allocation' {
    $stream = [IO.MemoryStream]::new([BitConverter]::GetBytes([uint32]4294967295))
    try { try { $null = [FirefoxAliasRelay]::ReadFrame($stream, 256); $false } catch { $true } } finally { $stream.Dispose() }
  }
  Check 'accepts-one-reply-frame' { [FirefoxAliasRelay]::IsSingleReply((Frame '{"test":true}')) }
  Check 'rejects-two-reply-frames' { -not [FirefoxAliasRelay]::IsSingleReply([byte[]]($challenge + $challenge)) }
  Check 'rejects-invalid-utf8-reply' { -not [FirefoxAliasRelay]::IsSingleReply([byte[]]@(1, 0, 0, 0, 255)) }
  Check 'capture-rejects-output-overflow' {
    $stream = [IO.MemoryStream]::new([byte[]]::new(1025))
    try { try { $null = [FirefoxAliasRelay]::Capture($stream, 1024); $false } catch { $true } } finally { $stream.Dispose() }
  }
  if ($RelayPath) {
    if (-not $IsWindows -or -not [IO.Path]::IsPathFullyQualified($RelayPath)) { throw 'Windows absolute relay path required' }
    foreach ($arguments in @(@(), @('C:\test.json', 'wrong@invalid'))) {
      Check "compiled-rejects-$($arguments.Count)-invalid-arguments" {
        $process = [Diagnostics.Process]::new()
        $process.StartInfo.FileName = $RelayPath
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.RedirectStandardInput = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        foreach ($argument in $arguments) { $process.StartInfo.ArgumentList.Add($argument) }
        try {
          if (-not $process.Start()) { throw 'start failed' }
          $process.StandardInput.Close()
          if (-not $process.WaitForExit(3000)) { throw 'rejection timed out' }
          $process.ExitCode -eq 2 -and $process.StandardOutput.ReadToEnd().Length -eq 0 -and $process.StandardError.ReadToEnd().Length -eq 0
        } finally {
          if ($process.Id -gt 0 -and -not $process.HasExited) { $process.Kill($true); $null = $process.WaitForExit(2000) }
          $process.Dispose()
        }
      }
    }
  }
} catch { $checks.Add([ordered]@{ name = 'harness'; ok = $false }) }
$report = [ordered]@{
  schemaVersion = 1; scope = 'windows-firefox-alias-relay-contract-tests'
  ok = (@($checks | Where-Object { -not $_.ok }).Count -eq 0); testCount = $checks.Count; checks = $checks.ToArray()
  directStdioVerified = $false; packagedActivationVerified = $false; browserNativeMessagingVerified = $false; mbp1Verified = $false
}
$json = ($report | ConvertTo-Json -Depth 6) + "`n"
if ($ReportPath) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
  $stream = [IO.File]::Open($ReportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
}
Write-Output $json
if ($report.ok) { exit 0 }
exit 1
