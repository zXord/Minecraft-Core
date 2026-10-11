using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Runtime.InteropServices;
using MinecraftCore.ArchiveWorker.Security;
using MinecraftCore.ArchiveWorker.Sandbox;
using System.Text;
using System.Buffers.Binary;
using MinecraftCore.ArchiveWorker.Durability;
using MinecraftCore.ArchiveWorker.Protocol;

namespace MinecraftCore.ArchiveWorker.RecoveryTests;

internal static partial class ExactDeleteTests
{
    internal static void Run()
    {
        if (!OperatingSystem.IsWindows() || RuntimeInformation.ProcessArchitecture != Architecture.X64) throw new InvalidOperationException("Windows x64 required");
        Console.WriteLine($"exact-delete-runtime: {Environment.Version}; {RuntimeInformation.FrameworkDescription}; {RuntimeInformation.ProcessArchitecture}");
        ProductionDeleteFailureProtocol();
        ExactDeleteRegularFile();
        SubstitutionBeforeOpen();
        SubstitutionAfterOpenDenied();
        RejectDirectoryHardlinkAndRedirect();
        SharingConflictBeforeEffect();
        CrashAtDispositionCloseFlush();
        RejectMixedAndMissingRequestFields();
        RejectChangedIdentityAndLineage();
        ReconcileAbsencePreservesReplacement();
        NestedRootLineageIsComplete();
        Console.WriteLine("exact-delete-only: passed");
    }

