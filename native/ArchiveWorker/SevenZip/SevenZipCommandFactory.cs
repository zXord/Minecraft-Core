namespace MinecraftCore.ArchiveWorker.SevenZip;

internal sealed record SevenZipCommand(string Executable, string[] Arguments);

internal static class SevenZipCommandFactory
{
    internal static SevenZipCommand Create(string executable, string operation, string archiveFamily, string archivePath, string scratchDirectory, string? outputDirectory, string? entryName)
    {
        if (!string.Equals(Path.GetFileName(executable), "7z.exe", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Pinned extractor executable required");
        string type = archiveFamily switch
        {
            "zip" => "-tzip",
            "rar4" => "-trar",
            "rar5" => "-trar5",
            _ => throw new InvalidDataException("Unsupported archive family")
        };
        var arguments = new List<string>
        {
            operation switch { "list" => "l", "test" => "t", "extract" => "x", "read-entry" => "e", _ => throw new InvalidDataException("Unsupported operation") },
            type,
            "-sccUTF-8",
            "-scsUTF-8",
            "-bb0",
            "-bd",
            operation == "read-entry" ? "-bso0" : "-bso1",
            "-bse2",
            "-bsp0",
            "-y",
            "-mmt1",
            $"-w{scratchDirectory}"
        };
        if (archiveFamily is "rar4" or "rar5") arguments.Add("-smemx2g");
        if (operation == "list") arguments.Add("-slt");
        if (operation == "extract")
        {
            if (outputDirectory is null) throw new InvalidDataException("Output directory required");
            arguments.Add("-aoa");
            arguments.Add("-sns-");
            arguments.Add($"-o{outputDirectory}");
        }
        if (operation == "read-entry")
        {
            if (entryName is null) throw new InvalidDataException("Entry required");
            arguments.Add("-so");
            arguments.Add("-spd");
        }
        arguments.Add("--");
        arguments.Add(archivePath);
        if (operation == "read-entry") arguments.Add(entryName!);
        return new SevenZipCommand(executable, arguments.ToArray());
    }
}
