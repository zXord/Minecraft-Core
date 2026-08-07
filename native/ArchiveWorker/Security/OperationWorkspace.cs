using System.Buffers.Binary;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using MinecraftCore.ArchiveWorker.Protocol;
using MinecraftCore.ArchiveWorker.Sandbox;

namespace MinecraftCore.ArchiveWorker.Security;

internal sealed class OperationWorkspace : IDisposable
{
    private const string MutexName = @"Local\MinecraftCore.ArchiveWorker.OperationLeases.v1";
    private const string JournalExtension = ".workspace";
    private const int JournalBodyBytes = 18;
    private const int JournalBytes = JournalBodyBytes + 32;
    private static readonly byte[] JournalMagic = "AWOP1\0"u8.ToArray();
    private readonly List<PinnedFile> sourcePins = [];
    private readonly List<PinnedFile> stagedPins = [];
    private readonly string operationsRoot;
    private readonly string journalDirectory;
    private readonly string journalPath;
    private readonly string leaseId;
    private FileStream? journalStream;
    private bool preserve;

    private OperationWorkspace(string root, string operations, string journals, string journal, FileStream stream, string id)
    {
        Root = root;
        operationsRoot = operations;
        journalDirectory = journals;
        journalPath = journal;
        journalStream = stream;
        leaseId = id;
        Input = CreateChild(root, "input");
        Output = CreateChild(root, "output");
        Scratch = CreateChild(root, "scratch");
        Bundle = CreateChild(root, "b");
        Engine = CreateChild(root, "engine");
        Probe = CreateChild(root, "probe");
    }

    internal string Root { get; }
    internal string Input { get; }
    internal string Output { get; }
    internal string Scratch { get; }
    internal string Bundle { get; }
    internal string Engine { get; }
    internal string Probe { get; }
    internal string? ArchivePath { get; private set; }
    internal IReadOnlyList<PinnedFile> StagedInputPins => stagedPins;

    internal static OperationWorkspace Create(string appOwnedRootValue, string leaseId)
    {
        string appOwnedRoot = CanonicalPaths.ExistingDirectory(appOwnedRootValue);
        if (!CanonicalPaths.IsSafeWindowsComponent(leaseId)) throw new InvalidDataException("Operation lease invalid");
        string operations = EnsureChild(appOwnedRoot, "operations");
        string journals = EnsureChild(appOwnedRoot, "operation-leases");
        using (NamedMutexScope.Enter(MutexName))
        {
            RecoverStale(operations, journals);
            string journalPath = Path.Combine(journals, $"{leaseId}{JournalExtension}");
            if (File.Exists(journalPath) || Directory.Exists(journalPath)) throw new InvalidDataException("Operation lease already exists");
            FileStream? stream = null;
            string root = Path.Combine(operations, leaseId);
            try
            {
                stream = new FileStream(journalPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read, 4096, FileOptions.WriteThrough);
                WriteJournal(stream, ProcessIdentity.Current());
                FlushDirectory(journals);
                if (File.Exists(root) || Directory.Exists(root)) throw new InvalidDataException("Operation lease already exists");
                Directory.CreateDirectory(root);
                root = CanonicalPaths.RequireWithin(operations, root, file: false);
                FlushDirectory(operations);
                return new OperationWorkspace(root, operations, journals, journalPath, stream, leaseId);
            }
            catch
            {
                stream?.Dispose();
                try { if (Directory.Exists(root)) Directory.Delete(root, recursive: true); } catch { }
                try { if (File.Exists(journalPath)) File.Delete(journalPath); } catch { }
                throw;
            }
        }
    }

    internal static void Recover(string appOwnedRootValue)
    {
        string appOwnedRoot = CanonicalPaths.ExistingDirectory(appOwnedRootValue);
        string operations = EnsureChild(appOwnedRoot, "operations");
        string journals = EnsureChild(appOwnedRoot, "operation-leases");
        using (NamedMutexScope.Enter(MutexName)) RecoverStale(operations, journals);
    }

