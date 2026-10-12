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
