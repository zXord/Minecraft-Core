using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using MinecraftCore.ArchiveWorker.Protocol;
using MinecraftCore.ArchiveWorker.RecoveryTests;
using MinecraftCore.ArchiveWorker.Durability;
using MinecraftCore.ArchiveWorker.Sandbox;
using MinecraftCore.ArchiveWorker.Security;

static void Require(bool condition)
{
    if (!condition) throw new InvalidOperationException("ACL recovery policy assertion failed");
}

Require(AclRecoveryPolicy.CanReclaim(ProcessIdentityState.Exited, [ProcessIdentityState.Exited, ProcessIdentityState.Exited]));
Require(!AclRecoveryPolicy.CanReclaim(ProcessIdentityState.Live, [ProcessIdentityState.Exited]));
Require(!AclRecoveryPolicy.CanReclaim(ProcessIdentityState.Ambiguous, [ProcessIdentityState.Exited]));
Require(!AclRecoveryPolicy.CanReclaim(ProcessIdentityState.Exited, [ProcessIdentityState.Live]));
Require(!AclRecoveryPolicy.CanReclaim(ProcessIdentityState.Exited, [ProcessIdentityState.Ambiguous]));
Require(AclRecoveryPolicy.ExcessExactAceCount(4, 2) == 2);
Require(AclRecoveryPolicy.ExcessExactAceCount(2, 2) == 0);
try
{
    _ = AclRecoveryPolicy.ExcessExactAceCount(1, 2);
    throw new InvalidOperationException("Reduced ACL baseline was accepted");
}
catch (InvalidDataException) { }

string[] retryableDurabilityStages =
[
    "root-open",
    "source-open",
    "destination-parent-open",
    "source-parent-open",
    "ancestor-open",
    "preflight-revalidation"
];
int[] expectedDurabilityDelays = [50, 150, 400, 800];
foreach (string stage in retryableDurabilityStages)
{
    for (int retryIndex = 0; retryIndex < expectedDurabilityDelays.Length; retryIndex++)
    {
        Require(DurabilityRetryPolicy.TryGetDelayMilliseconds(
            "sharing-violation", stage, retryIndex, out int delayMilliseconds));
        Require(delayMilliseconds == expectedDurabilityDelays[retryIndex]);
    }
    Require(!DurabilityRetryPolicy.TryGetDelayMilliseconds(
        "sharing-violation", stage, expectedDurabilityDelays.Length, out _));
}
Require(expectedDurabilityDelays.Sum() <= 1_500);
foreach (string stage in new[]
{
    "handle-rename",
    "completion-flush",
    "published-identity",
    "final-revalidation",
    "request",
    "unknown"
})
{
    Require(!DurabilityRetryPolicy.TryGetDelayMilliseconds("sharing-violation", stage, 0, out _));
}
foreach (string failureKind in new[]
{
    "access-denied",
    "timeout",
    "integrity-failure",
    "io-failure",
    "worker-failure",
    "unknown"
})
{
    Require(!DurabilityRetryPolicy.TryGetDelayMilliseconds(
        failureKind, "destination-parent-open", 0, out _));
}

var transientDurabilityFailure = new IOException("transient durability failure");
int transientExecutions = 0;
var transientDelays = new List<int>();
await DurabilityRetryExecutor.ExecuteAsync(
    () =>
    {
        transientExecutions++;
        if (transientExecutions == 1) throw transientDurabilityFailure;
    },
    _ => "sharing-violation",
    _ => "destination-parent-open",
    delayMilliseconds =>
    {
        transientDelays.Add(delayMilliseconds);
        return Task.CompletedTask;
    });
Require(transientExecutions == 2);
Require(transientDelays.SequenceEqual([50]));

int exhaustedExecutions = 0;
var exhaustedDelays = new List<int>();
try
{
    await DurabilityRetryExecutor.ExecuteAsync(
        () =>
        {
            exhaustedExecutions++;
            throw transientDurabilityFailure;
        },
        _ => "sharing-violation",
        _ => "source-open",
        delayMilliseconds =>
        {
            exhaustedDelays.Add(delayMilliseconds);
            return Task.CompletedTask;
        });
    throw new InvalidOperationException("Exhausted durability retry unexpectedly succeeded");
}
catch (IOException exception) when (ReferenceEquals(exception, transientDurabilityFailure)) { }
Require(exhaustedExecutions == expectedDurabilityDelays.Length + 1);
Require(exhaustedDelays.SequenceEqual(expectedDurabilityDelays));

