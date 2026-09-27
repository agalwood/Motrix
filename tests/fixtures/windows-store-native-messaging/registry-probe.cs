// Fixed-purpose test package entrypoint. No production host registration,
// caller-selected paths, file access, endpoint access, or network access.
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

internal static class RegistryProbe
{
    private const string Marker = "motrix-store-registry-visibility-v1";
    private const string Host = "app.motrix.bridge.store.visibilityprobe";
    private static readonly string[] Parents = {
        @"Software\Google\Chrome\NativeMessagingHosts\",
        @"Software\Microsoft\Edge\NativeMessagingHosts\",
        @"Software\Mozilla\NativeMessagingHosts\"
    };
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetCurrentPackageFullName(ref uint length, StringBuilder value);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetCurrentPackageFamilyName(ref uint length, StringBuilder value);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetCurrentApplicationUserModelId(ref uint length, StringBuilder value);
    private delegate int Query(ref uint length, StringBuilder value);

    private static string Identity(Query query)
    {
        uint length = 0;
        if (query(ref length, null) != 122 || length == 0 || length > 4096)
            throw new InvalidOperationException();
        var buffer = new StringBuilder((int)length);
        if (query(ref length, buffer) != 0) throw new InvalidOperationException();
        return buffer.ToString();
    }

    private static bool Matches(RegistryKey key)
    {
        return key != null && key.SubKeyCount == 0 && key.ValueCount == 1
            && key.GetValueNames()[0] == "" && key.GetValueKind("") == RegistryValueKind.String
            && String.Equals(key.GetValue("", null, RegistryValueOptions.DoNotExpandEnvironmentNames), Marker);
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 1 || (args[0] != "write" && args[0] != "read")) return 2;
            string package = Identity(GetCurrentPackageFullName);
            string family = Identity(GetCurrentPackageFamilyName);
            string app = Identity(GetCurrentApplicationUserModelId);
            if (!Regex.IsMatch(package, @"\AMotrix\.Store\.Test_1\.0\.(0|1)\.0_x64__[a-z0-9]{13}\z")
                || !Regex.IsMatch(family, @"\AMotrix\.Store\.Test_[a-z0-9]{13}\z")
                || app != family + "!MotrixRegistryP0") return 3;
            bool write = args[0] == "write";
            // Check the complete inventory before creating any test leaf. The
            // controller also checks both views outside the package first.
            if (write)
                foreach (RegistryView view in new[] { RegistryView.Registry32, RegistryView.Registry64 })
                    using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, view))
                        foreach (string parent in Parents)
                            using (RegistryKey key = root.OpenSubKey(parent + Host))
                                if (key != null) return 4;
            var observed = new StringBuilder();
            foreach (RegistryView view in new[] { RegistryView.Registry32, RegistryView.Registry64 })
                using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, view))
                    foreach (string parent in Parents)
                    {
                        if (write)
                        {
                            // The two registry views may share this HKCU key.
                            // A matching leaf from the first view is acceptable;
                            // foreign values or extra contents are never replaced.
                            using (RegistryKey existing = root.OpenSubKey(parent + Host))
                                if (existing != null && !Matches(existing)) return 4;
                            using (RegistryKey key = root.CreateSubKey(parent + Host))
                                key.SetValue("", Marker, RegistryValueKind.String);
                        }
                        using (RegistryKey key = root.OpenSubKey(parent + Host))
                        {
                            if (observed.Length != 0) observed.Append(',');
                            observed.Append(Matches(key) ? "true" : "false");
                        }
                    }
            Console.WriteLine("{\"schemaVersion\":1,\"packageIdentityVerified\":true,\"matches\":[" + observed + "]}");
            return 0;
        }
        // Fixed exit codes only. No raw paths, identities, or exception text.
        catch { return 5; }
    }
}
