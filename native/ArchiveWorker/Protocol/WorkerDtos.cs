using System.Text.Json.Serialization;

namespace MinecraftCore.ArchiveWorker.Protocol;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class WorkerRequest
{
    public string? Operation { get; init; }
    public string? OperationId { get; init; }
    public string? ArchiveFamily { get; init; }
    public string? ResourcesRoot { get; init; }
    public string? ResourcesLayout { get; init; }
    public string? AppOwnedRoot { get; init; }
    public string? LeaseId { get; init; }
    public string? ControlToken { get; init; }
    public string? ControlPipeName { get; init; }
    public string? InputDirectory { get; init; }
    public string? ArchivePath { get; init; }
    public WorkerInputPart[]? InputParts { get; init; }
    public string? OutputDirectory { get; init; }
    public string? EntryName { get; init; }
    public string? MaxDataBytes { get; init; }
    public string? UserDataSentinel { get; init; }
    public WorkerLimits? Limits { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class WorkerInputPart
{
    public string? Path { get; init; }
    public string? Size { get; init; }
    public string? Sha256 { get; init; }
    public string? Sha512 { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class ControlFrame
{
    public string? Type { get; init; }
    public string? Token { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class WorkerLimits
{
    public int Version { get; init; }
    public string? MaxArtifactSetBytes { get; init; }
    public int MaxArchiveEntries { get; init; }
    public string? MaxExpandedBytes { get; init; }
    public string? MaxFileExpandedBytes { get; init; }
    public int MaxPathDepth { get; init; }
    public int MaxNormalizedPathLength { get; init; }
    public string? MaxTechnicalStdoutBytes { get; init; }
    public string? MaxTechnicalStderrBytes { get; init; }
    public int MaxListTestMs { get; init; }
    public int MaxExtractionMs { get; init; }
    public string? MaxChildJobMemoryBytes { get; init; }
    public int MaxPerEntryCompressionRatio { get; init; }
    public string? MinPerEntryRatioExpandedBytes { get; init; }
    public int MaxAggregateCompressionRatio { get; init; }
    public string? MinAggregateRatioExpandedBytes { get; init; }
    public string? MinPreflightReserveBytes { get; init; }
    public int PreflightReservePercent { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class WorkerFrame
{
    public required string Type { get; init; }
    public string? Text { get; init; }
    public string? Data { get; init; }
    public bool? Ok { get; init; }
    public int? ExitCode { get; init; }
    public string? ErrorCode { get; init; }
    public WorkerMetrics? Metrics { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class WorkerMetrics
{
    public required string StdoutBytes { get; init; }
    public required string StderrBytes { get; init; }
    public required string DataBytes { get; init; }
    public int ElapsedMs { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class DurableRequest
{
    public string? Operation { get; init; }
    public string? SourcePath { get; init; }
    public string? DestinationPath { get; init; }
    public string? DirectoryPath { get; init; }
    public DurableDirectoryRequest[]? Directories { get; init; }
    public string[]? AllowedRoots { get; init; }
    public DurableObjectIdentity? SourceIdentity { get; init; }
    public DurableObjectIdentity? SourceParentIdentity { get; init; }
    public DurableObjectIdentity? DestinationParentIdentity { get; init; }
    public DurableObjectIdentity? DestinationIdentity { get; init; }
    public DurableObjectIdentity? DirectoryIdentity { get; init; }
    public DurableRootIdentity[]? AllowedRootIdentities { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class DurableDirectoryRequest
{
    public string? DirectoryPath { get; init; }
    public DurableObjectIdentity? DirectoryIdentity { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class DurableRootIdentity
{
    public string? Path { get; init; }
    public DurableObjectIdentity? Identity { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class DurableObjectIdentity
{
    public string? FileType { get; init; }
    public string? Dev { get; init; }
    public string? Ino { get; init; }
    public string? Size { get; init; }
    public string? Birthtime { get; init; }
    public string? Mtime { get; init; }
    public string? Ctime { get; init; }
    public string? Sha256 { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class DurableResponse
{
    public bool Ok { get; init; }
    public string? FailureKind { get; init; }
    public string? FailureStage { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class ContainmentEvidence
{
    public bool AppContainer { get; init; }
    public bool ZeroCapabilities { get; init; }
    public bool ExactInputRead { get; init; }
    public bool ExactOutputWrite { get; init; }
    public bool AmbientTempReadDenied { get; init; }
    public bool AmbientTempWriteDenied { get; init; }
    public bool UserDataReadDenied { get; init; }
    public bool UserDataWriteDenied { get; init; }
    public bool LoopbackDenied { get; init; }
    public bool DescendantsDenied { get; init; }
    public bool UnrelatedEnvironmentAbsent { get; init; }
    public bool UnrelatedHandlesAbsent { get; init; }
    public bool BundleRuntimeInMemory { get; init; }
    public bool StandardInputClosed { get; init; }
    public bool CleanupKilledSurvivors { get; set; }
    public bool TemporaryAclRemoved { get; set; }
    public bool ProfileStoreClean { get; set; }
    public bool PublishedOutputAclClean { get; set; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class AclLeaseJournalFrame
{
    public string? Type { get; init; }
    public int? Schema { get; init; }
    public string? LeaseId { get; init; }
    public AclProcessIdentity? Process { get; init; }
    public AclGrantRecord? Grant { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class AclProcessIdentity
{
    public int ProcessId { get; init; }
    public long ProcessStartTimeUtcTicks { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class AclGrantRecord
{
    public string? Path { get; init; }
    public string? Sid { get; init; }
    public string? AccessMask { get; init; }
    public int AceFlags { get; init; }
    public int BaselineExactCount { get; init; }
    public bool Directory { get; init; }
    public string? VolumeSerialNumber { get; init; }
    public string? FileIndex { get; init; }
    public bool ScrubDescendants { get; init; }
}

internal sealed record ProcessCapture(byte[] StandardOutput, byte[] StandardError, int ExitCode, uint NativeExitCode, TimeSpan Elapsed);
