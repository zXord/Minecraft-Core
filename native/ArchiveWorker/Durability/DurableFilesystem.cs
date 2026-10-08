using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;
using MinecraftCore.ArchiveWorker.Protocol;
using MinecraftCore.ArchiveWorker.Sandbox;
using MinecraftCore.ArchiveWorker.Security;

namespace MinecraftCore.ArchiveWorker.Durability;

internal static class DurableFilesystem
{
    // This request also carries the allowed roots and nested object identities.
    // 512 remains below FrameReader's strict 16,384-token limit at the maximum
    // 16-root cardinality while retaining useful bulk-flush performance.
    private const int MaxFlushDirectories = 512;

    internal static void Execute(DurableRequest request)
    {
        using DurableRootPins roots = AtStage("root-open", () => DurableRootPins.Open(request.AllowedRoots, request.AllowedRootIdentities));
        try
        {
            switch (request.Operation)
            {
                case "move-write-through":
                    RequireShape(request, source: true, destination: true, existingDestination: false, directory: false);
                    Move(request, roots, replace: false);
                    break;
                case "reconcile-move-write-through":
                    RequireReconcileMoveShape(request);
                    ReconcileMove(request, roots);
                    break;
                case "replace-file-write-through":
                    RequireShape(request, source: true, destination: true, existingDestination: true, directory: false);
                    Move(request, roots, replace: true);
                    break;
                case "flush-directory":
                    RequireShape(request, source: false, destination: false, existingDestination: false, directory: true);
                    Flush(request, roots);
                    break;
                case "flush-directories":
                    RequireFlushDirectoriesShape(request);
                    FlushDirectories(request, roots);
                    break;
                default:
                    throw new InvalidDataException("Unknown durability operation");
            }
        }
        catch (DurabilityFailureException)
        {
            throw;
        }
        catch (Exception exception)
        {
            throw new DurabilityFailureException("request", exception);
        }
    }

