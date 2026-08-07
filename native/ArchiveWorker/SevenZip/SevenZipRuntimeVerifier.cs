using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using MinecraftCore.ArchiveWorker.Protocol;
using MinecraftCore.ArchiveWorker.Security;

namespace MinecraftCore.ArchiveWorker.SevenZip;

internal sealed class SevenZipRuntime : IDisposable
{
    private readonly PinnedFile executable;
    private readonly PinnedFile library;
    private readonly PinnedFile license;
    private readonly PinnedDirectory directory;

    internal SevenZipRuntime(PinnedFile exe, PinnedFile dll, PinnedFile licenseFile, PinnedDirectory directoryPin)
    {
        executable = exe;
        library = dll;
        license = licenseFile;
        directory = directoryPin;
    }

    internal string Executable => executable.Path;
    internal string Library => library.Path;
    internal string License => license.Path;
    internal string EngineDirectory => directory.Path;
    internal PinnedFile ExecutablePin => executable;
    internal PinnedFile LibraryPin => library;
    internal PinnedFile LicensePin => license;

    internal void Revalidate(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        executable.Revalidate(cancellationToken);
        library.Revalidate(cancellationToken);
        license.Revalidate(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
    }

    public void Dispose()
    {
        directory.Dispose();
        license.Dispose();
        library.Dispose();
        executable.Dispose();
    }
}

internal static partial class SevenZipRuntimeVerifier
{
    internal const long ExecutableSize = 576000;
    internal const long LibrarySize = 1906688;
    internal const long LicenseSize = 6031;
    internal const string ExecutableHash = "83967f1b02b43c4efeda302795722c809e0e81b8307de73558d10484d5676a7d";
    internal const string LibraryHash = "69fd4df057985c40e510e2fac182881c7f85e90aa13ec703f763a8fdb2ce61f8";
    internal const string LicenseHash = "519ac0a4bded9c18ea02e0afb71f663d8c47373bd9facd3ac96a79f51d77765d";
    private static readonly string[] RuntimeNames = ["7z.dll", "7z.exe", "License.txt"];

    [GeneratedRegex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,7})?(?:Z|\\+00:00)$", RegexOptions.CultureInvariant)]
    private static partial Regex AcquiredAtPattern();

    internal static SevenZipRuntime Verify(string resourcesRoot, string layout, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (layout is not ("repository" or "packaged")) throw new InvalidDataException("Runtime layout invalid");
        string root = CanonicalPaths.ExistingDirectory(resourcesRoot);
        string manifestPath = layout == "packaged" ? Path.Combine(root, "manifests", "7zip-26.02.json") :
            Path.Combine(root, "build-resources", "archive-runtime", "7zip-26.02.json");
        manifestPath = CanonicalPaths.RequireWithin(root, manifestPath, file: true);
        byte[] manifestBytes = File.ReadAllBytes(manifestPath);
        cancellationToken.ThrowIfCancellationRequested();
        if (manifestBytes.Length is < 2 or > 64 * 1024) throw new InvalidDataException("Runtime manifest unavailable");
        FrameReader.ValidateStrictJson(manifestBytes);
        using JsonDocument document = JsonDocument.Parse(manifestBytes, new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Disallow, MaxDepth = 32 });
        ValidateManifest(document.RootElement);

