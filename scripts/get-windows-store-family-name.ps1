param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9.-]{3,50}$')][string]$Name,
    [Parameter(Mandatory = $true)][ValidateLength(1, 8192)][string]$Publisher
)
$ErrorActionPreference = 'Stop'

# Use Windows' public derivation API instead of duplicating its publisher hash.
# This calculates an identity string; it does not install or modify a package.
# https://learn.microsoft.com/windows/win32/api/appmodel/nf-appmodel-packagefamilynamefromid
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace MotrixStoreBuild {
    public static class PackageIdentity {
        [StructLayout(LayoutKind.Sequential)]
        private struct PackageId {
            public uint Reserved;
            public uint ProcessorArchitecture;
            public ulong Version;
            public IntPtr Name;
            public IntPtr Publisher;
            public IntPtr ResourceId;
            public IntPtr PublisherId;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern int PackageFamilyNameFromId(ref PackageId id, ref uint length, StringBuilder family);
        public static string FromPublisher(string name, string publisher) {
            var id = new PackageId();
            try {
                id.Name = Marshal.StringToHGlobalUni(name);
                id.Publisher = Marshal.StringToHGlobalUni(publisher);
                uint length = 65;
                var family = new StringBuilder((int)length);
                int result = PackageFamilyNameFromId(ref id, ref length, family);
                if (result != 0) throw new InvalidOperationException("Package family derivation failed: " + result);
                return family.ToString();
            } finally {
                if (id.Name != IntPtr.Zero) Marshal.FreeHGlobal(id.Name);
                if (id.Publisher != IntPtr.Zero) Marshal.FreeHGlobal(id.Publisher);
            }
        }
    }
}
'@
[MotrixStoreBuild.PackageIdentity]::FromPublisher($Name, $Publisher)
