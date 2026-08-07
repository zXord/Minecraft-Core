namespace MinecraftCore.ArchiveWorker.Security;

internal static class NativeFilePath
{
    private const int MaximumPathChars = 1024;

    internal static string ForApi(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.IndexOf('\0') >= 0 || !Path.IsPathFullyQualified(value) || value.StartsWith(@"\\", StringComparison.Ordinal))
            throw new InvalidDataException("Native file path rejected");
        string full = Path.GetFullPath(value);
        if (full.Length is < 3 or > MaximumPathChars || full[1] != ':' || full[2] != Path.DirectorySeparatorChar ||
            !char.IsAsciiLetter(full[0]) || full.IndexOf(':', 2) >= 0)
            throw new InvalidDataException("Native file path rejected");
        return @"\\?\" + full;
    }
}
