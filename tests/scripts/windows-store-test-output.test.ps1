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

$aumid = 'Motrix.Store.Test_cfpch8pkrx9m2!Motrix'
foreach ($state in @('disabled', 'disabled_by_user', 'enabled', 'disabled_by_policy', 'enabled_by_policy')) {
    $reply = '{"version":1,"ok":true,"packageIdentityPresent":true,"taskId":"MotrixStartup","state":"' + $state + '"}' | ConvertFrom-Json
    Assert-StoreNativeQueryReply $reply 'startup_query' $aumid
}
$association = '{"version":1,"ok":true,"packageIdentityPresent":true,"mainAppAumid":"' + $aumid + '","torrent":true,"magnet":null}'
Assert-StoreNativeQueryReply ($association | ConvertFrom-Json) 'associations_query' $aumid
$invalid = @(
    @($association.Replace('true,"magnet"', '"true","magnet"'), 'associations_query'),
    @($association.Replace('!Motrix', '!Helper'), 'associations_query'),
    @($association.Replace('!Motrix', '!motrix'), 'associations_query'),
    @($association.Replace('cfpch8pkrx9m2', '8wekyb3d8bbwe'), 'associations_query'),
    @($association.Replace('"version":1', '"version":"1"'), 'associations_query'),
    @($association.Replace('"ok":true', '"ok":"true"'), 'associations_query'),
    @($association.Replace('"packageIdentityPresent":true', '"packageIdentityPresent":false'), 'associations_query'),
    @($association.Replace('"magnet":null', '"magnet":null,"path":"private-fixture-data"'), 'associations_query'),
    @($association, 'startup_query'),
    @($association, 'startup_enable'),
    @('{"version":1,"ok":true,"packageIdentityPresent":true,"taskId":"MotrixStartup","state":"future"}', 'startup_query'),
    @('{"version":1,"ok":true,"packageIdentityPresent":true,"taskId":true,"state":"disabled"}', 'startup_query')
)
foreach ($case in $invalid) {
    $rejected = $false
    try { Assert-StoreNativeQueryReply ($case[0] | ConvertFrom-Json) $case[1] $aumid } catch { $rejected = $true }
    if (-not $rejected) { throw 'A malformed or mutating native observation was accepted.' }
}
'Read-only native observation field checks passed.'
if ((Get-StoreNativeQueryFailureCode ('{"version":1,"ok":false,"code":"no_package_identity"}' | ConvertFrom-Json)) -cne 'no_package_identity') { throw 'Native fixed failure code missing.' }
foreach ($reply in @('{"code":"private-fixture-data"}', '{"code":"NO_PACKAGE_IDENTITY"}', '{"code":123}', '{}', 'null')) {
    if ($null -ne (Get-StoreNativeQueryFailureCode ($reply | ConvertFrom-Json))) { throw 'Unrecognized native output must never enter the report.' }
}
foreach ($reply in @('{"version":1,"ok":true,"code":"winrt_failed"}', '{"version":1,"ok":false,"code":"winrt_failed","private":"private-fixture-data"}', '{"version":"1","ok":false,"code":"winrt_failed"}')) {
    if ($null -ne (Get-StoreNativeQueryFailureCode ($reply | ConvertFrom-Json))) { throw 'Invalid native error fields must not become a failure classification.' }
}
