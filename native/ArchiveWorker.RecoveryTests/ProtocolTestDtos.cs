using System.Text.Json.Serialization;

namespace MinecraftCore.ArchiveWorker.RecoveryTests;

internal sealed class ProtocolProbe
{
    public string? Operation { get; init; }
    public ProtocolPart[]? InputParts { get; init; }
}

internal sealed class ProtocolPart
{
    public string? Path { get; init; }
    public string? Size { get; init; }
    public string? Sha256 { get; init; }
    public string? Sha512 { get; init; }
}

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    GenerationMode = JsonSourceGenerationMode.Metadata)]
[JsonSerializable(typeof(ProtocolProbe))]
internal sealed partial class ProtocolTestJsonContext : JsonSerializerContext;