    private sealed class Fixture : IDisposable
    {
        internal readonly string Root = Path.Combine(Path.GetTempPath(), "minecraft-exact-delete-" + Guid.NewGuid().ToString("N"));
        internal readonly string Leaf;
        private readonly HashSet<string> owned = new(StringComparer.OrdinalIgnoreCase);
        internal Fixture()
        {
            Check(!Directory.Exists(Root) && !File.Exists(Root));
            Directory.CreateDirectory(Root);
            Leaf = Owned("leaf"); File.WriteAllText(Leaf, "authorized bytes");
        }
        internal string Owned(string name)
        {
            string value = Path.GetFullPath(Path.Combine(Root, name));
            Check(Path.GetRelativePath(Root, value) is var relative && !relative.StartsWith("..") && !Path.IsPathRooted(relative));
            owned.Add(value);
            return value;
        }
        internal DurableRequest Request(string mode = "delete") => JsonSerializer.Deserialize<DurableRequest>(JsonSerializer.Serialize(new
        {
            operation = "delete-file-exact", sourcePath = Leaf, sourceIdentity = Identity(Leaf, "file"),
            sourceParentIdentity = Identity(Root, "directory"), allowedRoots = new[] { Root },
            allowedRootIdentities = new[] { new { path = Root, identity = Identity(Root, "directory") } },
            ancestorIdentities = Array.Empty<object>(), mode
        }, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }), new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase })!;
        public void Dispose()
        {
            Check(Path.GetDirectoryName(Root) == Path.TrimEndingDirectorySeparator(Path.GetTempPath()) && Path.GetFileName(Root).StartsWith("minecraft-exact-delete-"));
            foreach (string entry in owned.OrderByDescending(value => value.Length))
            {
                if (Directory.Exists(entry)) Directory.Delete(entry); else File.Delete(entry);
            }
            Directory.Delete(Root);
        }
    }
    private static DurableObjectIdentity Identity(string path, string type)
    {
        using var pin = DurablePinnedObject.OpenCurrent(path, type, includeHash: type == "file", writeAccess: false, pinRename: false);
        var v = pin.Identity;
        return new DurableObjectIdentity { FileType = type, Dev = v.Device.ToString(CultureInfo.InvariantCulture), Ino = v.FileIndex.ToString(CultureInfo.InvariantCulture),
            Size = v.Size.ToString(CultureInfo.InvariantCulture), Birthtime = v.Birthtime.ToString(CultureInfo.InvariantCulture),
            Mtime = v.Mtime.ToString(CultureInfo.InvariantCulture), Ctime = v.Ctime.ToString(CultureInfo.InvariantCulture), Sha256 = v.Sha256 };
    }
    private static void Check(bool value) { if (!value) throw new InvalidOperationException("Exact deletion assertion failed"); }

    private static void ProductionDeleteFailureProtocol()
    {
        var mismatches = new List<string>();
        foreach (string stage in new[] { "handle-disposition", "delete-close", "delete-parent-flush" })
        {
            var exception = new DurabilityFailureException(stage,
                new IOException("sharing conflict at deletion boundary", new System.ComponentModel.Win32Exception(32)));
            var response = DurableFailureProtocol.FailureResponse(exception, exactDelete: true);
            string json = JsonSerializer.Serialize(response, JsonOptions);
            string expected = $"{{\"ok\":false,\"failureKind\":\"sharing-violation\",\"failureStage\":\"{stage}\",\"effectState\":\"uncertain\"}}";
            if (json != expected) mismatches.Add($"expected {expected}; actual {json}");
            int attempts = 0;
            var actual = Refuses(() => DurabilityRetryExecutor.ExecuteAsync(
                () => { attempts++; throw exception; }, DurableFailureProtocol.ClassifyFailure,
                DurableFailureProtocol.ClassifyFailureStage,
                _ => throw new InvalidOperationException("Post-effect production failure was retried")).GetAwaiter().GetResult());
            Check(ReferenceEquals(actual, exception) && attempts == 1);
        }
        if (mismatches.Count != 0) throw new InvalidOperationException("Production failure protocol mismatch:\n" + string.Join("\n", mismatches));
        var oldFailure = new DurabilityFailureException("completion-flush", new IOException("old operation"));
        Check(JsonSerializer.Serialize(DurableFailureProtocol.FailureResponse(oldFailure, exactDelete: false), JsonOptions) ==
            "{\"ok\":false,\"failureKind\":\"io-failure\",\"failureStage\":\"completion-flush\"}");
        Check(JsonSerializer.Serialize(new DurableResponse { Ok = true }, JsonOptions) == "{\"ok\":true}");
        Console.WriteLine("ProductionDeleteFailureProtocol: passed (3 post-effect stages; original kind/effect; no retry; old frames unchanged)");
    }
    private static Exception Refuses(Action action)
    {
        try { action(); } catch (Exception e) { return e; }
        throw new InvalidOperationException("Unsafe exact deletion accepted");
    }
    private static void Execute(DurableRequest request, Action<string>? stage = null)
    {
        if (stage is null) { DurableFilesystem.Execute(request); return; }
        var method = typeof(DurableFilesystem).GetMethod("Execute", BindingFlags.Static | BindingFlags.NonPublic, null, [typeof(DurableRequest), typeof(Action<string>)], null);
        Check(method is not null);
        try { method!.Invoke(null, [request, stage]); }
        catch (TargetInvocationException e) { throw e.InnerException!; }
    }
    private static void ExactDeleteRegularFile()
    {
        using var f = new Fixture(); var request = f.Request();
        string sibling = f.Owned("sibling"); File.WriteAllText(sibling, "preserve");
        var stages = new List<string>(); Execute(request, stages.Add);
        Check(!File.Exists(f.Leaf) && File.ReadAllText(sibling) == "preserve");
        Check(stages.IndexOf("delete-close") < stages.IndexOf("delete-parent-flush"));
        Console.WriteLine("ExactDeleteRegularFile: passed");
    }
    private static void SubstitutionBeforeOpen()
    {
        using var f = new Fixture(); var request = f.Request();
        File.Move(f.Leaf, f.Owned("original")); File.WriteAllText(f.Leaf, "authorized bytes");
        Refuses(() => Execute(request)); Check(File.Exists(f.Leaf));
        Console.WriteLine("SubstitutionBeforeOpen: passed");
    }
    private static void SubstitutionAfterOpenDenied()
    {
        using var f = new Fixture(); var request = f.Request(); bool denied = false;
        Execute(request, stage => { if (stage == "preflight-revalidation") { Refuses(() => File.Move(f.Leaf, f.Owned("replacement"))); denied = true; } });
        Check(denied && !File.Exists(f.Leaf));
        Console.WriteLine("SubstitutionAfterOpenDenied: passed");
    }
    private static void RejectDirectoryHardlinkAndRedirect()
    {
        using var f = new Fixture(); var request = f.Request();
        File.Delete(f.Leaf); Directory.CreateDirectory(f.Leaf);
        Refuses(() => Execute(request)); Check(Directory.Exists(f.Leaf));
        Directory.Delete(f.Leaf); File.WriteAllText(f.Leaf, "authorized bytes"); request = f.Request();
        Check(CreateHardLink(f.Owned("hardlink"), f.Leaf, nint.Zero));
        Refuses(() => Execute(request)); Check(File.Exists(f.Leaf)); File.Delete(f.Owned("hardlink"));
        File.Delete(f.Leaf); Directory.CreateDirectory(f.Owned("redirect-target"));
        Directory.CreateDirectory(f.Leaf); SetJunction(f.Leaf, f.Owned("redirect-target"));
        Refuses(() => Execute(request)); Check(Directory.Exists(f.Owned("redirect-target")));
        Check(!ReparseTagPolicy.IsNameSurrogate(0x80000017) && ReparseTagPolicy.IsNameSurrogate(0xA000000C));
        Console.WriteLine("RejectDirectoryHardlinkAndRedirect: directory, hardlink, junction and nonredirecting policy passed");
    }
    private static void SharingConflictBeforeEffect()
    {
        using var f = new Fixture(); var request = f.Request();
        using var held = new FileStream(f.Leaf, FileMode.Open, FileAccess.Read, FileShare.Read);
        Refuses(() => Execute(request)); Check(File.Exists(f.Leaf));
        Console.WriteLine("SharingConflictBeforeEffect: passed");
    }
    private static void CrashAtDispositionCloseFlush()
    {
        foreach (string fault in new[] { "handle-disposition", "after-disposition", "delete-close", "after-close", "delete-parent-flush", "after-parent-flush" })
        {
            using var f = new Fixture(); var request = f.Request(); int effects = 0;
            string expectedStage = fault switch { "after-disposition" => "handle-disposition", "after-close" => "delete-close", "after-parent-flush" => "delete-parent-flush", _ => fault };
            int attempts = 0;
            var failure = Refuses(() => DurabilityRetryExecutor.ExecuteAsync(() =>
            {
                attempts++;
                Execute(request, stage => { if (stage == "handle-disposition") effects++; if (stage == fault) throw new IOException("injected interruption"); });
            }, _ => "sharing-violation", e => ((DurabilityFailureException)e).FailureStage, _ => Task.CompletedTask).GetAwaiter().GetResult());
            Check(failure is DurabilityFailureException error && error.FailureStage == expectedStage && error.EffectState == "uncertain");
            Check(effects == 1 && attempts == 1 && !DurabilityRetryPolicy.TryGetDelayMilliseconds("sharing-violation", expectedStage, 0, out _));
        }
        Console.WriteLine("CrashAtDispositionCloseFlush: passed");
    }

    [LibraryImport("kernel32.dll", EntryPoint = "CreateHardLinkW", StringMarshalling = StringMarshalling.Utf16, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CreateHardLink(string newName, string existingName, nint security);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool DeviceIoControl(nint handle, uint control, byte[] input, uint inputSize, nint output, uint outputSize, out uint returned, nint overlapped);

    private static void SetJunction(string link, string target)
    {
        byte[] substitute = Encoding.Unicode.GetBytes(@"\??\" + target);
        byte[] display = Encoding.Unicode.GetBytes(target);
        byte[] buffer = new byte[16 + substitute.Length + 2 + display.Length + 2];
        BinaryPrimitives.WriteUInt32LittleEndian(buffer, 0xA0000003);
        BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(4), checked((ushort)(buffer.Length - 8)));
        BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(10), checked((ushort)substitute.Length));
        BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(12), checked((ushort)(substitute.Length + 2)));
        BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(14), checked((ushort)display.Length));
        substitute.CopyTo(buffer, 16); display.CopyTo(buffer, 18 + substitute.Length);
        nint handle = NativeMethods.CreateFile(NativeFilePath.ForApi(link), NativeMethods.GenericWrite, 0, nint.Zero, NativeMethods.OpenExisting,
            NativeMethods.FileFlagOpenReparsePoint | NativeMethods.FileFlagBackupSemantics, nint.Zero);
        Check(handle != NativeMethods.InvalidHandleValue);
        try { Check(DeviceIoControl(handle, 0x000900A4, buffer, (uint)buffer.Length, nint.Zero, 0, out _, nint.Zero)); }
        finally { NativeMethods.CloseHandle(handle); }
    }

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
    private static DurableRequest Change(DurableRequest request, Action<JsonObject> change)
    {
        var node = JsonNode.Parse(JsonSerializer.Serialize(request, JsonOptions))!.AsObject(); change(node);
        return node.Deserialize<DurableRequest>(JsonOptions)!;
    }
    private static void RejectMixedAndMissingRequestFields()
    {
        using var f = new Fixture(); var request = f.Request();
        foreach (string field in new[] { "destinationPath", "destinationIdentity", "destinationParentIdentity", "directoryPath", "directoryIdentity", "directories", "unknown" })
        {
            Refuses(() => Execute(Change(request, node => node[field] = null)));
            Check(File.Exists(f.Leaf));
        }
        foreach (string field in new[] { "sourceIdentity", "sourceParentIdentity", "allowedRootIdentities", "ancestorIdentities", "mode" })
        {
            Refuses(() => Execute(Change(request, node => node.Remove(field)))); Check(File.Exists(f.Leaf));
        }
        Console.WriteLine("RejectMixedAndMissingRequestFields: passed");
    }
    private static void RejectChangedIdentityAndLineage()
    {
        using var f = new Fixture(); var request = f.Request();
        foreach (var pair in new Dictionary<string, string> { ["sha256"] = new string('0', 64), ["size"] = "0", ["birthtime"] = "1", ["mtime"] = "1", ["ino"] = "1", ["fileType"] = "directory" })
        {
            Refuses(() => Execute(Change(request, node => node["sourceIdentity"]![pair.Key] = pair.Value)));
            Check(File.Exists(f.Leaf));
        }
        Refuses(() => Execute(Change(request, node => node["sourceParentIdentity"]!["ino"] = "1")));
        Refuses(() => Execute(Change(request, node => node["allowedRootIdentities"]![0]!["identity"]!["ino"] = "1")));
        Refuses(() => Execute(Change(request, node => node["ancestorIdentities"] = JsonSerializer.SerializeToNode(new[] { new { path = f.Root, identity = Identity(f.Root, "directory") } }, JsonOptions))));
        // Ctime-only metadata drift retains the established compatibility policy.
        Execute(Change(request, node => node["sourceIdentity"]!["ctime"] = "1")); Check(!File.Exists(f.Leaf));
        Console.WriteLine("RejectChangedIdentityAndLineage: passed");
    }
    private static void ReconcileAbsencePreservesReplacement()
    {
        using var f = new Fixture(); var request = f.Request("reconcile-absent");
        Refuses(() => Execute(request)); Check(File.Exists(f.Leaf));
        File.Delete(f.Leaf); Execute(request);
        File.WriteAllText(f.Leaf, "replacement"); Refuses(() => Execute(request)); Check(File.ReadAllText(f.Leaf) == "replacement");
        Console.WriteLine("ReconcileAbsencePreservesReplacement: passed");
    }

    private static void NestedRootLineageIsComplete()
    {
        using var f = new Fixture();
        string first = f.Owned("first"), nested = f.Owned("first/nested"), parent = f.Owned("first/nested/parent"), leaf = f.Owned("first/nested/parent/leaf");
        Directory.CreateDirectory(first); Directory.CreateDirectory(nested); Directory.CreateDirectory(parent); File.WriteAllText(leaf, "nested");
        var request = Change(f.Request(), node =>
        {
            node["sourcePath"] = leaf; node["sourceIdentity"] = JsonSerializer.SerializeToNode(Identity(leaf, "file"), JsonOptions);
            node["sourceParentIdentity"] = JsonSerializer.SerializeToNode(Identity(parent, "directory"), JsonOptions);
            node["allowedRoots"]!.AsArray().Add(nested);
            node["allowedRootIdentities"]!.AsArray().Add(JsonSerializer.SerializeToNode(new { path = nested, identity = Identity(nested, "directory") }, JsonOptions));
        });
        Refuses(() => Execute(request)); Check(File.Exists(leaf));
        request = Change(request, node => node["ancestorIdentities"] = JsonSerializer.SerializeToNode(new[] {
            new { path = first, identity = Identity(first, "directory") }, new { path = nested, identity = Identity(nested, "directory") } }, JsonOptions));
        Refuses(() => Execute(Change(request, node => node["ancestorIdentities"]![0]!["identity"]!["ino"] = "1")));
        Execute(request); Check(!File.Exists(leaf) && File.Exists(f.Leaf));
        Console.WriteLine("NestedRootLineageIsComplete: passed");
    }
}
