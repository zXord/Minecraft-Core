using System.Buffers.Binary;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using MinecraftCore.ArchiveWorker.Protocol;
using MinecraftCore.ArchiveWorker.Security;

namespace MinecraftCore.ArchiveWorker.Sandbox;

internal sealed class AclLease : IDisposable
{
    private const string MutexName = @"Local\MinecraftCore.ArchiveWorker.AclLeases.v1";
    private const int MaximumJournalBytes = 1024 * 1024;
    private const int MaximumFrameBytes = 32 * 1024;
    private static readonly byte[] JournalMagic = "AWACL1\0"u8.ToArray();
    private static readonly HashSet<uint> AllowedMasks =
    [
        NativeMethods.GenericRead,
        NativeMethods.GenericRead | NativeMethods.GenericExecute,
        NativeMethods.FileTraverse,
        NativeMethods.GenericRead | NativeMethods.FileTraverse,
        NativeMethods.GenericRead | NativeMethods.GenericWrite | NativeMethods.FileTraverse,
        NativeMethods.GenericRead | NativeMethods.GenericWrite | NativeMethods.GenericExecute,
        NativeMethods.GenericRead | NativeMethods.GenericWrite | NativeMethods.GenericExecute | NativeMethods.Delete
    ];

    private readonly string appOwnedRoot;
    private readonly string operationsRoot;
    private readonly string journalDirectory;
    private readonly string journalPath;
    private readonly string leaseId;
    private readonly nint sid;
    private readonly string stringSid;
    private readonly AclProcessIdentity owner;
    private readonly List<AclGrantRecord> grants = [];
    private readonly List<AclProcessIdentity> children = [];
    private FileStream? journalStream;
    private bool preserved;
    private bool completed;

    private AclLease(string root, string operations, string journals, string id, nint sidValue, string sidText,
        string path, FileStream stream, AclProcessIdentity ownerIdentity)
    {
        appOwnedRoot = root;
        operationsRoot = operations;
        journalDirectory = journals;
        leaseId = id;
        sid = sidValue;
        stringSid = sidText;
        journalPath = path;
        journalStream = stream;
        owner = ownerIdentity;
    }

    internal static AclLease Begin(string appOwnedRootValue, string leaseId, nint sid)
    {
        string root = CanonicalPaths.ExistingDirectory(appOwnedRootValue);
        if (!IsJournalIdentifier(leaseId)) throw new InvalidDataException("ACL lease identifier invalid");
        string operations = EnsureChild(root, "operations");
        string operation = Path.Combine(operations, leaseId);
        _ = CanonicalPaths.RequireWithin(operations, operation, file: false);
        string journals = EnsureChild(root, "acl-leases");
        string sidText = SidToString(sid);
        AclProcessIdentity owner = ProcessIdentity.Current();

        using (NamedMutexScope.Enter(MutexName))
        {
            RecoverStale(root, operations, journals, sid, sidText);
            string journalPath = Path.Combine(journals, $"{leaseId}.lease");
            if (File.Exists(journalPath) || Directory.Exists(journalPath)) throw new InvalidDataException("ACL lease already exists");
            FileStream? stream = null;
            try
            {
                stream = new FileStream(journalPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read, 4096, FileOptions.WriteThrough);
                stream.Write(JournalMagic);
                var result = new AclLease(root, operations, journals, leaseId, sid, sidText, journalPath, stream, owner);
                result.AppendFrame(new AclLeaseJournalFrame { Type = "header", Schema = 1, LeaseId = leaseId, Process = owner });
                FlushDirectory(journals);
                return result;
            }
            catch
            {
                stream?.Dispose();
                TryDeleteFile(journalPath);
                throw;
            }
        }
    }

    internal static void RecoverBeforeProfileReset(string appOwnedRootValue, nint sid)
    {
        string root = CanonicalPaths.ExistingDirectory(appOwnedRootValue);
        string operations = EnsureChild(root, "operations");
        string journals = EnsureChild(root, "acl-leases");
        string sidText = SidToString(sid);
        using (NamedMutexScope.Enter(MutexName)) RecoverStale(root, operations, journals, sid, sidText);
    }

