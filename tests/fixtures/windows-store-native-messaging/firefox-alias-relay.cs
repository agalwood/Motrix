// Test-only ordinary PE entry point. It forwards one fixed challenge to the
// fixed package alias; it never opens profiles, manifests, endpoints or sockets.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class FirefoxAliasRelay
{
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int Size; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential)] private struct StartupInfo {
        public int Size; public IntPtr Reserved, Desktop, Title;
        public uint X, Y, Width, Height, CharsX, CharsY, Fill, Flags;
        public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] private struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags; public UIntPtr Minimum, Maximum;
        public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("shell32.dll", ExactSpelling = true)] private static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern IntPtr CreateJobObjectW(IntPtr security, string name);
    [DllImport("kernel32.dll", ExactSpelling = true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, uint size);
    [DllImport("kernel32.dll", ExactSpelling = true)] private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", ExactSpelling = true)] private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes security, uint size);
    [DllImport("kernel32.dll", ExactSpelling = true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", ExactSpelling = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", ExactSpelling = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr key, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll", ExactSpelling = true)] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", ExactSpelling = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", ExactSpelling = true)] private static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll", ExactSpelling = true)] private static extern bool CloseHandle(IntPtr handle);

    public static bool ValidArguments(string[] args) {
        // The manifest path is opaque and never read. Accept a local absolute
        // JSON path only; the extension ID is a test caller shape, not auth.
        return args != null && args.Length == 2 && args[1] == "motrix-store-p0@motrix.invalid"
            && args[0] != null && args[0].Length <= 4096
            && Regex.IsMatch(args[0], "\\A[A-Za-z]:\\\\[^\\x00-\\x1f<>\"|?*:]+\\.json\\z", RegexOptions.IgnoreCase)
            && !Regex.IsMatch(args[0], "(?:\\A|\\\\)\\.{1,2}(?:\\\\|\\z)");
    }
    public static string Quote(string value) {
        StringBuilder result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c); slashes = 0;
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }
    public static byte[] ReadFrame(Stream input, int maximum) {
        byte[] header = ReadExact(input, 4);
        uint length = BitConverter.ToUInt32(header, 0);
        if (length == 0 || length > maximum) throw new InvalidDataException();
        byte[] frame = new byte[length + 4]; Buffer.BlockCopy(header, 0, frame, 0, 4);
        Buffer.BlockCopy(ReadExact(input, (int)length), 0, frame, 4, (int)length); return frame;
    }
    private static byte[] ReadExact(Stream input, int count) {
        byte[] bytes = new byte[count]; int offset = 0;
        while (offset < count) { int read = input.Read(bytes, offset, count - offset); if (read == 0) throw new EndOfStreamException(); offset += read; }
        return bytes;
    }
    public static bool IsChallenge(byte[] frame) {
        try {
            return frame.Length >= 5 && frame.Length <= 260 && BitConverter.ToUInt32(frame, 0) == frame.Length - 4
                && Regex.IsMatch(new UTF8Encoding(false, true).GetString(frame, 4, frame.Length - 4), "\\A[ \\t\\r\\n]*\\{[ \\t\\r\\n]*\"probe\"[ \\t\\r\\n]*:[ \\t\\r\\n]*\"motrix-store-p0\"[ \\t\\r\\n]*\\}[ \\t\\r\\n]*\\z");
        } catch { return false; }
    }
    public static byte[] Capture(Stream input, int maximum) {
        using (MemoryStream result = new MemoryStream()) {
            byte[] bytes = new byte[256]; int read;
            while ((read = input.Read(bytes, 0, bytes.Length)) != 0) {
                if (result.Length + read > maximum) throw new InvalidDataException();
                result.Write(bytes, 0, read);
            }
            return result.ToArray();
        }
    }
    public static bool IsSingleReply(byte[] bytes) {
        try {
            if (bytes.Length < 5 || bytes.Length > 4100 || BitConverter.ToUInt32(bytes, 0) != bytes.Length - 4) return false;
            new UTF8Encoding(false, true).GetString(bytes, 4, bytes.Length - 4); return true;
        } catch { return false; }
    }
    private static void Require(bool ok) { if (!ok) throw new InvalidOperationException(); }
    private static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    private static FileStream OwnPipe(ref IntPtr handle, FileAccess access) {
        SafeFileHandle owned = new SafeFileHandle(handle, true); handle = IntPtr.Zero;
        try { return new FileStream(owned, access); } catch { owned.Dispose(); throw; }
    }
    private static string Alias() {
        Guid id = new Guid("F1B32785-6FBA-4FCF-9D55-7B8E7F157091"); IntPtr value;
        int status = SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out value);
        try {
            Require(status == 0 && value != IntPtr.Zero);
            string root = Marshal.PtrToStringUni(value);
            Require(!String.IsNullOrEmpty(root) && Path.IsPathRooted(root));
            return Path.Combine(root, "Microsoft", "WindowsApps", "motrix-store-p0-native-host.exe");
        } finally { if (value != IntPtr.Zero) Marshal.FreeCoTaskMem(value); }
    }
    private static int Forward(string[] args, byte[] challenge) {
        IntPtr job = IntPtr.Zero, inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero;
        IntPtr outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero, errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero, jobList = IntPtr.Zero;
        ProcessInfo child = new ProcessInfo(); bool initialized = false;
        try {
            string alias = Alias();
            // The noninherited job handle is owned exclusively by this relay.
            // Atomic job assignment at CreateProcess prevents an orphan window;
            // abnormal relay exit closes the handle and kills the child tree.
            job = CreateJobObjectW(IntPtr.Zero, null); Require(job != IntPtr.Zero);
            ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
            Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
            SecurityAttributes security = new SecurityAttributes(); security.Size = Marshal.SizeOf(typeof(SecurityAttributes)); security.Inherit = 1;
            Require(CreatePipe(out inputRead, out inputWrite, ref security, 0));
            Require(CreatePipe(out outputRead, out outputWrite, ref security, 0));
            Require(CreatePipe(out errorRead, out errorWrite, ref security, 0));
            Require(SetHandleInformation(inputWrite, 1, 0)); Require(SetHandleInformation(outputRead, 1, 0)); Require(SetHandleInformation(errorRead, 1, 0));
            IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            Require(size.ToInt64() > 0 && size.ToInt64() < 65536);
            attributes = Marshal.AllocHGlobal(size); Require(InitializeProcThreadAttributeList(attributes, 2, 0, ref size)); initialized = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handles, 0, inputRead); Marshal.WriteIntPtr(handles, IntPtr.Size, outputWrite); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, errorWrite);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
            jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            StartupInfoEx startup = new StartupInfoEx(); startup.Info.Size = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Info.Flags = 0x100; startup.Info.Input = inputRead; startup.Info.Output = outputWrite; startup.Info.Error = errorWrite; startup.Attributes = attributes;
            StringBuilder command = new StringBuilder(Quote(alias) + " " + Quote(args[0]) + " " + Quote(args[1]));
            Require(CreateProcessW(alias, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080000, IntPtr.Zero, Path.GetDirectoryName(alias), ref startup, out child));
            Close(ref child.Thread); Close(ref inputRead); Close(ref outputWrite); Close(ref errorWrite);
            using (FileStream output = OwnPipe(ref outputRead, FileAccess.Read))
            using (FileStream error = OwnPipe(ref errorRead, FileAccess.Read)) {
                Task<byte[]> stdout = Task.Factory.StartNew(() => Capture(output, 4100));
                Task<byte[]> stderr = Task.Factory.StartNew(() => Capture(error, 1024));
                using (FileStream input = OwnPipe(ref inputWrite, FileAccess.Write)) { input.Write(challenge, 0, challenge.Length); input.Flush(); }
                Require(WaitForSingleObject(child.Process, 8000) == 0);
                Require(Task.WaitAll(new Task[] { stdout, stderr }, 1000));
                uint code; Require(GetExitCodeProcess(child.Process, out code) && code == 0);
                Require(stderr.Result.Length == 0 && IsSingleReply(stdout.Result));
                Stream destination = Console.OpenStandardOutput(); destination.Write(stdout.Result, 0, stdout.Result.Length); destination.Flush();
            }
            return 0;
        } finally {
            if (job != IntPtr.Zero) TerminateJobObject(job, 3);
            if (child.Process != IntPtr.Zero) WaitForSingleObject(child.Process, 1000);
            Close(ref child.Thread); Close(ref child.Process); Close(ref job);
            Close(ref inputRead); Close(ref inputWrite); Close(ref outputRead); Close(ref outputWrite); Close(ref errorRead); Close(ref errorWrite);
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
        }
    }
    public static int Main(string[] args) {
        if (!ValidArguments(args)) return 2;
        // Process exit releases the sole job handle even if a pipe blocks.
        using (Timer timer = new Timer(delegate { Environment.Exit(4); }, null, 12000, Timeout.Infinite)) {
            try {
                if (Environment.OSVersion.Platform != PlatformID.Win32NT || IntPtr.Size != 8) return 3;
                byte[] challenge = ReadFrame(Console.OpenStandardInput(), 256);
                if (!IsChallenge(challenge)) return 2;
                return Forward(args, challenge);
            } catch { return 3; }
        }
    }
}
