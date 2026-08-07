using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
using MinecraftCore.ArchiveWorker.Sandbox;

namespace MinecraftCore.ArchiveWorker.Security;

internal readonly record struct FileIdentity(uint VolumeSerialNumber, ulong FileIndex, ulong Size, ulong LastWriteTime, uint ReparseTag);

internal sealed class PinnedFile : IDisposable
{
    private readonly FileStream stream;
    private readonly FileIdentity identity;
    private readonly string finalPath;
    private bool disposed;

    private PinnedFile(FileStream value, string path, FileIdentity captured)
    {
        stream = value;
        finalPath = path;
        identity = captured;
    }

    internal string Path => finalPath;
    internal long Length => checked((long)identity.Size);

    internal static PinnedFile OpenVerified(string value, long expectedSize, string expectedSha256, string? expectedSha512 = null, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string canonical = CanonicalPaths.ExistingFile(value);
        nint raw = NativeMethods.CreateFile(NativeFilePath.ForApi(canonical), NativeMethods.GenericRead, NativeMethods.FileShareRead, nint.Zero,
            NativeMethods.OpenExisting, 0, nint.Zero);
        if (raw == NativeMethods.InvalidHandleValue) throw new IOException("Pinned file open failed", new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error()));
        var safe = new SafeFileHandle(raw, ownsHandle: true);
        FileStream? stream = null;
        try
        {
            stream = new FileStream(safe, FileAccess.Read, 64 * 1024, isAsync: false);
            string finalPath = FinalPath(raw);
            if (!string.Equals(canonical, finalPath, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Pinned file path changed");
            FileIdentity before = Identity(raw);
            if (before.Size != checked((ulong)expectedSize)) throw new InvalidDataException("Pinned file size mismatch");
            (byte[] sha256, byte[] sha512) = Hash(stream, cancellationToken);
            byte[] expected256 = ParseDigest(expectedSha256, 32);
            byte[]? expected512 = expectedSha512 is null ? null : ParseDigest(expectedSha512, 64);
            try
            {
                if (!CryptographicOperations.FixedTimeEquals(sha256, expected256) || (expected512 is not null && !CryptographicOperations.FixedTimeEquals(sha512, expected512)))
                    throw new InvalidDataException("Pinned file hash mismatch");
            }
            finally
            {
                CryptographicOperations.ZeroMemory(sha256);
                CryptographicOperations.ZeroMemory(sha512);
                CryptographicOperations.ZeroMemory(expected256);
                if (expected512 is not null) CryptographicOperations.ZeroMemory(expected512);
            }
            FileIdentity after = Identity(raw);
            if (before != after) throw new InvalidDataException("Pinned file identity changed");
            stream.Position = 0;
            return new PinnedFile(stream, finalPath, before);
        }
        catch
        {
            stream?.Dispose();
            if (stream is null) safe.Dispose();
            throw;
        }
    }

    internal static PinnedFile OpenSnapshot(string value)
    {
        string canonical = CanonicalPaths.ExistingFile(value);
        nint raw = NativeMethods.CreateFile(NativeFilePath.ForApi(canonical), NativeMethods.GenericRead, NativeMethods.FileShareRead, nint.Zero,
            NativeMethods.OpenExisting, 0, nint.Zero);
        if (raw == NativeMethods.InvalidHandleValue) throw new IOException("Pinned file open failed", new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error()));
        var safe = new SafeFileHandle(raw, ownsHandle: true);
        FileStream? stream = null;
        try
        {
            stream = new FileStream(safe, FileAccess.Read, 64 * 1024, isAsync: false);
            string finalPath = FinalPath(raw);
            if (!string.Equals(canonical, finalPath, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Pinned file path changed");
            FileIdentity before = Identity(raw);
            (byte[] sha256, byte[] sha512) = Hash(stream, CancellationToken.None);
            CryptographicOperations.ZeroMemory(sha256);
            CryptographicOperations.ZeroMemory(sha512);
            FileIdentity after = Identity(raw);
            if (before != after) throw new InvalidDataException("Pinned file identity changed");
            stream.Position = 0;
            return new PinnedFile(stream, finalPath, before);
        }
        catch
        {
            stream?.Dispose();
            if (stream is null) safe.Dispose();
            throw;
        }
    }

    internal void Revalidate(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ObjectDisposedException.ThrowIf(disposed, this);
        if (!string.Equals(finalPath, FinalPath(stream.SafeFileHandle.DangerousGetHandle()), StringComparison.OrdinalIgnoreCase) ||
            identity != Identity(stream.SafeFileHandle.DangerousGetHandle())) throw new InvalidDataException("Pinned file identity changed");
        cancellationToken.ThrowIfCancellationRequested();
    }

    internal void CopyTo(string destination, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        cancellationToken.ThrowIfCancellationRequested();
        string target = CanonicalPaths.AbsentDestination(destination);
        stream.Position = 0;
        using var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None, 64 * 1024, FileOptions.WriteThrough);
        byte[] buffer = new byte[64 * 1024];
        try
        {
            int read;
            while ((read = stream.Read(buffer, 0, buffer.Length)) != 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
                output.Write(buffer, 0, read);
            }
        }
        finally { CryptographicOperations.ZeroMemory(buffer); }
        output.Flush(flushToDisk: true);
        cancellationToken.ThrowIfCancellationRequested();
        stream.Position = 0;
        Revalidate(cancellationToken);
    }

    private static (byte[] Sha256, byte[] Sha512) Hash(Stream input, CancellationToken cancellationToken)
    {
        using IncrementalHash sha256 = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        using IncrementalHash sha512 = IncrementalHash.CreateHash(HashAlgorithmName.SHA512);
        byte[] buffer = new byte[64 * 1024];
        try
        {
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) != 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
                sha256.AppendData(buffer, 0, read);
                sha512.AppendData(buffer, 0, read);
            }
            cancellationToken.ThrowIfCancellationRequested();
            return (sha256.GetHashAndReset(), sha512.GetHashAndReset());
        }
        finally { CryptographicOperations.ZeroMemory(buffer); }
    }

    private static byte[] ParseDigest(string value, int length)
    {
        if (value.Length != length * 2) throw new InvalidDataException("Pinned digest invalid");
        try
        {
            byte[] result = Convert.FromHexString(value);
            if (result.Length != length) throw new InvalidDataException("Pinned digest invalid");
            return result;
        }
        catch (FormatException exception) { throw new InvalidDataException("Pinned digest invalid", exception); }
    }

    private static FileIdentity Identity(nint handle)
    {
        if (!NativeMethods.GetFileInformationByHandle(handle, out NativeMethods.ByHandleFileInformation info))
            throw new IOException("Pinned file identity unavailable", new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error()));
        ulong index = ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow;
        ulong size = ((ulong)info.FileSizeHigh << 32) | info.FileSizeLow;
        ulong write = ((ulong)info.LastWriteTime.HighDateTime << 32) | info.LastWriteTime.LowDateTime;
        ReparseObjectIdentity reparse = ReparsePointPolicy.CaptureAllowed(handle);
        if (reparse.VolumeSerialNumber != info.VolumeSerialNumber || reparse.FileIndex != index)
            throw new InvalidDataException("Pinned file reparse identity changed");
        return new FileIdentity(info.VolumeSerialNumber, index, size, write, reparse.ReparseTag);
    }

    private static string FinalPath(nint handle)
    {
        char[] buffer = new char[32768];
        uint length = NativeMethods.GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Length, 0);
        if (length == 0 || length >= buffer.Length) throw new IOException("Pinned file path unavailable", new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error()));
        string value = new(buffer, 0, (int)length);
        if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Pinned UNC path rejected");
        if (value.StartsWith(@"\\?\", StringComparison.Ordinal)) value = value[4..];
        return System.IO.Path.GetFullPath(value);
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        stream.Dispose();
    }
}

