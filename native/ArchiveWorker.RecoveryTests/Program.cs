using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using MinecraftCore.ArchiveWorker.Protocol;
using MinecraftCore.ArchiveWorker.RecoveryTests;
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