    internal void GrantReadExecuteFile(string file) => Grant(file, NativeMethods.GenericRead | NativeMethods.GenericExecute, directory: false, inherit: false);
    internal void GrantReadFile(string file) => Grant(file, NativeMethods.GenericRead, directory: false, inherit: false);
    internal void GrantTraverseDirectory(string directory) => Grant(directory, NativeMethods.FileTraverse, directory: true, inherit: false);
    internal void GrantReadTraverseDirectory(string directory) => Grant(directory, NativeMethods.GenericRead | NativeMethods.FileTraverse, directory: true, inherit: false);
    internal void GrantReadDirectory(string directory) => Grant(directory, NativeMethods.GenericRead, directory: true, inherit: true);
    internal void GrantReadWriteDirectory(string directory) => Grant(directory, NativeMethods.GenericRead | NativeMethods.GenericWrite | NativeMethods.FileTraverse, directory: true, inherit: true);
    internal void GrantBundleDirectory(string directory) => Grant(directory,
        NativeMethods.GenericRead | NativeMethods.GenericWrite | NativeMethods.GenericExecute | NativeMethods.Delete, directory: true, inherit: true);

    internal void RegisterChild(nint processHandle, uint processId)
    {
        ThrowIfUnavailable();
        AclProcessIdentity identity = ProcessIdentity.FromHandle(processHandle, processId);
        using (NamedMutexScope.Enter(MutexName))
        {
            VerifyActiveJournal();
            if (children.Any(value => value.ProcessId == identity.ProcessId && value.ProcessStartTimeUtcTicks == identity.ProcessStartTimeUtcTicks))
                throw new InvalidDataException("Sandbox child identity repeated");
            if (children.Count >= 16) throw new InvalidDataException("Sandbox child identity limit exceeded");
            AppendFrame(new AclLeaseJournalFrame { Type = "child", Process = identity });
            children.Add(identity);
        }
    }

    internal bool Complete(params string[] freshOutputRoots)
    {
        ThrowIfUnavailable();
        using (NamedMutexScope.Enter(MutexName))
        {
            VerifyActiveJournal();
            string[] registeredTrees = grants.Where(record => record.ScrubDescendants).Select(record => record.Path!)
                .Concat(freshOutputRoots).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            AclCompletionPolicy.Complete(registeredTrees, CleanupDirectGrants, ScrubFreshTree, CloseAndDeleteJournal, grants.Clear);
            completed = true;
            return true;
        }
    }

    internal void PreserveForRecovery() => preserved = true;

    private void Grant(string value, uint mask, bool directory, bool inherit)
    {
        ThrowIfUnavailable();
        mask = AclAccessMaskPolicy.MapFile(mask);
        string canonical = directory ? CanonicalPaths.RequireWithin(operationsRoot, value, file: false) : CanonicalPaths.RequireWithin(operationsRoot, value, file: true);
        byte flags = directory && inherit ? checked((byte)(NativeMethods.ObjectInheritAce | NativeMethods.ContainerInheritAce)) : (byte)0;
        if (inherit && Directory.EnumerateFileSystemEntries(canonical).Any()) throw new InvalidDataException("Fresh inheritable ACL directory must be empty");
        using (NamedMutexScope.Enter(MutexName))
        {
            VerifyActiveJournal();
            AclObjectIdentity identity = AclObjectIdentity.Capture(canonical, directory);
            int baseline = ExactAcl.Count(canonical, sid, mask, flags);
            var record = NewGrantRecord(canonical, mask, flags, baseline, directory, identity, scrubDescendants: inherit);
            AppendFrame(new AclLeaseJournalFrame { Type = "grant", Grant = record });
            grants.Add(record);
            ExactAcl.Append(canonical, sid, mask, flags);
            if (ExactAcl.Count(canonical, sid, mask, flags) != baseline + 1) throw new IOException("ACL grant verification failed");
        }
    }

    private void CleanupDirectGrants()
    {
        for (int index = grants.Count - 1; index >= 0; index--)
        {
            AclGrantRecord record = grants[index];
            CleanupRecord(record);
        }
    }

    private void ScrubFreshTree(string rootValue)
    {
        ScrubTree(rootValue, sid, appOwnedRoot, operationsRoot, leaseId, stringSid);
    }