        string enginePath = layout == "packaged" ? Path.Combine(root, "7zip") : Path.Combine(root, "vendor", "7zip", "x64");
        string engine = CanonicalPaths.RequireWithin(root, enginePath, file: false);
        return PinEngine(engine, cancellationToken);
    }

    internal static SevenZipRuntime Stage(SevenZipRuntime source, string destination, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string engine = CanonicalPaths.ExistingDirectory(destination);
        if (Directory.EnumerateFileSystemEntries(engine).Any()) throw new InvalidDataException("Runtime staging must be empty");
        source.Revalidate(cancellationToken);
        source.ExecutablePin.CopyTo(Path.Combine(engine, "7z.exe"), cancellationToken);
        source.LibraryPin.CopyTo(Path.Combine(engine, "7z.dll"), cancellationToken);
        source.LicensePin.CopyTo(Path.Combine(engine, "License.txt"), cancellationToken);
        source.Revalidate(cancellationToken);
        return PinEngine(engine, cancellationToken);
    }

    private static SevenZipRuntime PinEngine(string engine, CancellationToken cancellationToken)
    {
        PinnedFile? executable = null;
        PinnedFile? library = null;
        PinnedFile? license = null;
        PinnedDirectory? directory = null;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            executable = PinnedFile.OpenVerified(Path.Combine(engine, "7z.exe"), ExecutableSize, ExecutableHash, cancellationToken: cancellationToken);
            library = PinnedFile.OpenVerified(Path.Combine(engine, "7z.dll"), LibrarySize, LibraryHash, cancellationToken: cancellationToken);
            license = PinnedFile.OpenVerified(Path.Combine(engine, "License.txt"), LicenseSize, LicenseHash, cancellationToken: cancellationToken);
            directory = PinnedDirectory.OpenExact(engine, RuntimeNames);
            cancellationToken.ThrowIfCancellationRequested();
            VerifyAmd64Pe(executable.Path);
            cancellationToken.ThrowIfCancellationRequested();
            VerifyAmd64Pe(library.Path);
            cancellationToken.ThrowIfCancellationRequested();
            RequireVersion(executable.Path);
            cancellationToken.ThrowIfCancellationRequested();
            RequireVersion(library.Path);
            cancellationToken.ThrowIfCancellationRequested();
            return new SevenZipRuntime(executable, library, license, directory);
        }
        catch
        {
            directory?.Dispose();
            license?.Dispose();
            library?.Dispose();
            executable?.Dispose();
            throw;
        }
    }

    private static void ValidateManifest(JsonElement manifest)
    {
        RequireKeys(manifest, "schemaVersion", "version", "architecture", "msi", "source", "acquiredAt", "download", "authenticode", "pe", "handlers", "files");
        RequireNumber(manifest, "schemaVersion", 1);
        RequireString(manifest, "version", "26.02");
        RequireString(manifest, "architecture", "x64");

        JsonElement msi = manifest.GetProperty("msi");
        RequireKeys(msi, "url", "size", "sha256");
        RequireString(msi, "url", "https://github.com/ip7z/7zip/releases/download/26.02/7z2602-x64.msi");
        RequireNumber(msi, "size", 1999872);
        RequireString(msi, "sha256", "db407a4f6d4999e5c7bc00ce8a882be94717b56e7fa68140fe3f12605d91643e");

        JsonElement source = manifest.GetProperty("source");
        RequireKeys(source, "url", "sha256");
        RequireString(source, "url", "https://github.com/ip7z/7zip/releases/download/26.02/7z2602-src.7z");
        RequireString(source, "sha256", "c7502dd4557481f52ccf1b3e680329f1fdd207e79a25544afeb3106325474944");

        string? acquiredAt = manifest.GetProperty("acquiredAt").GetString();
        if (acquiredAt is null || !AcquiredAtPattern().IsMatch(acquiredAt) || !DateTimeOffset.TryParse(acquiredAt, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out _)) throw new InvalidDataException("Runtime acquisition identity invalid");

        JsonElement download = manifest.GetProperty("download");
        RequireKeys(download, "finalHost", "size", "sha256");
        RequireString(download, "finalHost", "release-assets.githubusercontent.com");
        RequireNumber(download, "size", 1999872);
        RequireString(download, "sha256", "db407a4f6d4999e5c7bc00ce8a882be94717b56e7fa68140fe3f12605d91643e");

        JsonElement authenticode = manifest.GetProperty("authenticode");
        RequireKeys(authenticode, "status");
        RequireString(authenticode, "status", "NotSigned");

        JsonElement pe = manifest.GetProperty("pe");
        RequireKeys(pe, "machine", "executable", "library");
        RequireString(pe, "machine", "AMD64");
        ValidatePeRecord(pe.GetProperty("executable"));
        ValidatePeRecord(pe.GetProperty("library"));

        JsonElement handlers = manifest.GetProperty("handlers");
        RequireKeys(handlers, "version", "zip", "rar");
        RequireString(handlers, "version", "26.02");
        if (!handlers.GetProperty("zip").GetBoolean() || !handlers.GetProperty("rar").GetBoolean()) throw new InvalidDataException("Runtime handlers unavailable");

        JsonElement files = manifest.GetProperty("files");
        RequireKeys(files, "7z.exe", "7z.dll", "License.txt");
        RequireManifestFile(files.GetProperty("7z.exe"), ExecutableSize, ExecutableHash);
        RequireManifestFile(files.GetProperty("7z.dll"), LibrarySize, LibraryHash);
        RequireManifestFile(files.GetProperty("License.txt"), LicenseSize, LicenseHash);
    }

    private static void ValidatePeRecord(JsonElement value)
    {
        RequireKeys(value, "fileVersion", "productVersion", "authenticodeStatus");
        RequireString(value, "fileVersion", "26.02");
        RequireString(value, "productVersion", "26.02");
        RequireString(value, "authenticodeStatus", "NotSigned");
    }

    private static void RequireVersion(string file)
    {
        FileVersionInfo info = FileVersionInfo.GetVersionInfo(file);
        if (!string.Equals(info.FileVersion, "26.02", StringComparison.Ordinal) || !string.Equals(info.ProductVersion, "26.02", StringComparison.Ordinal))
            throw new InvalidDataException("Runtime version mismatch");
    }

    private static void VerifyAmd64Pe(string file)
    {
        using FileStream stream = File.Open(file, FileMode.Open, FileAccess.Read, FileShare.Read);
        using var reader = new BinaryReader(stream);
        if (reader.ReadUInt16() != 0x5a4d) throw new InvalidDataException("PE header missing");
        stream.Position = 0x3c;
        int offset = reader.ReadInt32();
        if (offset < 0x40 || offset > stream.Length - 6) throw new InvalidDataException("PE offset invalid");
        stream.Position = offset;
        if (reader.ReadUInt32() != 0x00004550 || reader.ReadUInt16() != 0x8664) throw new InvalidDataException("PE architecture mismatch");
    }

    private static void RequireManifestFile(JsonElement value, long size, string hash)
    {
        RequireKeys(value, "size", "sha256");
        RequireNumber(value, "size", size);
        RequireString(value, "sha256", hash);
    }

    private static void RequireNumber(JsonElement value, string property, long expected)
    {
        if (!value.TryGetProperty(property, out JsonElement actual) || actual.ValueKind != JsonValueKind.Number || !actual.TryGetInt64(out long parsed) || parsed != expected)
            throw new InvalidDataException("Manifest number mismatch");
    }

    private static void RequireString(JsonElement value, string property, string expected)
    {
        if (!value.TryGetProperty(property, out JsonElement actual) || actual.ValueKind != JsonValueKind.String || !string.Equals(actual.GetString(), expected, StringComparison.Ordinal))
            throw new InvalidDataException("Manifest string mismatch");
    }

    private static void RequireKeys(JsonElement value, params string[] keys)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new InvalidDataException("JSON object required");
        string[] actual = value.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).ToArray();
        string[] expected = keys.Order(StringComparer.Ordinal).ToArray();
        if (!actual.SequenceEqual(expected, StringComparer.Ordinal)) throw new InvalidDataException("JSON schema mismatch");
    }
}
