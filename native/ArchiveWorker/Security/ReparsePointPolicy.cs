using System.Runtime.InteropServices;
using MinecraftCore.ArchiveWorker.Sandbox;

namespace MinecraftCore.ArchiveWorker.Security;

internal readonly record struct ReparseObjectIdentity(uint ReparseTag, uint VolumeSerialNumber, ulong FileIndex);

internal static class ReparsePointPolicy
{
    internal static ReparseObjectIdentity CaptureAllowed(nint handle)
    {
        if (!NativeMethods.GetFileAttributeTagInformation(handle, NativeMethods.FileAttributeTagInfo,
                out NativeMethods.FileAttributeTagInformation tagInformation,
                checked((uint)Marshal.SizeOf<NativeMethods.FileAttributeTagInformation>())) ||
            !NativeMethods.GetFileInformationByHandle(handle, out NativeMethods.ByHandleFileInformation identity))
            throw new IOException("Reparse identity unavailable", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        bool hasReparseAttribute = (tagInformation.FileAttributes & NativeMethods.FileAttributeReparsePoint) != 0;
        if (hasReparseAttribute != (tagInformation.ReparseTag != 0)) throw new InvalidDataException("Reparse tag metadata invalid");
        if (ReparseTagPolicy.IsNameSurrogate(tagInformation.ReparseTag))
            throw new InvalidDataException("Name-surrogate reparse point rejected");
        ulong fileIndex = ((ulong)identity.FileIndexHigh << 32) | identity.FileIndexLow;
        if (fileIndex == 0) throw new InvalidDataException("Reparse object identity invalid");
        return new ReparseObjectIdentity(tagInformation.ReparseTag, identity.VolumeSerialNumber, fileIndex);
    }

    internal static void RejectNameSurrogate(string path)
    {
        FileAttributes attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) == 0) return;
        uint flags = NativeMethods.FileFlagOpenReparsePoint |
            ((attributes & FileAttributes.Directory) != 0 ? NativeMethods.FileFlagBackupSemantics : 0u);
        nint handle = NativeMethods.CreateFile(NativeFilePath.ForApi(path), NativeMethods.FileReadAttributes,
            NativeMethods.FileShareRead | NativeMethods.FileShareWrite | NativeMethods.FileShareDelete, nint.Zero,
            NativeMethods.OpenExisting, flags, nint.Zero);
        if (handle == NativeMethods.InvalidHandleValue)
            throw new IOException("Reparse inspection open failed", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        try
        {
            string expected = Path.GetFullPath(path);
            ReparseObjectIdentity before = CaptureAllowed(handle);
            if (!string.Equals(expected, FinalPath(handle), StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Reparse object redirected");
            ReparseObjectIdentity after = CaptureAllowed(handle);
            if (before != after) throw new InvalidDataException("Reparse identity changed");
        }
        finally { _ = NativeMethods.CloseHandle(handle); }
    }

    private static string FinalPath(nint handle)
    {
        char[] buffer = new char[32768];
        uint length = NativeMethods.GetFinalPathNameByHandle(handle, buffer, checked((uint)buffer.Length), 0);
        if (length == 0 || length >= buffer.Length)
            throw new IOException("Reparse final path unavailable", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        string value = new(buffer, 0, checked((int)length));
        if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Reparse UNC path rejected");
        if (value.StartsWith(@"\\?\", StringComparison.Ordinal)) value = value[4..];
        return Path.GetFullPath(value);
    }
}