int ambiguousExecutions = 0;
try
{
    await DurabilityRetryExecutor.ExecuteAsync(
        () =>
        {
            ambiguousExecutions++;
            throw transientDurabilityFailure;
        },
        _ => "sharing-violation",
        _ => "handle-rename",
        _ => throw new InvalidOperationException("Ambiguous failure was delayed for retry"));
    throw new InvalidOperationException("Ambiguous durability failure unexpectedly succeeded");
}
catch (IOException exception) when (ReferenceEquals(exception, transientDurabilityFailure)) { }
Require(ambiguousExecutions == 1);

string stableDigest = new string('a', 64);
var expectedFileIdentity = new DurableExpectedIdentity(
    "file", 77, 88, 4, 101, 202, 303, stableDigest);
var ctimeDriftedFile = new DurableObjectSnapshot(
    "file", 77, 88, 4, 101, 202, 404, 0, stableDigest);
Require(ctimeDriftedFile.Matches(expectedFileIdentity));
Require(!(ctimeDriftedFile with { FileIndex = 89 }).Matches(expectedFileIdentity));
Require(!(ctimeDriftedFile with { Size = 5 }).Matches(expectedFileIdentity));
Require(!(ctimeDriftedFile with { Mtime = 203 }).Matches(expectedFileIdentity));
Require(!(ctimeDriftedFile with { Sha256 = new string('b', 64) }).Matches(expectedFileIdentity));
var intentionalMetadataDrift = ctimeDriftedFile with { Birthtime = 102, Mtime = 203 };
Require(intentionalMetadataDrift.Matches(expectedFileIdentity, allowMetadataChange: true));
Require(!(intentionalMetadataDrift with { FileIndex = 89 }).Matches(expectedFileIdentity, allowMetadataChange: true));
Require(!(intentionalMetadataDrift with { Size = 5 }).Matches(expectedFileIdentity, allowMetadataChange: true));
Require(!(intentionalMetadataDrift with { Sha256 = new string('b', 64) }).Matches(expectedFileIdentity, allowMetadataChange: true));
Require(!DurableObjectSnapshot.SamePublishedObject(
    ctimeDriftedFile,
    ctimeDriftedFile with { ReparseTag = 0xa000000c }));

string durableIdentityRoot = Path.Combine(Path.GetTempPath(), $"minecraft-core-native-ctime-{Guid.NewGuid():N}");
string durableIdentityFile = Path.Combine(durableIdentityRoot, "identity.bin");
Directory.CreateDirectory(durableIdentityRoot);
try
{
    File.WriteAllText(durableIdentityFile, "safe");
    DurableObjectSnapshot captured;
    using (DurablePinnedObject initial = DurablePinnedObject.OpenCurrent(
        durableIdentityFile, "file", includeHash: true, writeAccess: false, pinRename: false))
    {
        captured = initial.Identity;
    }
    var ctimeDriftExpectation = new DurableExpectedIdentity(
        captured.FileType, captured.Device, captured.FileIndex, captured.Size,
        captured.Birthtime, captured.Mtime, captured.Ctime + 100, captured.Sha256);
    using DurablePinnedObject ctimeDriftPin = DurablePinnedObject.Open(
        durableIdentityFile, ctimeDriftExpectation, writeAccess: false, pinRename: false);
    ctimeDriftPin.Revalidate(requirePath: true);

    string movedIdentityFile = Path.Combine(durableIdentityRoot, "moved.bin");
    File.Move(durableIdentityFile, movedIdentityFile);
    try
    {
        ctimeDriftPin.Revalidate(requirePath: true);
        throw new InvalidOperationException("Durable path substitution was accepted");
    }
    catch (InvalidDataException) { }
}
finally
{
    string resolvedIdentityRoot = Path.GetFullPath(durableIdentityRoot);
    string resolvedTempRoot = Path.GetFullPath(Path.GetTempPath());
    Require(resolvedIdentityRoot.StartsWith(resolvedTempRoot, StringComparison.OrdinalIgnoreCase));
    Require(Path.GetFileName(resolvedIdentityRoot).StartsWith("minecraft-core-native-ctime-", StringComparison.Ordinal));
    Directory.Delete(resolvedIdentityRoot, recursive: true);
}

Require(PathInputPolicy.HasTraversalAlias(@"C:\owned\.\source.zip"));
Require(PathInputPolicy.HasTraversalAlias(@"C:\owned\..\source.zip"));
Require(PathInputPolicy.HasTraversalAlias("C:/owned/../source.zip"));
Require(PathInputPolicy.HasTraversalAlias(@"C:\owned/../source.zip"));
Require(!PathInputPolicy.HasTraversalAlias(@"C:\owned\source.zip"));
Require(!PathInputPolicy.HasTraversalAlias(@"C:\owned\dot..name\source.zip"));

