using System.Runtime.InteropServices;
using MinecraftCore.ArchiveWorker.Sandbox;

namespace MinecraftCore.ArchiveWorker.Security;

internal static partial class CanonicalPaths
{
    private static readonly HashSet<string> ReservedDevices = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "COM¹", "COM²", "COM³",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³"
    };

    internal static bool IsSafeWindowsComponent(string value)
    {
        if (string.IsNullOrEmpty(value) || value is "." or ".." || value.EndsWith('.') || value.EndsWith(' ') ||
            value.Any(character => character < 0x20 || character == 0x7f || character is '<' or '>' or ':' or '"' or '/' or '\\' or '|' or '?' or '*')) return false;
        string device = value.Split('.', 2)[0];
        return !ReservedDevices.Contains(device);
    }

    internal static string ExistingDirectory(string value, bool allowOwnedRoot = true)
    {
        string path = LocalAbsolute(value, allowOwnedRoot);
        if (!Directory.Exists(path)) throw new InvalidDataException("Directory is unavailable");
        RejectReparseChain(path);
        return path;
    }

    internal static string ExistingFile(string value)
    {
        string path = LocalAbsolute(value, allowRoot: false);
        if (!File.Exists(path)) throw new InvalidDataException("File is unavailable");
        RejectReparseChain(path);
        FileAttributes attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.Directory) != 0) throw new InvalidDataException("Regular file required");
        return path;
    }

    internal static string AbsentDestination(string value)
    {
        string path = LocalAbsolute(value, allowRoot: false);
        string parent = Path.GetDirectoryName(path) ?? throw new InvalidDataException("Destination parent missing");
        ExistingDirectory(parent);
        nint handle = NativeMethods.CreateFile(NativeFilePath.ForApi(path), NativeMethods.FileReadAttributes,
            NativeMethods.FileShareRead | NativeMethods.FileShareWrite | NativeMethods.FileShareDelete,
            nint.Zero, NativeMethods.OpenExisting,
            NativeMethods.FileFlagOpenReparsePoint | NativeMethods.FileFlagBackupSemantics, nint.Zero);
        if (handle != NativeMethods.InvalidHandleValue)
        {
            _ = NativeMethods.CloseHandle(handle);
            throw new IOException("Destination exists");
        }
        int error = Marshal.GetLastWin32Error();
        if (error is not (NativeMethods.ErrorFileNotFound or NativeMethods.ErrorPathNotFound))
            throw new IOException("Destination absence unavailable", new System.ComponentModel.Win32Exception(error));
        return path;
    }

    internal static string RequireWithin(string root, string candidate, bool file)
    {
        string canonicalRoot = ExistingDirectory(root);
        string canonical = file ? ExistingFile(candidate) : ExistingDirectory(candidate);
        string relative = Path.GetRelativePath(canonicalRoot, canonical);
        if (relative == ".." || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) || Path.IsPathRooted(relative)) throw new InvalidDataException("Path escaped root");
        return canonical;
    }

    internal static bool IsWithinAny(string candidate, IReadOnlyCollection<string> roots)
    {
        foreach (string root in roots)
        {
            string relative = Path.GetRelativePath(root, candidate);
            if (relative != ".." && !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) && !Path.IsPathRooted(relative)) return true;
        }
        return false;
    }

    internal static void SameVolume(string left, string right)
    {
        string leftVolume = VolumeIdentity(left);
        string rightProbe = File.Exists(right) || Directory.Exists(right) ? right : Path.GetDirectoryName(right)!;
        string rightVolume = VolumeIdentity(rightProbe);
        if (!string.Equals(leftVolume, rightVolume, StringComparison.OrdinalIgnoreCase)) throw new IOException("Cross-volume operation rejected");
    }

    internal static void RejectReparseTree(string root)
    {
        RejectReparseChain(root);
        var pending = new Stack<string>();
        pending.Push(root);
        while (pending.Count != 0)
        {
            string directory = pending.Pop();
            foreach (string entry in Directory.EnumerateFileSystemEntries(directory))
            {
                ReparsePointPolicy.RejectNameSurrogate(entry);
                if (Directory.Exists(entry)) pending.Push(entry);
            }
        }
    }

    private static string LocalAbsolute(string value, bool allowRoot)
    {
        if (string.IsNullOrWhiteSpace(value) || value.IndexOf('\0') >= 0 || !Path.IsPathFullyQualified(value)) throw new InvalidDataException("Absolute path required");
        if (PathInputPolicy.HasTraversalAlias(value)) throw new InvalidDataException("Raw traversal path rejected");
        if (value.StartsWith("\\\\", StringComparison.Ordinal) || value.StartsWith("\\\\?\\", StringComparison.Ordinal) || value.StartsWith("\\\\.\\", StringComparison.Ordinal)) throw new InvalidDataException("Device and UNC paths rejected");
        string full = Path.GetFullPath(value);
        string root = Path.GetPathRoot(full) ?? throw new InvalidDataException("Volume root missing");
        if (!allowRoot && string.Equals(full.TrimEnd(Path.DirectorySeparatorChar), root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Volume roots rejected");
        string tail = full[root.Length..];
        if (tail.Contains(':', StringComparison.Ordinal)) throw new InvalidDataException("Alternate stream rejected");
        if (tail.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries).Any(component => !IsSafeWindowsComponent(component)))
            throw new InvalidDataException("Windows path component rejected");
        return full;
    }

    private static void RejectReparseChain(string value)
    {
        string full = Path.GetFullPath(value);
        string root = Path.GetPathRoot(full)!;
        string current = root;
        foreach (string component in full[root.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, component);
            if (!File.Exists(current) && !Directory.Exists(current)) break;
            ReparsePointPolicy.RejectNameSurrogate(current);
        }
    }

    private static string VolumeIdentity(string value)
    {
        char[] mount = new char[NativeMethods.MaximumPathChars];
        if (!NativeMethods.GetVolumePathName(value, mount, (uint)mount.Length)) throw new IOException("Volume lookup failed", Marshal.GetExceptionForHR(Marshal.GetHRForLastWin32Error()));
        int mountLength = Array.IndexOf(mount, '\0');
        if (mountLength < 1) throw new IOException("Volume mount invalid");
        string mountPoint = new(mount, 0, mountLength);
        char[] volume = new char[NativeMethods.MaximumPathChars];
        if (!NativeMethods.GetVolumeNameForVolumeMountPoint(mountPoint, volume, (uint)volume.Length)) throw new IOException("Volume identity failed", Marshal.GetExceptionForHR(Marshal.GetHRForLastWin32Error()));
        int volumeLength = Array.IndexOf(volume, '\0');
        if (volumeLength < 1) throw new IOException("Volume identity invalid");
        return new string(volume, 0, volumeLength);
    }
}
