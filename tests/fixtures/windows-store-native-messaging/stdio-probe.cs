// Test-only fixed challenge. No profile, registry, endpoint, or network access.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

internal static class StdioProbe
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetCurrentPackageFullName(ref uint length, StringBuilder value);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int GetCurrentApplicationUserModelId(ref uint length, StringBuilder value);
    private delegate int Query(ref uint length, StringBuilder value);

    private static string Identity(Query query, int absentError)
    {
        uint length = 0;
        int status = query(ref length, null);
        if (status == absentError) return "";
        if (status != 122 || length == 0 || length > 4096) throw new InvalidOperationException();
        var buffer = new StringBuilder((int)length);
        if (query(ref length, buffer) != 0 || buffer.Length == 0) throw new InvalidOperationException();
        return buffer.ToString();
    }

    private static byte[] ReadExact(Stream stream, int count)
    {
        var bytes = new byte[count];
        for (int offset = 0; offset < count; )
        {
            int read = stream.Read(bytes, offset, count - offset);
            if (read == 0) throw new EndOfStreamException();
            offset += read;
        }
        return bytes;
    }

    private static string Bool(bool value) { return value ? "true" : "false"; }

    public static int Main(string[] args)
    {
        // Exit codes: 2 rejected request, 3 truncated/invalid UTF-8 or API failure,
        // 4 abandoned input. Never print raw arguments, identities, or exceptions.
        using (var timer = new Timer(delegate { Environment.Exit(4); }, null, 10000, Timeout.Infinite))
        {
            try
            {
                Stream input = Console.OpenStandardInput();
                uint count = BitConverter.ToUInt32(ReadExact(input, 4), 0);
                if (count == 0 || count > 256) return 2;
                string request = new UTF8Encoding(false, true).GetString(ReadExact(input, (int)count));
                // Deliberately accept only this public challenge and JSON whitespace.
                if (!Regex.IsMatch(request, "\\A[ \\t\\r\\n]*\\{[ \\t\\r\\n]*\"probe\"[ \\t\\r\\n]*:[ \\t\\r\\n]*\"motrix-store-p0\"[ \\t\\r\\n]*\\}[ \\t\\r\\n]*\\z")) return 2;
                // Only the documented absence codes mean there is no identity;
                // other query failures must not become successful diagnostics.
                string package = Identity(GetCurrentPackageFullName, 15700); // APPMODEL_ERROR_NO_PACKAGE
                string app = Identity(GetCurrentApplicationUserModelId, 15703); // APPMODEL_ERROR_NO_APPLICATION
                Match version = Regex.Match(package, "\\AMotrix\\.Store\\.P0_([0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+)_");
                // Caller shapes are observations only, never caller authentication.
                // In particular, the Firefox manifest argument is never opened.
                bool chromium = args.Length >= 1 && Regex.IsMatch(args[0], "\\Achrome-extension://[a-p]{32}/?\\z");
                bool firefox = args.Length == 2 && args[1] == "motrix-store-p0@motrix.invalid";
                string response = "{\"schemaVersion\":1,\"probe\":\"motrix-store-p0\",\"packageIdentityPresent\":" + Bool(package.Length > 0)
                    + ",\"expectedPackageName\":" + Bool(version.Success)
                    + ",\"packageVersion\":\"" + (version.Success ? version.Groups[1].Value : "") + "\""
                    + ",\"applicationIdentityPresent\":" + Bool(app.Length > 0)
                    + ",\"expectedHelperApplication\":" + Bool(app.EndsWith("!MotrixNativeHostP0", StringComparison.Ordinal))
                    + ",\"chromiumCallerShape\":" + Bool(chromium)
                    + ",\"firefoxTestCallerShape\":" + Bool(firefox) + "}";
                byte[] payload = Encoding.UTF8.GetBytes(response);
                Stream output = Console.OpenStandardOutput();
                output.Write(BitConverter.GetBytes((uint)payload.Length), 0, 4);
                output.Write(payload, 0, payload.Length);
                output.Flush();
                return 0;
            }
            catch { return 3; }
        }
    }
}
