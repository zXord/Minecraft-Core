using System.Text.Json.Serialization;

namespace MinecraftCore.ArchiveWorker.Protocol;

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    GenerationMode = JsonSourceGenerationMode.Metadata)]
[JsonSerializable(typeof(WorkerRequest))]
[JsonSerializable(typeof(WorkerFrame))]
[JsonSerializable(typeof(ControlFrame))]
[JsonSerializable(typeof(DurableRequest))]
[JsonSerializable(typeof(DurableDirectoryRequest))]
[JsonSerializable(typeof(DurableResponse))]
[JsonSerializable(typeof(ContainmentEvidence))]
[JsonSerializable(typeof(AclLeaseJournalFrame))]
internal sealed partial class WorkerJsonContext : JsonSerializerContext;