    internal void StageInputs(string inputDirectoryValue, string archivePathValue, IReadOnlyList<WorkerInputPart> parts, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string inputDirectory = CanonicalPaths.ExistingDirectory(inputDirectoryValue);
        string sourceArchive = CanonicalPaths.RequireWithin(inputDirectory, archivePathValue, file: true);
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            foreach (WorkerInputPart part in parts)
            {
                cancellationToken.ThrowIfCancellationRequested();
                string source = CanonicalPaths.RequireWithin(inputDirectory, part.Path!, file: true);
                string name = Path.GetFileName(source);
                if (!CanonicalPaths.IsSafeWindowsComponent(name) || !names.Add(name)) throw new InvalidDataException("Input basename rejected");
                long size = long.Parse(part.Size!, NumberStyles.None, CultureInfo.InvariantCulture);
                PinnedFile sourcePin = PinnedFile.OpenVerified(source, size, part.Sha256!, part.Sha512!, cancellationToken);
                sourcePins.Add(sourcePin);
                string staged = Path.Combine(Input, name);
                sourcePin.CopyTo(staged, cancellationToken);
                PinnedFile stagedPin = PinnedFile.OpenVerified(staged, size, part.Sha256!, part.Sha512!, cancellationToken);
                stagedPins.Add(stagedPin);
                if (string.Equals(source, sourceArchive, StringComparison.OrdinalIgnoreCase)) ArchivePath = stagedPin.Path;
            }
            if (ArchivePath is null) throw new InvalidDataException("Primary input was not pinned");
            cancellationToken.ThrowIfCancellationRequested();
            foreach (PinnedFile pin in sourcePins) pin.Revalidate();
            foreach (PinnedFile pin in stagedPins) pin.Revalidate();
        }
        catch
        {
            DisposePins();
            throw;
        }
    }

    internal PinnedFile StageProbeExecutable(string sourceValue)
    {
        PinnedFile source = PinnedFile.OpenSnapshot(sourceValue);
        sourcePins.Add(source);
        string destination = Path.Combine(Probe, "ArchiveWorker.exe");
        source.CopyTo(destination);
        PinnedFile staged = PinnedFile.OpenSnapshot(destination);
        stagedPins.Add(staged);
        source.Revalidate();
        staged.Revalidate();
        return staged;
    }

    internal void PublishOutput(string destinationValue)
    {
        string destination = CanonicalPaths.ExistingDirectory(destinationValue);
        if (Directory.EnumerateFileSystemEntries(destination).Any()) throw new InvalidDataException("Output destination changed");
        CanonicalPaths.SameVolume(Output, destination);
        CanonicalPaths.RejectReparseTree(Output);
        foreach (string entry in Directory.EnumerateFileSystemEntries(Output))
        {
            string name = Path.GetFileName(entry);
            if (!CanonicalPaths.IsSafeWindowsComponent(name)) throw new InvalidDataException("Output name rejected");
            string target = Path.Combine(destination, name);
            if (Directory.Exists(entry)) Directory.Move(entry, target);
            else File.Move(entry, target);
        }
        if (Directory.EnumerateFileSystemEntries(Output).Any()) throw new IOException("Output publication incomplete");
    }

    internal void PreserveForRecovery() => preserve = true;

    private static string EnsureChild(string root, string name)
    {
        string child = Path.Combine(root, name);
        Directory.CreateDirectory(child);
        return CanonicalPaths.RequireWithin(root, child, file: false);
    }

    private static void WriteJournal(FileStream stream, AclProcessIdentity owner)
    {
        if (owner.ProcessId < 1 || owner.ProcessStartTimeUtcTicks < 1) throw new InvalidDataException("Operation owner invalid");
        byte[] bytes = new byte[JournalBytes];
        JournalMagic.CopyTo(bytes, 0);
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(JournalMagic.Length, 4), owner.ProcessId);
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(JournalMagic.Length + 4, 8), owner.ProcessStartTimeUtcTicks);
        SHA256.HashData(bytes.AsSpan(0, JournalBodyBytes)).CopyTo(bytes.AsSpan(JournalBodyBytes));
        stream.Write(bytes);
        stream.Flush(flushToDisk: true);
        CryptographicOperations.ZeroMemory(bytes);
    }

    private static AclProcessIdentity ReadJournal(FileStream stream)
    {
        if (stream.Length != JournalBytes) throw new InvalidDataException("Operation journal length invalid");
        stream.Position = 0;
        byte[] bytes = new byte[JournalBytes];
        stream.ReadExactly(bytes);
        try
        {
            if (!bytes.AsSpan(0, JournalMagic.Length).SequenceEqual(JournalMagic)) throw new InvalidDataException("Operation journal magic invalid");
            byte[] digest = SHA256.HashData(bytes.AsSpan(0, JournalBodyBytes));
            try
            {
                if (!CryptographicOperations.FixedTimeEquals(digest, bytes.AsSpan(JournalBodyBytes))) throw new InvalidDataException("Operation journal digest invalid");
            }
            finally { CryptographicOperations.ZeroMemory(digest); }
            var owner = new AclProcessIdentity
            {
                ProcessId = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(JournalMagic.Length, 4)),
                ProcessStartTimeUtcTicks = BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(JournalMagic.Length + 4, 8))
            };
            if (owner.ProcessId < 1 || owner.ProcessStartTimeUtcTicks < 1) throw new InvalidDataException("Operation owner invalid");
            return owner;
        }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    private static void RecoverStale(string operations, string journals)
    {
        foreach (string entry in Directory.EnumerateFileSystemEntries(journals).Order(StringComparer.Ordinal))
        {
            string name = Path.GetFileName(entry);
            if (Directory.Exists(entry) || !string.Equals(Path.GetExtension(name), JournalExtension, StringComparison.Ordinal) ||
                !CanonicalPaths.IsSafeWindowsComponent(Path.GetFileNameWithoutExtension(name)))
                throw new InvalidDataException("Operation journal directory contains an unexpected entry");
            string journalPath = CanonicalPaths.RequireWithin(journals, entry, file: true);
            AclProcessIdentity owner;
            try
            {
                using var stream = new FileStream(journalPath, FileMode.Open, FileAccess.ReadWrite, FileShare.Read, 4096, FileOptions.WriteThrough);
                owner = ReadJournal(stream);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                throw new IOException("Operation journal ownership is inaccessible or active", exception);
            }
            if (ProcessIdentity.State(owner) != ProcessIdentityState.Exited) throw new IOException("Operation journal owner is live or ambiguous");
            DeleteLeaseRoot(operations, Path.GetFileNameWithoutExtension(name));
            File.Delete(journalPath);
            FlushDirectory(journals);
        }
    }

    private static void DeleteLeaseRoot(string operations, string leaseId)
    {
        if (!CanonicalPaths.IsSafeWindowsComponent(leaseId)) throw new InvalidDataException("Operation lease invalid");
        string root = Path.Combine(operations, leaseId);
        if (File.Exists(root)) throw new InvalidDataException("Operation workspace type changed");
        if (!Directory.Exists(root)) return;
        root = CanonicalPaths.RequireWithin(operations, root, file: false);
        CanonicalPaths.RejectReparseTree(root);
        Directory.Delete(root, recursive: true);
        FlushDirectory(operations);
    }

    private static void FlushDirectory(string directory)
    {
        nint handle = NativeMethods.CreateFile(NativeFilePath.ForApi(directory), NativeMethods.GenericWrite,
            NativeMethods.FileShareRead | NativeMethods.FileShareWrite | NativeMethods.FileShareDelete, nint.Zero,
            NativeMethods.OpenExisting, NativeMethods.FileFlagBackupSemantics, nint.Zero);
        if (handle == NativeMethods.InvalidHandleValue) throw new IOException("Operation journal directory open failed", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        try
        {
            if (!NativeMethods.FlushFileBuffers(handle)) throw new IOException("Operation journal directory flush failed", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        }
        finally { _ = NativeMethods.CloseHandle(handle); }
    }

    private static string CreateChild(string root, string name)
    {
        string child = Path.Combine(root, name);
        Directory.CreateDirectory(child);
        return CanonicalPaths.RequireWithin(root, child, file: false);
    }

    private void DisposePins()
    {
        for (int index = stagedPins.Count - 1; index >= 0; index--) stagedPins[index].Dispose();
        for (int index = sourcePins.Count - 1; index >= 0; index--) sourcePins[index].Dispose();
        stagedPins.Clear();
        sourcePins.Clear();
    }

    public void Dispose()
    {
        DisposePins();
        if (preserve)
        {
            journalStream?.Dispose();
            journalStream = null;
            return;
        }
        using (NamedMutexScope.Enter(MutexName))
        {
            DeleteLeaseRoot(operationsRoot, leaseId);
            FileStream? stream = Interlocked.Exchange(ref journalStream, null);
            stream?.Dispose();
            File.Delete(journalPath);
            FlushDirectory(journalDirectory);
        }
    }
}