    private static void ScrubTree(string rootValue, nint sid, string appOwnedRoot, string operationsRoot, string leaseId, string stringSid)
    {
        string root = CanonicalPaths.RequireWithin(operationsRoot, rootValue, file: false);
        string rootRelative = Path.GetRelativePath(appOwnedRoot, root);
        if (rootRelative == ".." || rootRelative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) || Path.IsPathRooted(rootRelative) ||
            !string.Equals(Path.GetRelativePath(operationsRoot, root).Split(Path.DirectorySeparatorChar, 2)[0], leaseId, StringComparison.Ordinal))
            throw new InvalidDataException("ACL scrub tree escaped lease");
        _ = stringSid;
        CanonicalPaths.RejectReparseTree(root);
        string[] entries = Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories)
            .OrderBy(value => value.Count(character => character == Path.DirectorySeparatorChar))
            .ThenBy(value => value, StringComparer.Ordinal)
            .ToArray();
        foreach (string entry in entries)
        {
            bool directory = Directory.Exists(entry);
            string canonical = CanonicalPaths.RequireWithin(root, entry, file: !directory);
            foreach ((uint mask, byte flags, int count) in ExactAcl.DescribeAllows(canonical, sid))
            {
                if (count < 1) continue;
                if (!ValidAceFlags(flags)) throw new InvalidDataException("ACL scrub flags invalid");
                _ = ParseMask(mask.ToString(CultureInfo.InvariantCulture));
                ExactAcl.RemoveToBaseline(canonical, sid, mask, flags, 0);
            }
            if (ExactAcl.DescribeAllows(canonical, sid).Count != 0) throw new IOException("Published output ACL scrub failed");
        }
    }

    private AclGrantRecord NewGrantRecord(string path, uint mask, byte flags, int baseline, bool directory, AclObjectIdentity identity, bool scrubDescendants) => new()
    {
        Path = path,
        Sid = stringSid,
        AccessMask = mask.ToString(CultureInfo.InvariantCulture),
        AceFlags = flags,
        BaselineExactCount = baseline,
        Directory = directory,
        VolumeSerialNumber = identity.VolumeSerialNumber.ToString(CultureInfo.InvariantCulture),
        FileIndex = identity.FileIndex.ToString(CultureInfo.InvariantCulture),
        ScrubDescendants = scrubDescendants
    };

    private void CleanupRecord(AclGrantRecord record)
    {
        string path = ValidateGrantRecord(record, appOwnedRoot, operationsRoot, leaseId, stringSid);
        bool exists = record.Directory ? Directory.Exists(path) : File.Exists(path);
        if (!exists)
        {
            if (File.Exists(path) || Directory.Exists(path)) throw new InvalidDataException("ACL journal object type changed");
            return;
        }
        AclObjectIdentity expected = ParseIdentity(record);
        if (AclObjectIdentity.Capture(path, record.Directory) != expected) throw new InvalidDataException("ACL journal object identity changed");
        uint mask = ParseMask(record.AccessMask!);
        byte flags = checked((byte)record.AceFlags);
        ExactAcl.RemoveToBaseline(path, sid, mask, flags, record.BaselineExactCount);
    }

    private void VerifyActiveJournal()
    {
        FileStream stream = journalStream ?? throw new ObjectDisposedException(nameof(AclLease));
        ParsedJournal parsed = ReadJournal(stream, journalPath, appOwnedRoot, operationsRoot, stringSid);
        if (parsed.LeaseId != leaseId || !SameIdentity(parsed.Owner, owner) || parsed.Grants.Count != grants.Count || parsed.Children.Count != children.Count)
            throw new InvalidDataException("ACL lease journal changed");
        for (int index = 0; index < grants.Count; index++)
        {
            if (!GrantEquals(parsed.Grants[index], grants[index])) throw new InvalidDataException("ACL lease journal changed");
        }
        for (int index = 0; index < children.Count; index++)
        {
            if (!SameIdentity(parsed.Children[index], children[index])) throw new InvalidDataException("ACL lease journal changed");
        }
        stream.Seek(0, SeekOrigin.End);
    }

    private void AppendFrame(AclLeaseJournalFrame frame)
    {
        FileStream stream = journalStream ?? throw new ObjectDisposedException(nameof(AclLease));
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(frame, WorkerJsonContext.Default.AclLeaseJournalFrame);
        if (body.Length is < 2 or > MaximumFrameBytes) throw new InvalidDataException("ACL journal frame size invalid");
        byte[] prefix = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(prefix, checked((uint)body.Length));
        byte[] digest = SHA256.HashData(body);
        stream.Seek(0, SeekOrigin.End);
        stream.Write(prefix);
        stream.Write(body);
        stream.Write(digest);
        stream.Flush(flushToDisk: true);
        CryptographicOperations.ZeroMemory(digest);
        if (stream.Length > MaximumJournalBytes) throw new InvalidDataException("ACL journal size exceeded");
    }

    private void CloseAndDeleteJournal()
    {
        FileStream? stream = Interlocked.Exchange(ref journalStream, null);
        stream?.Dispose();
        File.Delete(journalPath);
        FlushDirectory(journalDirectory);
    }

    private static void RecoverStale(string appOwnedRoot, string operationsRoot, string journalDirectory, nint sid, string stringSid)
    {
        foreach (string entry in Directory.EnumerateFileSystemEntries(journalDirectory).Order(StringComparer.Ordinal))
        {
            if (Directory.Exists(entry) || !string.Equals(Path.GetExtension(entry), ".lease", StringComparison.Ordinal) || !IsJournalIdentifier(Path.GetFileNameWithoutExtension(entry)))
                throw new InvalidDataException("ACL journal directory contains an unexpected entry");
            string path = CanonicalPaths.RequireWithin(journalDirectory, entry, file: true);
            FileStream stream;
            try
            {
                stream = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.Read, 4096, FileOptions.WriteThrough);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                throw new IOException("ACL journal ownership is inaccessible or active", exception);
            }
            using (stream)
            {
                ParsedJournal parsed = ReadJournal(stream, path, appOwnedRoot, operationsRoot, stringSid);
                if (!AclRecoveryPolicy.CanReclaim(ProcessIdentity.State(parsed.Owner), parsed.Children.Select(ProcessIdentity.State)))
                    throw new IOException("ACL journal owner or child is live or ambiguous");
                for (int index = parsed.Grants.Count - 1; index >= 0; index--)
                {
                    AclGrantRecord record = parsed.Grants[index];
                    string target = ValidateGrantRecord(record, appOwnedRoot, operationsRoot, parsed.LeaseId, stringSid);
                    bool exists = record.Directory ? Directory.Exists(target) : File.Exists(target);
                    if (!exists)
                    {
                        if (File.Exists(target) || Directory.Exists(target)) throw new InvalidDataException("ACL recovery object type changed");
                        continue;
                    }
                    if (AclObjectIdentity.Capture(target, record.Directory) != ParseIdentity(record)) throw new InvalidDataException("ACL recovery object identity changed");
                    ExactAcl.RemoveToBaseline(target, sid, ParseMask(record.AccessMask!), checked((byte)record.AceFlags), record.BaselineExactCount);
                }
                foreach (AclGrantRecord tree in parsed.Grants.Where(record => record.ScrubDescendants).DistinctBy(record => record.Path, StringComparer.OrdinalIgnoreCase))
                {
                    string treePath = ValidateGrantRecord(tree, appOwnedRoot, operationsRoot, parsed.LeaseId, stringSid);
                    if (!Directory.Exists(treePath)) continue;
                    if (AclObjectIdentity.Capture(treePath, directory: true) != ParseIdentity(tree)) throw new InvalidDataException("ACL recovery tree identity changed");
                    ScrubTree(treePath, sid, appOwnedRoot, operationsRoot, parsed.LeaseId, stringSid);
                }
            }
            File.Delete(path);
            FlushDirectory(journalDirectory);
        }
    }

    private static ParsedJournal ReadJournal(Stream stream, string journalPath, string appOwnedRoot, string operationsRoot, string expectedSid)
    {
        if (stream.Length is < 1 or > MaximumJournalBytes) throw new InvalidDataException("ACL journal length invalid");
        stream.Position = 0;
        byte[] bytes = new byte[checked((int)stream.Length)];
        int offset = 0;
        while (offset < bytes.Length)
        {
            int read = stream.Read(bytes, offset, bytes.Length - offset);
            if (read == 0) break;
            offset += read;
        }
        if (offset != bytes.Length || bytes.Length < JournalMagic.Length || !bytes.AsSpan(0, JournalMagic.Length).SequenceEqual(JournalMagic))
            throw new InvalidDataException("ACL journal header invalid");
        int cursor = JournalMagic.Length;
        var frames = new List<AclLeaseJournalFrame>();
        while (cursor < bytes.Length)
        {
            if (bytes.Length - cursor < 4) break;
            uint length = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(cursor, 4));
            if (length is < 2 or > MaximumFrameBytes) throw new InvalidDataException("ACL journal frame length invalid");
            int frameLength = checked(4 + (int)length + 32);
            if (bytes.Length - cursor < frameLength) break;
            ReadOnlySpan<byte> body = bytes.AsSpan(cursor + 4, (int)length);
            ReadOnlySpan<byte> storedDigest = bytes.AsSpan(cursor + 4 + (int)length, 32);
            byte[] actualDigest = SHA256.HashData(body);
            try
            {
                if (!CryptographicOperations.FixedTimeEquals(actualDigest, storedDigest)) throw new InvalidDataException("ACL journal authentication failed");
            }
            finally { CryptographicOperations.ZeroMemory(actualDigest); }
            FrameReader.ValidateStrictJson(body);
            frames.Add(JsonSerializer.Deserialize(body, WorkerJsonContext.Default.AclLeaseJournalFrame) ?? throw new InvalidDataException("ACL journal frame missing"));
            cursor += frameLength;
        }
        CryptographicOperations.ZeroMemory(bytes);
        if (frames.Count == 0) throw new InvalidDataException("ACL journal is incomplete");
        string fileLeaseId = Path.GetFileNameWithoutExtension(journalPath);
        AclLeaseJournalFrame header = frames[0];
        if (header.Type != "header" || header.Schema != 1 || header.LeaseId != fileLeaseId || header.Process is null || header.Grant is not null || !ValidProcessIdentity(header.Process))
            throw new InvalidDataException("ACL journal owner invalid");
        var grants = new List<AclGrantRecord>();
        var children = new List<AclProcessIdentity>();
        foreach (AclLeaseJournalFrame frame in frames.Skip(1))
        {
            if (frame.Type == "grant" && frame.Schema is null && frame.LeaseId is null && frame.Process is null && frame.Grant is not null)
            {
                _ = ValidateGrantRecord(frame.Grant, appOwnedRoot, operationsRoot, fileLeaseId, expectedSid);
                grants.Add(frame.Grant);
                if (grants.Count > 4096) throw new InvalidDataException("ACL journal grant limit exceeded");
                continue;
            }
            if (frame.Type == "child" && frame.Schema is null && frame.LeaseId is null && frame.Process is not null && frame.Grant is null && ValidProcessIdentity(frame.Process))
            {
                if (children.Any(child => SameIdentity(child, frame.Process))) throw new InvalidDataException("ACL journal child repeated");
                children.Add(frame.Process);
                if (children.Count > 16) throw new InvalidDataException("ACL journal child limit exceeded");
                continue;
            }
            throw new InvalidDataException("ACL journal frame shape invalid");
        }
        return new ParsedJournal(fileLeaseId, header.Process, grants, children);
    }

    private static string ValidateGrantRecord(AclGrantRecord record, string appOwnedRoot, string operationsRoot, string leaseId, string expectedSid)
    {
        if (record.Path is null || record.Sid != expectedSid || record.AccessMask is null || record.VolumeSerialNumber is null || record.FileIndex is null ||
            record.BaselineExactCount is < 0 or > 4096 || record.AceFlags is not (0 or 1 or 2 or 3 or 16 or 17 or 18 or 19) ||
            (record.ScrubDescendants && (!record.Directory || record.AceFlags != 3)))
            throw new InvalidDataException("ACL journal grant invalid");
        _ = ParseMask(record.AccessMask);
        _ = ParseIdentity(record);
        string full = Path.GetFullPath(record.Path);
        string relative = Path.GetRelativePath(operationsRoot, full);
        string[] components = relative.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
        if (components.Length < 2 || !string.Equals(components[0], leaseId, StringComparison.Ordinal) || components.Any(component => !CanonicalPaths.IsSafeWindowsComponent(component)) ||
            relative == ".." || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) || Path.IsPathRooted(relative))
            throw new InvalidDataException("ACL journal path escaped operation");
        string rootRelative = Path.GetRelativePath(appOwnedRoot, full);
        if (rootRelative == ".." || rootRelative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) || Path.IsPathRooted(rootRelative))
            throw new InvalidDataException("ACL journal path escaped root");
        return full;
    }

    private static uint ParseMask(string value)
    {
        const uint mappedFileRights = 0x001201bf | NativeMethods.Delete;
        const uint allowedGenericRights = NativeMethods.GenericRead | NativeMethods.GenericWrite | NativeMethods.GenericExecute;
        if (!uint.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out uint mask) || mask == 0 ||
            (!AllowedMasks.Contains(mask) && (mask & ~(mappedFileRights | allowedGenericRights)) != 0))
            throw new InvalidDataException("ACL journal mask invalid");
        return mask;
    }

    private static bool ValidAceFlags(int value) => value is 0 or 1 or 2 or 3 or 16 or 17 or 18 or 19;

    private static AclObjectIdentity ParseIdentity(AclGrantRecord record)
    {
        if (!uint.TryParse(record.VolumeSerialNumber, NumberStyles.None, CultureInfo.InvariantCulture, out uint volume) ||
            !ulong.TryParse(record.FileIndex, NumberStyles.None, CultureInfo.InvariantCulture, out ulong index) || index == 0)
            throw new InvalidDataException("ACL journal object identity invalid");
        return new AclObjectIdentity(volume, index);
    }

    private static bool GrantEquals(AclGrantRecord left, AclGrantRecord right) => left.Path == right.Path && left.Sid == right.Sid &&
        left.AccessMask == right.AccessMask && left.AceFlags == right.AceFlags && left.BaselineExactCount == right.BaselineExactCount &&
        left.Directory == right.Directory && left.VolumeSerialNumber == right.VolumeSerialNumber && left.FileIndex == right.FileIndex &&
        left.ScrubDescendants == right.ScrubDescendants;

    private static bool ValidProcessIdentity(AclProcessIdentity value) => value.ProcessId > 0 && value.ProcessStartTimeUtcTicks > 0;
    private static bool SameIdentity(AclProcessIdentity left, AclProcessIdentity right) => left.ProcessId == right.ProcessId && left.ProcessStartTimeUtcTicks == right.ProcessStartTimeUtcTicks;
    private static bool IsJournalIdentifier(string value) => value.Length is >= 1 and <= 128 && CanonicalPaths.IsSafeWindowsComponent(value) && value.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-');

    private static string EnsureChild(string root, string name)
    {
        string child = Path.Combine(root, name);
        Directory.CreateDirectory(child);
        return CanonicalPaths.RequireWithin(root, child, file: false);
    }

    private static string SidToString(nint sid)
    {
        if (!NativeMethods.ConvertSidToStringSid(sid, out nint value) || value == nint.Zero) throw new IOException("AppContainer SID conversion failed", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        try { return Marshal.PtrToStringUni(value) ?? throw new InvalidDataException("AppContainer SID invalid"); }
        finally { _ = NativeMethods.LocalFree(value); }
    }

    private static void FlushDirectory(string directory)
    {
        nint handle = NativeMethods.CreateFile(NativeFilePath.ForApi(directory), NativeMethods.GenericWrite,
            NativeMethods.FileShareRead | NativeMethods.FileShareWrite | NativeMethods.FileShareDelete, nint.Zero,
            NativeMethods.OpenExisting, NativeMethods.FileFlagBackupSemantics, nint.Zero);
        if (handle == NativeMethods.InvalidHandleValue) throw new IOException("ACL journal directory open failed", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        try
        {
            if (!NativeMethods.FlushFileBuffers(handle)) throw new IOException("ACL journal directory flush failed", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        }
        finally { _ = NativeMethods.CloseHandle(handle); }
    }

    private static void TryDeleteFile(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }

    private void ThrowIfUnavailable()
    {
        if (completed || preserved || journalStream is null) throw new InvalidOperationException("ACL lease is unavailable");
    }

    public void Dispose()
    {
        if (completed || preserved) return;
        _ = Complete();
    }

    private sealed record ParsedJournal(string LeaseId, AclProcessIdentity Owner, List<AclGrantRecord> Grants, List<AclProcessIdentity> Children);
}

internal readonly record struct AclObjectIdentity(uint VolumeSerialNumber, ulong FileIndex)
{
    internal static AclObjectIdentity Capture(string path, bool directory)
    {
        string canonical = directory ? CanonicalPaths.ExistingDirectory(path) : CanonicalPaths.ExistingFile(path);
        nint handle = NativeMethods.CreateFile(NativeFilePath.ForApi(canonical), NativeMethods.FileReadAttributes,
            NativeMethods.FileShareRead | NativeMethods.FileShareWrite | NativeMethods.FileShareDelete, nint.Zero,
            NativeMethods.OpenExisting, directory ? NativeMethods.FileFlagBackupSemantics : 0, nint.Zero);
        if (handle == NativeMethods.InvalidHandleValue) throw new IOException("ACL object identity open failed", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        try
        {
            if (!NativeMethods.GetFileInformationByHandle(handle, out NativeMethods.ByHandleFileInformation information))
                throw new IOException("ACL object identity unavailable", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
            ulong index = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
            if (index == 0) throw new InvalidDataException("ACL object identity invalid");
            return new AclObjectIdentity(information.VolumeSerialNumber, index);
        }
        finally { _ = NativeMethods.CloseHandle(handle); }
    }
}

internal static class ProcessIdentity
{
    internal static AclProcessIdentity Current() => FromHandle(NativeMethods.GetCurrentProcess(), checked((uint)Environment.ProcessId));

    internal static AclProcessIdentity FromHandle(nint process, uint processId)
    {
        if (process == nint.Zero || !NativeMethods.GetProcessTimes(process, out NativeMethods.FileTime creation, out _, out _, out _))
            throw new IOException("Process creation identity unavailable", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        ulong fileTime = ((ulong)creation.HighDateTime << 32) | creation.LowDateTime;
        long ticks = DateTime.FromFileTimeUtc(checked((long)fileTime)).Ticks;
        return new AclProcessIdentity { ProcessId = checked((int)processId), ProcessStartTimeUtcTicks = ticks };
    }

    internal static ProcessIdentityState State(AclProcessIdentity identity)
    {
        if (identity.ProcessId <= 0 || identity.ProcessStartTimeUtcTicks <= 0) return ProcessIdentityState.Ambiguous;
        nint process = NativeMethods.OpenProcess(NativeMethods.ProcessQueryLimitedInformation | NativeMethods.Synchronize, false, checked((uint)identity.ProcessId));
        if (process == nint.Zero)
        {
            return Marshal.GetLastWin32Error() == NativeMethods.ErrorInvalidParameter ? ProcessIdentityState.Exited : ProcessIdentityState.Ambiguous;
        }
        try
        {
            uint wait = NativeMethods.WaitForSingleObject(process, 0);
            if (wait == NativeMethods.WaitObject0) return ProcessIdentityState.Exited;
            if (wait != NativeMethods.WaitTimeout) return ProcessIdentityState.Ambiguous;
            AclProcessIdentity current = FromHandle(process, checked((uint)identity.ProcessId));
            return current.ProcessStartTimeUtcTicks == identity.ProcessStartTimeUtcTicks ? ProcessIdentityState.Live : ProcessIdentityState.Exited;
        }
        catch { return ProcessIdentityState.Ambiguous; }
        finally { _ = NativeMethods.CloseHandle(process); }
    }
}

internal static class ExactAcl
{
    internal static int Count(string path, nint sid, uint mask, byte flags)
    {
        using DaclSnapshot snapshot = DaclSnapshot.Open(path);
        int count = 0;
        for (uint index = 0; index < snapshot.Information.AceCount; index++)
        {
            nint ace = snapshot.GetAce(index);
            if (Matches(ace, sid, mask, flags)) count++;
        }
        return count;
    }

    internal static IReadOnlyList<(uint Mask, byte Flags, int Count)> DescribeAllows(string path, nint sid)
    {
        using DaclSnapshot snapshot = DaclSnapshot.Open(path);
        var counts = new Dictionary<(uint Mask, byte Flags), int>();
        for (uint index = 0; index < snapshot.Information.AceCount; index++)
        {
            nint ace = snapshot.GetAce(index);
            if (Marshal.ReadByte(ace) != NativeMethods.AccessAllowedAceType || !NativeMethods.EqualSid(nint.Add(ace, 8), sid)) continue;
            var key = (unchecked((uint)Marshal.ReadInt32(ace, 4)), Marshal.ReadByte(ace, 1));
            counts[key] = counts.GetValueOrDefault(key) + 1;
        }
        return counts.Select(value => (value.Key.Mask, value.Key.Flags, value.Value)).ToArray();
    }

    internal static void Append(string path, nint sid, uint mask, byte flags)
    {
        using DaclSnapshot snapshot = DaclSnapshot.Open(path);
        uint sidLength = NativeMethods.GetLengthSid(sid);
        if (sidLength == 0) throw new IOException("ACL SID length unavailable", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        uint newSize = checked(snapshot.Information.AclBytesInUse + 8 + sidLength);
        nint acl = Marshal.AllocHGlobal(checked((int)newSize));
        try
        {
            if (!NativeMethods.InitializeAcl(acl, newSize, NativeMethods.AclRevision)) ThrowLastAclError("ACL initialization failed");
            bool inserted = false;
            for (uint index = 0; index < snapshot.Information.AceCount; index++)
            {
                nint ace = snapshot.GetAce(index);
                if (!inserted && (Marshal.ReadByte(ace, 1) & NativeMethods.InheritedAce) != 0)
                {
                    AddAllow(acl, sid, mask, flags);
                    inserted = true;
                }
                CopyAce(acl, ace);
            }
            if (!inserted) AddAllow(acl, sid, mask, flags);
            Set(path, acl);
        }
        finally { Marshal.FreeHGlobal(acl); }
    }

    internal static void RemoveToBaseline(string path, nint sid, uint mask, byte flags, int baseline)
    {
        while (true)
        {
            using DaclSnapshot snapshot = DaclSnapshot.Open(path);
            int count = 0;
            int removeIndex = -1;
            for (uint index = 0; index < snapshot.Information.AceCount; index++)
            {
                if (!Matches(snapshot.GetAce(index), sid, mask, flags)) continue;
                count++;
                removeIndex = checked((int)index);
            }
            if (AclRecoveryPolicy.ExcessExactAceCount(count, baseline) == 0) return;
            nint acl = Marshal.AllocHGlobal(checked((int)snapshot.Information.AclBytesInUse));
            try
            {
                if (!NativeMethods.InitializeAcl(acl, snapshot.Information.AclBytesInUse, NativeMethods.AclRevision)) ThrowLastAclError("ACL initialization failed");
                for (uint index = 0; index < snapshot.Information.AceCount; index++)
                {
                    if (index != removeIndex) CopyAce(acl, snapshot.GetAce(index));
                }
                Set(path, acl);
            }
            finally { Marshal.FreeHGlobal(acl); }
        }
    }

    private static bool Matches(nint ace, nint sid, uint mask, byte flags) => Marshal.ReadByte(ace) == NativeMethods.AccessAllowedAceType &&
        Marshal.ReadByte(ace, 1) == flags && unchecked((uint)Marshal.ReadInt32(ace, 4)) == mask && NativeMethods.EqualSid(nint.Add(ace, 8), sid);

    private static void AddAllow(nint acl, nint sid, uint mask, byte flags)
    {
        if (!NativeMethods.AddAccessAllowedAceEx(acl, NativeMethods.AclRevision, flags, mask, sid)) ThrowLastAclError("ACL allow entry failed");
    }

    private static void CopyAce(nint acl, nint ace)
    {
        ushort size = unchecked((ushort)Marshal.ReadInt16(ace, 2));
        if (size < 4 || !NativeMethods.AddAce(acl, NativeMethods.AclRevision, uint.MaxValue, ace, size)) ThrowLastAclError("ACL entry copy failed");
    }

    private static void Set(string path, nint acl)
    {
        uint result = NativeMethods.SetNamedSecurityInfo(NativeFilePath.ForApi(path), NativeMethods.SeFileObject, NativeMethods.DaclSecurityInformation, nint.Zero, nint.Zero, acl, nint.Zero);
        if (result != 0) throw new IOException("ACL update failed", new System.ComponentModel.Win32Exception(checked((int)result)));
    }

    private static void ThrowLastAclError(string message) => throw new IOException(message, new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));

    private sealed class DaclSnapshot : IDisposable
    {
        private nint securityDescriptor;
        internal nint Dacl { get; }
        internal NativeMethods.AclSizeInformation Information { get; }

        private DaclSnapshot(nint descriptor, nint dacl, NativeMethods.AclSizeInformation information)
        {
            securityDescriptor = descriptor;
            Dacl = dacl;
            Information = information;
        }

        internal static DaclSnapshot Open(string path)
        {
            uint result = NativeMethods.GetNamedSecurityInfo(NativeFilePath.ForApi(path), NativeMethods.SeFileObject, NativeMethods.DaclSecurityInformation,
                out _, out _, out nint dacl, out _, out nint descriptor);
            if (result != 0 || descriptor == nint.Zero) throw new IOException("ACL read failed", new System.ComponentModel.Win32Exception(checked((int)result)));
            if (dacl == nint.Zero)
            {
                _ = NativeMethods.LocalFree(descriptor);
                throw new InvalidDataException("Null DACL rejected");
            }
            if (!NativeMethods.GetAclInformation(dacl, out NativeMethods.AclSizeInformation information,
                    checked((uint)Marshal.SizeOf<NativeMethods.AclSizeInformation>()), NativeMethods.AclSizeInformationClass))
            {
                _ = NativeMethods.LocalFree(descriptor);
                ThrowLastAclError("ACL metadata unavailable");
            }
            return new DaclSnapshot(descriptor, dacl, information);
        }

        internal nint GetAce(uint index)
        {
            if (!NativeMethods.GetAce(Dacl, index, out nint ace) || ace == nint.Zero) ThrowLastAclError("ACL entry unavailable");
            return ace;
        }

        public void Dispose()
        {
            nint value = Interlocked.Exchange(ref securityDescriptor, nint.Zero);
            if (value != nint.Zero) _ = NativeMethods.LocalFree(value);
        }
    }
}

internal static class AclLeaseTreeVerification
{
    internal static bool HasNoAllowForSid(string rootValue, nint sid)
    {
        string root = CanonicalPaths.ExistingDirectory(rootValue);
        CanonicalPaths.RejectReparseTree(root);
        foreach (string entry in Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories))
        {
            bool directory = Directory.Exists(entry);
            string canonical = CanonicalPaths.RequireWithin(root, entry, file: !directory);
            if (ExactAcl.DescribeAllows(canonical, sid).Count != 0) return false;
        }
        return ExactAcl.DescribeAllows(root, sid).Count == 0;
    }
}
