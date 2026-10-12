#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/windows-store-test-output.ps1')

$bytes = [Text.Encoding]::UTF8.GetBytes(('private-fixture-data' * 2000))
$stream = [IO.MemoryStream]::new($bytes)
$output = [MotrixStoreTest.BoundedOutput]::new(256)
try {
    $output.PumpAsync($stream).GetAwaiter().GetResult()
    if ($output.Length -ne 256 -or -not $output.Truncated -or $stream.Position -ne $bytes.Length) { throw 'Capture must stay bounded while draining the complete stream.' }
} finally { $stream.Dispose() }
foreach ($code in @('invalid_resource', 'product_version_mismatch', 'identity_query_failed', 'invalid_response', 'identity_mismatch', 'invalid_expectation', 'invalid_identity')) {
    if ([MotrixStoreTest.BoundedOutput]::StartupFailureCode("Windows package identity validation failed ($code)`r`n") -cne $code) { throw 'Recognized fixed code missing.' }
}
foreach ($text in @('private-fixture-data', 'Windows package identity validation failed (private-fixture-data)', 'prefix Windows package identity validation failed (invalid_resource)', 'Windows package identity validation failed (invalid_resource) suffix')) {
    if ($null -ne [MotrixStoreTest.BoundedOutput]::StartupFailureCode($text)) { throw 'Unrecognized output must never become a diagnostic value.' }
}
'Bounded test output and fixed-code classification passed.'