internal sealed class PinnedDirectory : IDisposable
{
    private nint handle;
    internal string Path { get; }

    private PinnedDirectory(string path, nint value) { Path = path; handle = value; }

    internal static PinnedDirectory OpenExact(string value, IReadOnlyCollection<string> expectedEntries)
    {
        string canonical = CanonicalPaths.ExistingDirectory(value);
        AssertExactEntries(canonical, expectedEntries);
        nint raw = NativeMethods.CreateFile(NativeFilePath.ForApi(canonical), NativeMethods.FileListDirectory, NativeMethods.FileShareRead, nint.Zero,
            NativeMethods.OpenExisting, NativeMethods.FileFlagBackupSemantics, nint.Zero);
        if (raw == NativeMethods.InvalidHandleValue) throw new IOException("Pinned directory open failed", new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error()));
        try
        {
            AssertExactEntries(canonical, expectedEntries);
            return new PinnedDirectory(canonical, raw);
        }
        catch { _ = NativeMethods.CloseHandle(raw); throw; }
    }

    private static void AssertExactEntries(string directory, IReadOnlyCollection<string> expectedEntries)
    {
        string[] actual = Directory.EnumerateFileSystemEntries(directory).Select(entry => System.IO.Path.GetFileName(entry)!).Order(StringComparer.Ordinal).ToArray();
        string[] expected = expectedEntries.Order(StringComparer.Ordinal).ToArray();
        if (!actual.SequenceEqual(expected, StringComparer.Ordinal)) throw new InvalidDataException("Pinned directory contents changed");
    }

    public void Dispose()
    {
        nint value = Interlocked.Exchange(ref handle, nint.Zero);
        if (value != nint.Zero) _ = NativeMethods.CloseHandle(value);
    }
}
