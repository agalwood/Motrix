Set-StrictMode -Version Latest

# Bound in-memory observations and drain excess bytes. Never write captured
# application output to logs or artifacts; callers retain fixed classifications.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
namespace MotrixStoreTest {
    public sealed class BoundedOutput {
        private readonly byte[] bytes;
        private readonly object gate = new object();
        private int length;
        private bool truncated;
        public BoundedOutput(int limit) {
            if (limit <= 0 || limit > 65536) throw new ArgumentOutOfRangeException("limit");
            bytes = new byte[limit];
        }
        public bool Truncated { get { lock (gate) return truncated; } }
        public int Length { get { lock (gate) return length; } }
        public string Snapshot() { lock (gate) return Encoding.UTF8.GetString(bytes, 0, length); }
        public async Task PumpAsync(Stream stream) {
            var buffer = new byte[4096];
            while (true) {
                int count = await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                if (count == 0) return;
                lock (gate) {
                    int retain = Math.Min(count, bytes.Length - length);
                    Buffer.BlockCopy(buffer, 0, bytes, length, retain);
                    length += retain;
                    if (retain != count) truncated = true;
                }
            }
        }
        public static string StartupFailureCode(string text) {
            var match = System.Text.RegularExpressions.Regex.Match(text,
                @"(?m)^Windows package identity validation failed \((invalid_resource|product_version_mismatch|identity_query_failed|invalid_response|identity_mismatch|invalid_expectation|invalid_identity)\)\r?$",
                System.Text.RegularExpressions.RegexOptions.CultureInvariant);
            return match.Success ? match.Groups[1].Value : null;
        }
    }
}
'@

# Only these public fields may leave the in-memory native observation.
function Assert-StoreNativeQueryReply([object]$Reply, [string]$Operation, [string]$MainAumid) {
    $properties = if ($Operation -ceq 'startup_query') { @('version', 'ok', 'packageIdentityPresent', 'taskId', 'state') }
        elseif ($Operation -ceq 'associations_query') { @('version', 'ok', 'packageIdentityPresent', 'mainAppAumid', 'torrent', 'magnet') }
        else { throw 'Only read-only native operations are accepted.' }
    if ($null -eq $Reply -or @(Compare-Object $properties @($Reply.PSObject.Properties.Name) -CaseSensitive).Count -ne 0) { throw 'Unexpected native query fields.' }
    if ($Reply.version -isnot [long] -and $Reply.version -isnot [int]) { throw 'Unexpected native query version type.' }
    if ($Reply.version -ne 1 -or $Reply.ok -isnot [bool] -or -not $Reply.ok -or $Reply.packageIdentityPresent -isnot [bool] -or -not $Reply.packageIdentityPresent) { throw 'Native query did not verify package identity.' }
    if ($Operation -ceq 'startup_query') {
        if ($Reply.taskId -isnot [string] -or $Reply.taskId -cne 'MotrixStartup' -or $Reply.state -isnot [string] -or @('disabled', 'disabled_by_user', 'enabled', 'disabled_by_policy', 'enabled_by_policy') -cnotcontains $Reply.state) { throw 'Unexpected native startup state.' }
    } else {
        if ($Reply.mainAppAumid -isnot [string] -or $Reply.mainAppAumid -ine $MainAumid -or -not $Reply.mainAppAumid.EndsWith('!Motrix', [StringComparison]::Ordinal)) { throw 'Native association query selected a different application.' }
        if (($null -ne $Reply.torrent -and $Reply.torrent -isnot [bool]) -or ($null -ne $Reply.magnet -and $Reply.magnet -isnot [bool])) { throw 'Unexpected native default verdict.' }
    }
}

function Get-StoreNativeQueryFailureCode([object]$Reply) {
    if ($null -eq $Reply) { return $null }
    $properties = @($Reply.PSObject.Properties | ForEach-Object { $_.Name })
    foreach ($name in @('version', 'ok', 'code')) { if ($properties -cnotcontains $name) { return $null } }
    foreach ($name in $properties) { if (@('version', 'ok', 'code', 'hresult') -cnotcontains $name) { return $null } }
    if (($Reply.version -isnot [long] -and $Reply.version -isnot [int]) -or $Reply.version -ne 1 -or $Reply.ok -isnot [bool] -or $Reply.ok) { return $null }
    if ($properties -ccontains 'hresult' -and ($Reply.hresult -isnot [string] -or $Reply.hresult -cnotmatch '^0x[0-9a-fA-F]{8}$')) { return $null }
    if (@('invalid_request', 'no_package_identity', 'task_unavailable', 'winrt_failed', 'unknown_state', 'main_app_unavailable') -ccontains $Reply.code) { return $Reply.code }
    return $null
}