Require(!ReparseTagPolicy.IsNameSurrogate(0x00000000));
Require(!ReparseTagPolicy.IsNameSurrogate(0x9000601a));
Require(ReparseTagPolicy.IsNameSurrogate(0xa000000c));
Require(ReparseTagPolicy.IsNameSurrogate(0xa0000003));

Require(NativeFilePath.ForApi(@"C:\owned\file.zip") == @"\\?\C:\owned\file.zip");
foreach (string rejectedNativePath in new[] { @"relative\file.zip", @"\\server\share\file.zip", @"\\?\C:\owned\file.zip", @"C:\owned\bad:name" })
{
    try
    {
        _ = NativeFilePath.ForApi(rejectedNativePath);
        throw new InvalidOperationException("Unsafe native file path was accepted");
    }
    catch (InvalidDataException) { }
}

Require(AclAccessMaskPolicy.MapFile(AclAccessMaskPolicy.GenericRead) == AclAccessMaskPolicy.FileGenericRead);
Require(AclAccessMaskPolicy.MapFile(AclAccessMaskPolicy.GenericRead | AclAccessMaskPolicy.GenericExecute) == 0x001200a9);
Require(AclAccessMaskPolicy.MapFile(AclAccessMaskPolicy.GenericRead | AclAccessMaskPolicy.GenericWrite | 0x20) == 0x001201bf);
Require(AclAccessMaskPolicy.MapFile(AclAccessMaskPolicy.GenericRead | AclAccessMaskPolicy.GenericWrite | AclAccessMaskPolicy.GenericExecute | 0x00010000) == 0x001301bf);
Require(AclAccessMaskPolicy.MapFile(0x20) == 0x20);
try
{
    _ = AclAccessMaskPolicy.MapFile(AclAccessMaskPolicy.GenericAll);
    throw new InvalidOperationException("Generic-all ACL grant was accepted");
}
catch (InvalidDataException) { }

var protocolProbe = new ProtocolProbe
{
    Operation = "list",
    InputParts = Enumerable.Range(0, 512).Select(index => new ProtocolPart
    {
        Path = $@"C:\owned\input\{new string('p', 160)}-{index:D4}.zip",
        Size = "1234567",
        Sha256 = new string('a', 64),
        Sha512 = new string('b', 128)
    }).ToArray()
};
byte[] protocolBody = JsonSerializer.SerializeToUtf8Bytes(protocolProbe, ProtocolTestJsonContext.Default.ProtocolProbe);
Require(protocolBody.Length > 128 * 1024 && protocolBody.Length < 1024 * 1024);
byte[] protocolFrame = new byte[protocolBody.Length + 4];
BinaryPrimitives.WriteUInt32LittleEndian(protocolFrame, checked((uint)protocolBody.Length));
protocolBody.CopyTo(protocolFrame.AsSpan(4));
ProtocolProbe parsedProtocol = await FrameReader.ReadExactlyOneAsync(new MemoryStream(protocolFrame), ProtocolTestJsonContext.Default.ProtocolProbe, CancellationToken.None);
Require(parsedProtocol.InputParts?.Length == 512);

string scalarBoundary = $"{new string('x', 3)}\U0001f600y";
string[] scalarChunks = TextChunker.SplitScalars(scalarBoundary, 4).ToArray();
Require(scalarChunks.SequenceEqual(["xxx", "\U0001f600y"], StringComparer.Ordinal));
Require(string.Concat(scalarChunks) == scalarBoundary);
var strictUtf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);
foreach (string scalarChunk in scalarChunks) _ = strictUtf8.GetBytes(scalarChunk);

var registrations = new List<string> { "fresh-output" };
int cleanupAttempts = 0;
int scrubAttempts = 0;
int closeAttempts = 0;
try
{
    AclCompletionPolicy.Complete(registrations, () => cleanupAttempts++, _ =>
    {
        scrubAttempts++;
        throw new IOException("injected scrub failure");
    }, () => closeAttempts++, registrations.Clear);
    throw new InvalidOperationException("Injected ACL scrub failure was ignored");
}
catch (IOException exception) when (exception.Message == "injected scrub failure") { }
Require(registrations.SequenceEqual(["fresh-output"]));
Require(cleanupAttempts == 1 && scrubAttempts == 1 && closeAttempts == 0);
AclCompletionPolicy.Complete(registrations, () => cleanupAttempts++, _ => scrubAttempts++, () => closeAttempts++, registrations.Clear);
Require(registrations.Count == 0);
Require(cleanupAttempts == 2 && scrubAttempts == 2 && closeAttempts == 1);

var crossThreadMutex = NamedMutexScope.Enter($@"Local\MinecraftCore.ArchiveWorker.Tests.{Guid.NewGuid():N}");
await Task.Run(crossThreadMutex.Dispose);
crossThreadMutex.Dispose();