    private static void Move(DurableRequest request, DurableRootPins roots, bool replace)
    {
        DurableExpectedIdentity sourceExpected = AtStage("source-open", () =>
            DurableExpectedIdentity.Parse(request.SourceIdentity!, requireFile: replace));
        using DurablePinnedObject source = AtStage("source-open", () => DurablePinnedObject.Open(request.SourcePath!, sourceExpected,
            writeAccess: sourceExpected.FileType == "file", pinWrite: true, pinRename: true, deleteAccess: true, writeThrough: true));
        string destination = AtStage("destination-parent-open", () => replace
            ? CanonicalPaths.ExistingFile(request.DestinationPath!)
            : CanonicalPaths.AbsentDestination(request.DestinationPath!));
        string destinationParentPath = AtStage("destination-parent-open", () => CanonicalPaths.ExistingDirectory(
            Path.GetDirectoryName(destination) ?? throw new InvalidDataException("Destination parent missing")));
        DurableExpectedIdentity parentExpected = AtStage("destination-parent-open", () =>
            DurableExpectedIdentity.Parse(request.DestinationParentIdentity!, requireDirectory: true));
        using DurablePinnedObject destinationParent = AtStage("destination-parent-open", () => DurablePinnedObject.Open(destinationParentPath, parentExpected,
            writeAccess: true, pinRename: true, writeThrough: true));
        using DurablePinnedObject? existingDestination = replace
            ? AtStage("destination-parent-open", () => DurablePinnedObject.Open(destination,
                DurableExpectedIdentity.Parse(request.DestinationIdentity!, requireFile: true),
                writeAccess: false, pinWrite: true, pinRename: false))
            : null;
        string sourceParentPath = AtStage("source-parent-open", () => CanonicalPaths.ExistingDirectory(
            Path.GetDirectoryName(source.Path) ?? throw new InvalidDataException("Source parent missing")));
        using DurablePinnedObject? separateSourceParent = string.Equals(sourceParentPath, destinationParent.Path, StringComparison.OrdinalIgnoreCase)
            ? null
            : AtStage("source-parent-open", () => DurablePinnedObject.OpenCurrent(sourceParentPath, "directory", includeHash: false,
                writeAccess: true, pinRename: true, writeThrough: true));
        DurablePinnedObject sourceParent = separateSourceParent ?? destinationParent;
        using DurableAncestorPins ancestors = AtStage("ancestor-open", () =>
            DurableAncestorPins.Open(roots, sourceParent.Path, destinationParent.Path));

        AtStage("preflight-revalidation", () =>
        {
            if (!roots.Contains(source.Path) || !roots.Contains(destination) || string.Equals(source.Path, destination, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Unowned path");
            if (!string.Equals(Path.GetDirectoryName(destination), destinationParent.Path, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Destination parent changed");
            if (source.Identity.Device != destinationParent.Identity.Device || sourceParent.Identity.Device != destinationParent.Identity.Device ||
                (existingDestination is not null && existingDestination.Identity.Device != destinationParent.Identity.Device))
                throw new IOException("Cross-volume operation rejected");

            roots.Revalidate();
            ancestors.Revalidate();
            sourceParent.Revalidate(requirePath: true);
            destinationParent.Revalidate(requirePath: true);
            source.Revalidate(requirePath: true);
            existingDestination?.Revalidate(requirePath: true);
            if (!replace && (File.Exists(destination) || Directory.Exists(destination))) throw new IOException("Destination exists");
            if (source.Identity.FileType == "file")
            {
                source.Flush();
                source.Revalidate(requirePath: true, allowMetadataChange: true);
            }
        });

        AtStage("handle-rename", () => HandleBoundRename.Move(source.Handle, destinationParent.Handle, destination, replace));
        AtStage("completion-flush", () =>
        {
            Exception? completionFailure = null;
            if (source.Identity.FileType == "file") TryCompletion(source.Flush, ref completionFailure);
            if (existingDestination is not null)
            {
                TryCompletion(() => existingDestination.Revalidate(requirePath: false), ref completionFailure);
                TryCompletion(existingDestination.Dispose, ref completionFailure);
            }
            TryCompletion(sourceParent.Flush, ref completionFailure);
            if (!ReferenceEquals(sourceParent, destinationParent)) TryCompletion(destinationParent.Flush, ref completionFailure);
            if (completionFailure is not null) throw new IOException("Durable publication completion failed", completionFailure);
        });

        // NTFS name tunneling can apply the replaced name's cached creation time to the source object.
        // Compare the published name with the same still-open source handle after the rename, preserving
        // every identity field without treating this documented metadata change as substitution.
        using DurablePinnedObject published = AtStage("published-identity", () =>
        {
            DurableObjectSnapshot committedSource = source.CaptureCurrent();
            DurablePinnedObject candidate = DurablePinnedObject.OpenCurrent(destination, source.Identity.FileType,
                includeHash: source.Identity.FileType == "file", writeAccess: false, pinRename: false);
            if (DurableObjectSnapshot.SamePublishedObject(committedSource, candidate.Identity)) return candidate;
            candidate.Dispose();
            throw new IOException("Published object identity mismatch");
        });
        AtStage("final-revalidation", () =>
        {
            destinationParent.Revalidate(requirePath: true, allowMetadataChange: true);
            sourceParent.Revalidate(requirePath: true, allowMetadataChange: true);
            ancestors.Revalidate(allowMetadataChange: true);
            roots.Revalidate(allowMetadataChange: true);
        });
    }

    private static T AtStage<T>(string failureStage, Func<T> action)
    {
        try { return action(); }
        catch (DurabilityFailureException) { throw; }
        catch (Exception exception) { throw new DurabilityFailureException(failureStage, exception); }
    }

    private static void AtStage(string failureStage, Action action)
    {
        try { action(); }
        catch (DurabilityFailureException) { throw; }
        catch (Exception exception) { throw new DurabilityFailureException(failureStage, exception); }
    }

    private static void TryCompletion(Action action, ref Exception? failure)
    {
        try { action(); }
        catch (Exception exception) when (exception is IOException or InvalidDataException or UnauthorizedAccessException)
        {
            failure ??= exception;
        }
    }

    private static void Flush(DurableRequest request, DurableRootPins roots)
    {
        DurableExpectedIdentity expected = DurableExpectedIdentity.Parse(request.DirectoryIdentity!, requireDirectory: true);
        using DurablePinnedObject directory = DurablePinnedObject.Open(request.DirectoryPath!, expected, writeAccess: true, pinRename: true);
        if (!roots.Contains(directory.Path)) throw new InvalidDataException("Unowned directory");
        roots.Revalidate();
        directory.Revalidate(requirePath: true);
        if (!NativeMethods.FlushFileBuffers(directory.Handle)) throw new IOException("Directory flush failed", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        directory.Revalidate(requirePath: true, allowMetadataChange: true);
    }

    private static void ReconcileMove(DurableRequest request, DurableRootPins roots)
    {
        DurableExpectedIdentity publishedExpected = DurableExpectedIdentity.Parse(request.SourceIdentity!);
        string source = CanonicalPaths.AbsentDestination(request.SourcePath!);
        string destination = publishedExpected.FileType == "file"
            ? CanonicalPaths.ExistingFile(request.DestinationPath!)
            : CanonicalPaths.ExistingDirectory(request.DestinationPath!);
        string sourceParentPath = CanonicalPaths.ExistingDirectory(Path.GetDirectoryName(source) ?? throw new InvalidDataException("Source parent missing"));
        string destinationParentPath = CanonicalPaths.ExistingDirectory(Path.GetDirectoryName(destination) ?? throw new InvalidDataException("Destination parent missing"));
        DurableExpectedIdentity sourceParentExpected = DurableExpectedIdentity.Parse(request.SourceParentIdentity!, requireDirectory: true);
        DurableExpectedIdentity destinationParentExpected = DurableExpectedIdentity.Parse(request.DestinationParentIdentity!, requireDirectory: true);
        using DurablePinnedObject sourceParent = DurablePinnedObject.Open(sourceParentPath, sourceParentExpected,
            writeAccess: true, pinRename: true, writeThrough: true);
        using DurablePinnedObject? separateDestinationParent = string.Equals(sourceParent.Path, destinationParentPath, StringComparison.OrdinalIgnoreCase)
            ? null
            : DurablePinnedObject.Open(destinationParentPath, destinationParentExpected,
                writeAccess: true, pinRename: true, writeThrough: true);
        DurablePinnedObject destinationParent = separateDestinationParent ?? sourceParent;
        if (separateDestinationParent is null && !sourceParent.Identity.Matches(destinationParentExpected))
            throw new InvalidDataException("Reconciled parent identity changed");
        using DurablePinnedObject published = DurablePinnedObject.OpenCurrent(destination, publishedExpected.FileType,
            includeHash: publishedExpected.FileType == "file", writeAccess: false, pinWrite: true, pinRename: true);
        using DurableAncestorPins ancestors = DurableAncestorPins.Open(roots, sourceParent.Path, destinationParent.Path);

        if (!roots.Contains(source) || !roots.Contains(destination) || string.Equals(source, destination, StringComparison.OrdinalIgnoreCase) ||
            published.Identity.Device != sourceParent.Identity.Device || sourceParent.Identity.Device != destinationParent.Identity.Device)
            throw new InvalidDataException("Unowned reconciliation path");
        if (!published.Identity.MatchesReconciledMove(publishedExpected)) throw new InvalidDataException("Published move identity changed");

        roots.Revalidate();
        ancestors.Revalidate();
        sourceParent.Revalidate(requirePath: true);
        destinationParent.Revalidate(requirePath: true);
        published.Revalidate(requirePath: true);
        _ = CanonicalPaths.AbsentDestination(source);

        sourceParent.Flush();
        if (!ReferenceEquals(sourceParent, destinationParent)) destinationParent.Flush();

        sourceParent.Revalidate(requirePath: true, allowMetadataChange: true);
        destinationParent.Revalidate(requirePath: true, allowMetadataChange: true);
        published.Revalidate(requirePath: true);
        if (!published.CaptureCurrent().MatchesReconciledMove(publishedExpected))
            throw new InvalidDataException("Reconciled move changed during flush");
        _ = CanonicalPaths.AbsentDestination(source);
        ancestors.Revalidate(allowMetadataChange: true);
        roots.Revalidate(allowMetadataChange: true);
    }

    private static void FlushDirectories(DurableRequest request, DurableRootPins roots)
    {
        var directories = new List<DurablePinnedObject>(request.Directories!.Length);
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        DurableAncestorPins? ancestors = null;
        try
        {
            foreach (DurableDirectoryRequest entry in request.Directories)
            {
                if (entry is null || entry.DirectoryPath is null || entry.DirectoryIdentity is null)
                    throw new InvalidDataException("Durable directory request invalid");
                string directoryPath = CanonicalPaths.ExistingDirectory(entry.DirectoryPath);
                if (!paths.Add(directoryPath)) throw new InvalidDataException("Duplicate durable directory");
                DurableExpectedIdentity expected = DurableExpectedIdentity.Parse(entry.DirectoryIdentity, requireDirectory: true);
                DurablePinnedObject directory = DurablePinnedObject.Open(directoryPath, expected,
                    writeAccess: true, pinRename: true);
                if (!roots.Contains(directory.Path))
                {
                    directory.Dispose();
                    throw new InvalidDataException("Unowned directory");
                }
                directories.Add(directory);
            }

            ancestors = DurableAncestorPins.Open(roots, directories.Select(directory => directory.Path).ToArray());
            roots.Revalidate();
            ancestors.Revalidate();
            foreach (DurablePinnedObject directory in directories) directory.Revalidate(requirePath: true);
            foreach (DurablePinnedObject directory in directories) directory.Flush();
            foreach (DurablePinnedObject directory in directories) directory.Revalidate(requirePath: true, allowMetadataChange: true);
            ancestors.Revalidate(allowMetadataChange: true);
            roots.Revalidate(allowMetadataChange: true);
        }
        finally
        {
            ancestors?.Dispose();
            for (int index = directories.Count - 1; index >= 0; index--) directories[index].Dispose();
        }
    }

    private static void RequireShape(DurableRequest request, bool source, bool destination, bool existingDestination, bool directory)
    {
        if ((source != (request.SourcePath is not null && request.SourceIdentity is not null)) ||
            (destination != (request.DestinationPath is not null && request.DestinationParentIdentity is not null)) ||
            (existingDestination != (request.DestinationIdentity is not null)) ||
            (directory != (request.DirectoryPath is not null && request.DirectoryIdentity is not null)) || request.SourceParentIdentity is not null ||
            request.Directories is not null)
            throw new InvalidDataException("Durability request shape invalid");
    }

    private static void RequireReconcileMoveShape(DurableRequest request)
    {
        if (request.SourcePath is null || request.SourceIdentity is null || request.SourceParentIdentity is null ||
            request.DestinationPath is null || request.DestinationParentIdentity is null || request.DestinationIdentity is not null ||
            request.DirectoryPath is not null || request.DirectoryIdentity is not null || request.Directories is not null)
            throw new InvalidDataException("Durability request shape invalid");
    }

    private static void RequireFlushDirectoriesShape(DurableRequest request)
    {
        if (request.SourcePath is not null || request.SourceIdentity is not null ||
            request.SourceParentIdentity is not null ||
            request.DestinationPath is not null || request.DestinationParentIdentity is not null ||
            request.DestinationIdentity is not null || request.DirectoryPath is not null || request.DirectoryIdentity is not null ||
            request.Directories is not { Length: > 0 and <= MaxFlushDirectories })
            throw new InvalidDataException("Durability request shape invalid");
    }
}

internal sealed class DurabilityFailureException : Exception
{
    internal string FailureStage { get; }

    internal DurabilityFailureException(string failureStage, Exception innerException)
        : base("Durable filesystem operation failed", innerException)
    {
        FailureStage = failureStage;
    }
}

internal static class HandleBoundRename
{
    private const int FileNameOffset = 20;
    private const int MinimumRenameBufferBytes = 24;

    internal static void Move(nint source, nint destinationParent, string destinationPath, bool replace)
    {
        string destinationName = Path.GetFileName(destinationPath);
        if (source == nint.Zero || destinationParent == nint.Zero || !Path.IsPathFullyQualified(destinationPath) ||
            !CanonicalPaths.IsSafeWindowsComponent(destinationName) ||
            !string.Equals(Path.GetDirectoryName(destinationPath), CanonicalPaths.ExistingDirectory(Path.GetDirectoryName(destinationPath)!), StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Durable rename target invalid");
        byte[] name = Encoding.Unicode.GetBytes(NativeFilePath.ForApi(destinationPath));
        int size = checked(MinimumRenameBufferBytes + name.Length);
        nint buffer = Marshal.AllocHGlobal(size);
        try
        {
            for (int index = 0; index < size; index++) Marshal.WriteByte(buffer, index, 0);
            uint flags = replace ? NativeMethods.FileRenameReplaceIfExists | NativeMethods.FileRenamePosixSemantics : 0u;
            Marshal.WriteInt32(buffer, 0, unchecked((int)flags));
            // SetFileInformationByHandle returns ERROR_INVALID_PARAMETER for a non-null RootDirectory on the
            // supported Windows host. The source remains handle-bound; the canonical extended-length target
            // cannot redirect because its destination parent and complete reparse-free ancestor chain stay pinned.
            Marshal.WriteIntPtr(buffer, 8, nint.Zero);
            Marshal.WriteInt32(buffer, 16, name.Length);
            Marshal.Copy(name, 0, nint.Add(buffer, FileNameOffset), name.Length);
            if (!NativeMethods.SetFileInformationByHandle(source, NativeMethods.FileRenameInfoEx, buffer, checked((uint)size)))
                throw new IOException("Handle-bound durable rename failed", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(name);
            Marshal.FreeHGlobal(buffer);
        }
    }
}

internal sealed class DurableRootPins : IDisposable
{
    private readonly List<DurablePinnedObject> pins;
    private DurableRootPins(List<DurablePinnedObject> values) => pins = values;

    internal static DurableRootPins Open(string[]? rootValues, DurableRootIdentity[]? identities)
    {
        if (rootValues is not { Length: > 0 and <= 16 } || identities is null || identities.Length != rootValues.Length)
            throw new InvalidDataException("Owned roots required");
        var pins = new List<DurablePinnedObject>(rootValues.Length);
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            for (int index = 0; index < rootValues.Length; index++)
            {
                string root = CanonicalPaths.ExistingDirectory(rootValues[index]);
                DurableRootIdentity supplied = identities[index];
                if (supplied.Path is null || supplied.Identity is null ||
                    !string.Equals(root, CanonicalPaths.ExistingDirectory(supplied.Path), StringComparison.OrdinalIgnoreCase) || !names.Add(root))
                    throw new InvalidDataException("Owned root identity invalid");
                pins.Add(DurablePinnedObject.Open(root, DurableExpectedIdentity.Parse(supplied.Identity, requireDirectory: true), writeAccess: false, pinRename: true));
            }
            return new DurableRootPins(pins);
        }
        catch
        {
            for (int index = pins.Count - 1; index >= 0; index--) pins[index].Dispose();
            throw;
        }
    }

    internal bool Contains(string candidate) => pins.Any(pin =>
    {
        string relative = Path.GetRelativePath(pin.Path, candidate);
        return relative != ".." && !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) && !Path.IsPathRooted(relative);
    });

    internal DurablePinnedObject ContainingRoot(string candidate) => pins
        .Where(pin =>
        {
            string relative = Path.GetRelativePath(pin.Path, candidate);
            return relative != ".." && !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) && !Path.IsPathRooted(relative);
        })
        .OrderByDescending(pin => pin.Path.Length)
        .FirstOrDefault() ?? throw new InvalidDataException("Unowned path");

    internal void Revalidate(bool allowMetadataChange = false)
    {
        foreach (DurablePinnedObject pin in pins) pin.Revalidate(requirePath: true, allowMetadataChange);
    }

    public void Dispose()
    {
        for (int index = pins.Count - 1; index >= 0; index--) pins[index].Dispose();
        pins.Clear();
    }
}

internal sealed class DurableAncestorPins : IDisposable
{
    private readonly List<DurablePinnedObject> pins;
    private DurableAncestorPins(List<DurablePinnedObject> values) => pins = values;

    internal static DurableAncestorPins Open(DurableRootPins roots, params string[] directoryValues)
    {
        var pins = new List<DurablePinnedObject>();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            foreach (string directoryValue in directoryValues.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                string directory = CanonicalPaths.ExistingDirectory(directoryValue);
                DurablePinnedObject root = roots.ContainingRoot(directory);
                string relative = Path.GetRelativePath(root.Path, directory);
                if (relative == ".") continue;
                string[] components = relative.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
                string current = root.Path;
                for (int index = 0; index < components.Length - 1; index++)
                {
                    current = Path.Combine(current, components[index]);
                    if (!names.Add(current)) continue;
                    pins.Add(DurablePinnedObject.OpenCurrent(current, "directory", includeHash: false,
                        writeAccess: false, pinRename: true));
                }
            }
            var result = new DurableAncestorPins(pins);
            result.Revalidate();
            return result;
        }
        catch
        {
            for (int index = pins.Count - 1; index >= 0; index--) pins[index].Dispose();
            throw;
        }
    }

    internal void Revalidate(bool allowMetadataChange = false)
    {
        foreach (DurablePinnedObject pin in pins) pin.Revalidate(requirePath: true, allowMetadataChange);
    }

    public void Dispose()
    {
        for (int index = pins.Count - 1; index >= 0; index--) pins[index].Dispose();
        pins.Clear();
    }
}

internal sealed record DurableExpectedIdentity(string FileType, ulong Device, ulong FileIndex, ulong Size, long Birthtime, long Mtime, long Ctime, string? Sha256)
{
    internal static DurableExpectedIdentity Parse(DurableObjectIdentity value, bool requireFile = false, bool requireDirectory = false)
    {
        if (requireFile && requireDirectory) throw new ArgumentException("Conflicting durable identity type");
        if (value.FileType is not ("file" or "directory") || (requireFile && value.FileType != "file") || (requireDirectory && value.FileType != "directory") ||
            !ulong.TryParse(value.Dev, NumberStyles.None, CultureInfo.InvariantCulture, out ulong device) ||
            !ulong.TryParse(value.Ino, NumberStyles.None, CultureInfo.InvariantCulture, out ulong index) || index == 0 ||
            !ulong.TryParse(value.Size, NumberStyles.None, CultureInfo.InvariantCulture, out ulong size) ||
            !long.TryParse(value.Birthtime, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out long birthtime) ||
            !long.TryParse(value.Mtime, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out long mtime) ||
            !long.TryParse(value.Ctime, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out long ctime))
            throw new InvalidDataException("Durable identity invalid");
        string? hash = value.Sha256;
        if (value.FileType == "file")
        {
            if (hash is null || hash.Length != 64 || !hash.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f'))
                throw new InvalidDataException("Durable file hash invalid");
        }
        else if (hash is not null) throw new InvalidDataException("Durable directory hash invalid");
        return new DurableExpectedIdentity(value.FileType, device, index, size, birthtime, mtime, ctime, hash);
    }
}

internal sealed record DurableObjectSnapshot(string FileType, ulong Device, ulong FileIndex, ulong Size, long Birthtime, long Mtime, long Ctime,
    uint ReparseTag, string? Sha256)
{
    internal bool Matches(DurableExpectedIdentity expected, bool allowMetadataChange = false) => FileType == expected.FileType && Device == expected.Device &&
        FileIndex == expected.FileIndex && (FileType == "directory"
            ? Birthtime == expected.Birthtime
            : Size == expected.Size && (allowMetadataChange || (Birthtime == expected.Birthtime && Mtime == expected.Mtime)) &&
                Sha256 == expected.Sha256);

    internal static bool SamePublishedObject(DurableObjectSnapshot source, DurableObjectSnapshot published) => source.FileType == published.FileType &&
        source.Device == published.Device && source.FileIndex == published.FileIndex && source.Size == published.Size && source.Birthtime == published.Birthtime &&
        source.ReparseTag == published.ReparseTag && (source.FileType != "file" || (source.Mtime == published.Mtime && source.Sha256 == published.Sha256));

    internal bool MatchesReconciledMove(DurableExpectedIdentity expected) => FileType == expected.FileType && Device == expected.Device &&
        FileIndex == expected.FileIndex && (FileType == "directory"
            ? Birthtime == expected.Birthtime
            : Size == expected.Size && Mtime == expected.Mtime && Sha256 == expected.Sha256);
}

internal sealed class DurablePinnedObject : IDisposable
{
    private nint handle;
    private readonly DurableExpectedIdentity? expected;
    internal string Path { get; }
    internal DurableObjectSnapshot Identity { get; }
    internal nint Handle => handle != nint.Zero ? handle : throw new ObjectDisposedException(nameof(DurablePinnedObject));

    private DurablePinnedObject(string path, nint value, DurableObjectSnapshot snapshot, DurableExpectedIdentity? expectedValue)
    {
        Path = path;
        handle = value;
        Identity = snapshot;
        expected = expectedValue;
    }

    internal static DurablePinnedObject Open(string path, DurableExpectedIdentity expected, bool writeAccess, bool pinRename,
        bool pinWrite = false,
        bool deleteAccess = false, bool writeThrough = false)
    {
        DurablePinnedObject value = OpenCore(path, expected.FileType, includeHash: expected.FileType == "file", writeAccess,
            pinWrite, pinRename, deleteAccess, writeThrough, expected);
        if (!value.Identity.Matches(expected))
        {
            value.Dispose();
            throw new InvalidDataException("Durable identity changed");
        }
        return value;
    }

    internal static DurablePinnedObject OpenCurrent(string path, string fileType, bool includeHash, bool writeAccess, bool pinRename,
        bool pinWrite = false,
        bool deleteAccess = false, bool writeThrough = false) =>
        OpenCore(path, fileType, includeHash, writeAccess, pinWrite, pinRename, deleteAccess, writeThrough, expected: null);

    private static DurablePinnedObject OpenCore(string pathValue, string fileType, bool includeHash, bool writeAccess, bool pinWrite,
        bool pinRename, bool deleteAccess, bool writeThrough, DurableExpectedIdentity? expected)
    {
        string canonical = fileType == "file" ? CanonicalPaths.ExistingFile(pathValue) : CanonicalPaths.ExistingDirectory(pathValue);
        uint desired = writeAccess
            ? NativeMethods.GenericWrite | (fileType == "directory" ? NativeMethods.FileTraverse | NativeMethods.FileReadAttributes : 0u)
            : fileType == "file" ? NativeMethods.GenericRead : NativeMethods.FileReadAttributes;
        if (fileType == "file" && writeAccess) desired |= NativeMethods.GenericRead;
        if (deleteAccess) desired |= NativeMethods.Delete;
        uint share = NativeMethods.FileShareRead | (pinWrite ? 0u : NativeMethods.FileShareWrite) |
            (pinRename ? 0u : NativeMethods.FileShareDelete);
        uint flags = NativeMethods.FileFlagOpenReparsePoint | (fileType == "directory" ? NativeMethods.FileFlagBackupSemantics : 0u) |
            (writeThrough ? NativeMethods.FileFlagWriteThrough : 0u);
        nint handle = NativeMethods.CreateFile(NativeFilePath.ForApi(canonical), desired, share, nint.Zero, NativeMethods.OpenExisting, flags, nint.Zero);
        if (handle == NativeMethods.InvalidHandleValue) throw new IOException("Durable object open failed", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        try
        {
            if (!string.Equals(canonical, FinalPath(handle), StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Durable path target changed");
            DurableObjectSnapshot snapshot = Capture(handle, fileType, includeHash);
            return new DurablePinnedObject(canonical, handle, snapshot, expected);
        }
        catch { _ = NativeMethods.CloseHandle(handle); throw; }
    }

    internal void Revalidate(bool requirePath, bool allowMetadataChange = false)
    {
        DurableObjectSnapshot current = Capture(Handle, Identity.FileType, includeHash: Identity.FileType == "file");
        bool matches = expected is null
            ? DurableObjectSnapshot.SamePublishedObject(Identity, current)
            : current.ReparseTag == Identity.ReparseTag && current.Matches(expected, allowMetadataChange);
        if (!matches || (requirePath && !string.Equals(Path, FinalPath(Handle), StringComparison.OrdinalIgnoreCase)))
            throw new InvalidDataException("Durable object identity changed");
        if (requirePath)
        {
            using DurablePinnedObject pathPin = OpenCurrent(Path, Identity.FileType, includeHash: Identity.FileType == "file",
                writeAccess: false, pinRename: false);
            if (!DurableObjectSnapshot.SamePublishedObject(current, pathPin.Identity)) throw new InvalidDataException("Durable path was substituted");
        }
    }

    internal void Flush()
    {
        if (!NativeMethods.FlushFileBuffers(Handle))
            throw new IOException("Durable object flush failed", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
    }

    internal DurableObjectSnapshot CaptureCurrent() => Capture(Handle, Identity.FileType, includeHash: Identity.FileType == "file");

    private static DurableObjectSnapshot Capture(nint handle, string fileType, bool includeHash)
    {
        if (!NativeMethods.GetFileInformationByHandle(handle, out NativeMethods.ByHandleFileInformation info) ||
            !NativeMethods.GetFileInformationByHandleEx(handle, 0, out NativeMethods.FileBasicInformation basic, checked((uint)Marshal.SizeOf<NativeMethods.FileBasicInformation>())))
            throw new IOException("Durable object identity unavailable", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        ReparseObjectIdentity reparse = ReparsePointPolicy.CaptureAllowed(handle);
        ulong index = ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow;
        ulong size = ((ulong)info.FileSizeHigh << 32) | info.FileSizeLow;
        if (reparse.VolumeSerialNumber != info.VolumeSerialNumber || reparse.FileIndex != index || basic.FileAttributes != info.FileAttributes)
            throw new InvalidDataException("Durable reparse identity changed");
        string? hash = includeHash ? Hash(handle) : null;
        return new DurableObjectSnapshot(fileType, info.VolumeSerialNumber, index, size,
            FileTimeToUnixNanoseconds(basic.CreationTime), FileTimeToUnixNanoseconds(basic.LastWriteTime), FileTimeToUnixNanoseconds(basic.ChangeTime),
            reparse.ReparseTag, hash);
    }

    private static string Hash(nint handle)
    {
        using var safe = new SafeFileHandle(handle, ownsHandle: false);
        using var stream = new FileStream(safe, FileAccess.Read, 64 * 1024, isAsync: false);
        stream.Position = 0;
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        byte[] buffer = new byte[1024 * 1024];
        int read;
        while ((read = stream.Read(buffer, 0, buffer.Length)) != 0) hash.AppendData(buffer, 0, read);
        CryptographicOperations.ZeroMemory(buffer);
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    private static long FileTimeToUnixNanoseconds(long fileTime) => checked((fileTime - 116444736000000000L) * 100L);

    private static string FinalPath(nint handle)
    {
        char[] buffer = new char[32768];
        uint length = NativeMethods.GetFinalPathNameByHandle(handle, buffer, checked((uint)buffer.Length), 0);
        if (length == 0 || length >= buffer.Length) throw new IOException("Durable final path unavailable", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        string value = new(buffer, 0, checked((int)length));
        if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Durable UNC path rejected");
        if (value.StartsWith(@"\\?\", StringComparison.Ordinal)) value = value[4..];
        return System.IO.Path.GetFullPath(value);
    }

    public void Dispose()
    {
        nint value = Interlocked.Exchange(ref handle, nint.Zero);
        if (value != nint.Zero) _ = NativeMethods.CloseHandle(value);
    }
}
