using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MinecraftCore.ArchiveWorker.Durability;
using MinecraftCore.ArchiveWorker.Protocol;
using MinecraftCore.ArchiveWorker.Sandbox;
using MinecraftCore.ArchiveWorker.Security;
using MinecraftCore.ArchiveWorker.SevenZip;

namespace MinecraftCore.ArchiveWorker;

internal static partial class Program
{
    private const ulong JobMemoryLimit = 2UL * 1024 * 1024 * 1024;
    private static readonly TimeSpan ControlHeartbeatTimeout = TimeSpan.FromSeconds(15);
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", RegexOptions.CultureInvariant)]
    private static partial Regex IdentifierPattern();

    private static async Task<int> Main(string[] args)
    {
        if (!OperatingSystem.IsWindows() || RuntimeInformation.ProcessArchitecture != Architecture.X64) return 70;
        try
        {
            if (args.Length == 1 && args[0] == "--durable-fs") return await RunDurabilityAsync().ConfigureAwait(false);
            if (args.Length == 11 && args[0] == "--sandbox-probe-child") return RunProbe(args);
            if (args.Length == 1 && args[0] == "--probe-descendant") return 0;
            if (args.Length == 1 && args[0] == "--probe-hang") { Thread.Sleep(Timeout.Infinite); return 0; }
            if (args.Length == 3 && args[0] == "--preserve-workspace-fixture") return PreserveWorkspaceFixture(args[1], args[2]);
            if (args.Length == 2 && args[0] == "--cancelled-staging-self-test") return CancelledStagingSelfTest(args[1]);
            if (args.Length == 3 && args[0] == "--cancelled-runtime-self-test") return CancelledRuntimeSelfTest(args[1], args[2]);
            if (args.Length == 3 && args[0] == "--build-self-test") return await RunBuildSelfTestAsync(args[1], args[2]).ConfigureAwait(false);
            if (args.Length != 0) return 64;
            return await RunFramedWorkerAsync().ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            if (args.Length > 0 && args[0] == "--build-self-test") Console.Error.WriteLine(exception);
            return 70;
        }
    }

    private static async Task<int> RunDurabilityAsync()
    {
        try
        {
            DurableRequest request = await FrameReader.ReadExactlyOneAsync(Console.OpenStandardInput(), WorkerJsonContext.Default.DurableRequest, CancellationToken.None).ConfigureAwait(false);
            DurableFilesystem.Execute(request);
            await FrameWriter.WriteAsync(Console.OpenStandardOutput(), new DurableResponse { Ok = true }, WorkerJsonContext.Default.DurableResponse).ConfigureAwait(false);
            return 0;
        }
        catch
        {
            return 1;
        }
    }

    private static async Task<int> RunFramedWorkerAsync()
    {
        Stream output = Console.OpenStandardOutput();
        var stopwatch = Stopwatch.StartNew();
        long stdoutBytes = 0;
        long stderrBytes = 0;
        long dataBytes = 0;
        try
        {
            WorkerRequest request = await FrameReader.ReadExactlyOneAsync(Console.OpenStandardInput(), WorkerJsonContext.Default.WorkerRequest, CancellationToken.None).ConfigureAwait(false);
            ValidateLimits(request.Limits);
            ValidateControlIdentity(request);
            using var operationCancellation = new CancellationTokenSource();
            using var controlStop = new CancellationTokenSource();
            string pipeName = request.ControlPipeName!["\\\\.\\pipe\\".Length..];
            await using var controlPipe = new NamedPipeClientStream(".", pipeName, PipeDirection.In, PipeOptions.Asynchronous);
            await controlPipe.ConnectAsync(5000, CancellationToken.None).ConfigureAwait(false);
            Task controlTask = MonitorControlAsync(controlPipe, request.ControlToken!, operationCancellation, controlStop.Token);
            Exception? failure = null;
            int terminalExitCode = 0;
            string? terminalErrorCode = null;
            try
            {
                if (request.Operation == "self-test")
                {
                    ValidateSelfTestShape(request);
                    ContainmentEvidence evidence = await ExecuteSelfTestAsync(request.ResourcesRoot!, request.ResourcesLayout!, request.AppOwnedRoot!, request.LeaseId!, request.UserDataSentinel!, request.Limits!, operationCancellation.Token).ConfigureAwait(false);
                    byte[] evidenceBytes = JsonSerializer.SerializeToUtf8Bytes(evidence, WorkerJsonContext.Default.ContainmentEvidence);
                    dataBytes = evidenceBytes.Length;
                    await FrameWriter.WriteAsync(output, new WorkerFrame { Type = "data", Data = Convert.ToBase64String(evidenceBytes) }, WorkerJsonContext.Default.WorkerFrame).ConfigureAwait(false);
                }
                else
                {
                    (stdoutBytes, stderrBytes, dataBytes, terminalExitCode, terminalErrorCode) = await ExecuteArchiveAsync(request, output, operationCancellation.Token).ConfigureAwait(false);
                }
            }
            catch (Exception exception)
            {
                failure = exception;
                terminalExitCode = 1;
                terminalErrorCode = Redaction.StableErrorCode(exception);
            }
            finally
            {
                controlStop.Cancel();
                try { await controlTask.ConfigureAwait(false); }
                catch (OperationCanceledException) when (controlStop.IsCancellationRequested) { }
                catch (Exception exception)
                {
                    failure ??= exception;
                    terminalExitCode = 1;
                    terminalErrorCode = Redaction.StableErrorCode(exception);
                }
            }
            bool ok = failure is null && terminalExitCode == 0;
            await WriteStatusAsync(output, ok, terminalExitCode, ok ? null : terminalErrorCode ?? "EXTRACTOR_FAILED", stdoutBytes, stderrBytes, dataBytes, stopwatch.Elapsed).ConfigureAwait(false);
            return 0;
        }
        catch (Exception exception)
        {
            await WriteStatusAsync(output, false, 1, Redaction.StableErrorCode(exception), stdoutBytes, stderrBytes, dataBytes, stopwatch.Elapsed).ConfigureAwait(false);
            return 0;
        }
    }

    private static async Task<(long StdoutBytes, long StderrBytes, long DataBytes, int ExitCode, string? ErrorCode)> ExecuteArchiveAsync(WorkerRequest request, Stream protocolOutput, CancellationToken cancellationToken)
    {
        ValidateArchiveShape(request);
        using SevenZipRuntime sourceRuntime = SevenZipRuntimeVerifier.Verify(request.ResourcesRoot!, request.ResourcesLayout!, cancellationToken);
        using AppContainerProfile profile = AppContainerProfile.Open(request.AppOwnedRoot!);
        using OperationWorkspace workspace = OperationWorkspace.Create(request.AppOwnedRoot!, request.LeaseId!);
        workspace.StageInputs(request.InputDirectory!, request.ArchivePath!, request.InputParts!, cancellationToken);
        using SevenZipRuntime runtime = SevenZipRuntimeVerifier.Stage(sourceRuntime, workspace.Engine, cancellationToken);
        string? publishedOutput = null;
        string? sandboxOutput = null;
        if (request.Operation == "extract")
        {
            publishedOutput = CanonicalPaths.ExistingDirectory(request.OutputDirectory!);
            if (Directory.EnumerateFileSystemEntries(publishedOutput).Any()) throw new InvalidDataException("Output must be empty");
            sandboxOutput = workspace.Output;
        }
        using AclLease grants = AclLease.Begin(request.AppOwnedRoot!, request.LeaseId!, profile.Sid);
        try
        {
            grants.GrantTraverseDirectory(runtime.EngineDirectory);
            grants.GrantReadExecuteFile(runtime.Executable);
            grants.GrantReadExecuteFile(runtime.Library);
            grants.GrantReadTraverseDirectory(workspace.Input);
            foreach (PinnedFile inputPin in workspace.StagedInputPins) grants.GrantReadFile(inputPin.Path);
            if (sandboxOutput is not null) grants.GrantReadWriteDirectory(sandboxOutput);
            grants.GrantReadWriteDirectory(workspace.Scratch);
            runtime.Revalidate();
            foreach (PinnedFile inputPin in workspace.StagedInputPins) inputPin.Revalidate();
            SevenZipCommand command = SevenZipCommandFactory.Create(runtime.Executable, request.Operation!, request.ArchiveFamily!, workspace.ArchivePath!, workspace.Scratch, sandboxOutput, request.EntryName);
            var environment = MinimalEnvironment(workspace.Scratch, bundleDirectory: null);
            int deadlineMs = request.Operation == "extract" ? request.Limits!.MaxExtractionMs : request.Limits!.MaxListTestMs;
            long policyStdoutLimit = ParseDecimal(request.Limits!.MaxTechnicalStdoutBytes!, 64 * 1024 * 1024);
            long stdoutLimit = request.Operation == "read-entry" && request.MaxDataBytes is not null ?
                ParseDecimal(request.MaxDataBytes, policyStdoutLimit, requirePositive: true) : policyStdoutLimit;
            long stderrLimit = ParseDecimal(request.Limits!.MaxTechnicalStderrBytes!, 8 * 1024 * 1024);
            ProcessCapture capture = await SandboxedProcess.RunAsync(command.Executable, command.Arguments, runtime.EngineDirectory, environment, profile.Sid,
                TimeSpan.FromMilliseconds(Math.Max(1, deadlineMs - 5000)), JobMemoryLimit, stdoutLimit, stderrLimit, cancellationToken,
                grants.RegisterChild).ConfigureAwait(false);
            long framedStdout = 0;
            long framedStderr = 0;
            long framedData = 0;
            if (request.Operation == "read-entry")
            {
                framedData = capture.StandardOutput.LongLength;
                await WriteDataChunksAsync(protocolOutput, capture.StandardOutput).ConfigureAwait(false);
            }
            else
            {
                framedStdout = capture.StandardOutput.LongLength;
                await WriteTextChunksAsync(protocolOutput, "stdout", capture.StandardOutput).ConfigureAwait(false);
            }
            framedStderr = capture.StandardError.LongLength;
            await WriteTextChunksAsync(protocolOutput, "stderr", capture.StandardError).ConfigureAwait(false);
            string diagnostics = (request.Operation == "read-entry" ? string.Empty : StrictUtf8.GetString(capture.StandardOutput)) + StrictUtf8.GetString(capture.StandardError);
            string? error = capture.ExitCode == 0 ? null : diagnostics.Contains("password", StringComparison.OrdinalIgnoreCase) ? "ENCRYPTED_ARCHIVE" : "EXTRACTOR_FAILED";
            _ = sandboxOutput is null ? grants.Complete() : grants.Complete(sandboxOutput);
            _ = profile.VerifyStoreCleanAndClose();
            if (capture.ExitCode == 0 && publishedOutput is not null) workspace.PublishOutput(publishedOutput);
            return (framedStdout, framedStderr, framedData, capture.ExitCode, error);
        }
        catch (QuiescenceUnprovenException)
        {
            workspace.PreserveForRecovery();
            grants.PreserveForRecovery();
            profile.PreserveForRecovery();
            Environment.FailFast("Sandbox process quiescence could not be proven");
            throw;
        }
    }

    private static async Task WriteTextChunksAsync(Stream output, string type, byte[] bytes)
    {
        if (bytes.Length == 0) return;
        string text = StrictUtf8.GetString(bytes);
        const int maximumCharacters = 128 * 1024;
        foreach (string chunk in TextChunker.SplitScalars(text, maximumCharacters))
        {
            await FrameWriter.WriteAsync(output, new WorkerFrame { Type = type, Text = chunk }, WorkerJsonContext.Default.WorkerFrame).ConfigureAwait(false);
        }
    }

    private static async Task WriteDataChunksAsync(Stream output, byte[] bytes)
    {
        const int maximumBytes = 256 * 1024;
        for (int offset = 0; offset < bytes.Length; offset += maximumBytes)
        {
            int count = Math.Min(maximumBytes, bytes.Length - offset);
            await FrameWriter.WriteAsync(output, new WorkerFrame { Type = "data", Data = Convert.ToBase64String(bytes, offset, count) }, WorkerJsonContext.Default.WorkerFrame).ConfigureAwait(false);
        }
    }

    private static async Task WriteStatusAsync(Stream output, bool ok, int exitCode, string? errorCode, long stdoutBytes, long stderrBytes, long dataBytes, TimeSpan elapsed)
    {
        var frame = new WorkerFrame
        {
            Type = "status",
            Ok = ok,
            ExitCode = exitCode,
            ErrorCode = errorCode,
            Metrics = new WorkerMetrics
            {
                StdoutBytes = stdoutBytes.ToString(CultureInfo.InvariantCulture),
                StderrBytes = stderrBytes.ToString(CultureInfo.InvariantCulture),
                DataBytes = dataBytes.ToString(CultureInfo.InvariantCulture),
                ElapsedMs = (int)Math.Min(elapsed.TotalMilliseconds, int.MaxValue)
            }
        };
        await FrameWriter.WriteAsync(output, frame, WorkerJsonContext.Default.WorkerFrame).ConfigureAwait(false);
    }

    private static async Task<ContainmentEvidence> ExecuteSelfTestAsync(string resourcesRoot, string resourcesLayout, string appOwnedRoot, string leaseId, string userDataSentinelValue, WorkerLimits limits, CancellationToken cancellationToken)
    {
        using SevenZipRuntime sourceRuntime = SevenZipRuntimeVerifier.Verify(resourcesRoot, resourcesLayout, cancellationToken);
        using AppContainerProfile profile = AppContainerProfile.Open(appOwnedRoot);
        using OperationWorkspace workspace = OperationWorkspace.Create(appOwnedRoot, leaseId);
        using SevenZipRuntime runtime = SevenZipRuntimeVerifier.Stage(sourceRuntime, workspace.Engine, cancellationToken);
        PinnedFile worker = workspace.StageProbeExecutable(Environment.ProcessPath ?? throw new InvalidDataException("Worker path missing"));
        string userDataSentinel = CanonicalPaths.ExistingFile(userDataSentinelValue);
        string input = workspace.Input;
        string output = workspace.Output;
        string scratch = workspace.Scratch;
        string bundle = workspace.Bundle;
        string nonce = Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture);
        string inputFile = Path.Combine(input, "probe.txt");
        File.WriteAllText(inputFile, nonce, StrictUtf8);
        using PinnedFile inputPin = PinnedFile.OpenSnapshot(inputFile);
        string ambientRead = Path.Combine(Path.GetTempPath(), $"MinecraftCore.Ambient.{Guid.NewGuid():N}.txt");
        string ambientWrite = Path.Combine(Path.GetTempPath(), $"MinecraftCore.AmbientWrite.{Guid.NewGuid():N}.txt");
        File.WriteAllText(ambientRead, "ambient", StrictUtf8);
        string published = CreateFreshSelfTestPublication(appOwnedRoot, leaseId);
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start(1);
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        using FileStream secretHandle = new(Path.Combine(workspace.Probe, "broker-handle.txt"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose);
        long handleValue = secretHandle.SafeFileHandle.DangerousGetHandle().ToInt64();
        try
        {
            using AclLease grants = AclLease.Begin(appOwnedRoot, leaseId, profile.Sid);
            try
            {
                grants.GrantTraverseDirectory(runtime.EngineDirectory);
                grants.GrantReadExecuteFile(runtime.Executable);
                grants.GrantReadExecuteFile(runtime.Library);
                grants.GrantTraverseDirectory(workspace.Probe);
                grants.GrantReadExecuteFile(worker.Path);
                grants.GrantReadTraverseDirectory(input);
                grants.GrantReadFile(inputPin.Path);
                grants.GrantReadWriteDirectory(output);
                grants.GrantReadWriteDirectory(scratch);
                grants.GrantBundleDirectory(bundle);
                runtime.Revalidate();
                worker.Revalidate();
                inputPin.Revalidate();
                ProcessCapture nativeProbe = await SandboxedProcess.RunAsync(runtime.Executable, ["i"], runtime.EngineDirectory,
                    MinimalEnvironment(scratch, null), profile.Sid, TimeSpan.FromSeconds(30), JobMemoryLimit, 1024 * 1024, 1024 * 1024,
                    cancellationToken, grants.RegisterChild).ConfigureAwait(false);
                if (nativeProbe.ExitCode != 0) throw new InvalidDataException($"Native AppContainer probe failed (0x{nativeProbe.NativeExitCode:x8})");
                string[] arguments =
                {
                    "--sandbox-probe-child", inputFile, output, ambientRead, ambientWrite, userDataSentinel,
                    port.ToString(CultureInfo.InvariantCulture), handleValue.ToString(CultureInfo.InvariantCulture), bundle, scratch, nonce
                };
                ProcessCapture capture = await SandboxedProcess.RunAsync(worker.Path, arguments, workspace.Probe, MinimalEnvironment(scratch, bundle), profile.Sid,
                    TimeSpan.FromMilliseconds(Math.Max(1, limits.MaxListTestMs - 5000)), JobMemoryLimit, 64 * 1024, 8 * 1024, cancellationToken,
                    grants.RegisterChild).ConfigureAwait(false);
                if (capture.ExitCode != 0 || capture.StandardError.Length != 0 || capture.StandardOutput.Length is < 2 or > 64 * 1024)
                {
                    string bundleEntries = string.Join(',', Directory.EnumerateFileSystemEntries(bundle, "*", SearchOption.AllDirectories)
                        .Select(value => Path.GetRelativePath(bundle, value)).Order(StringComparer.Ordinal));
                    throw new InvalidDataException($"Containment probe failed (0x{capture.NativeExitCode:x8}, bundle entries {bundleEntries}): {StrictUtf8.GetString(capture.StandardError)}");
                }
                FrameReader.ValidateStrictJson(capture.StandardOutput);
                ContainmentEvidence evidence = JsonSerializer.Deserialize(capture.StandardOutput, WorkerJsonContext.Default.ContainmentEvidence) ?? throw new InvalidDataException("Containment evidence missing");

                AclProcessIdentity? killedIdentity = null;
                try
                {
                    _ = await SandboxedProcess.RunAsync(worker.Path, ["--probe-hang"], workspace.Probe, MinimalEnvironment(scratch, bundle), profile.Sid,
                        TimeSpan.FromMilliseconds(250), JobMemoryLimit, 1024, 1024, CancellationToken.None,
                        (handle, processId) => { grants.RegisterChild(handle, processId); killedIdentity = ProcessIdentity.FromHandle(handle, processId); }).ConfigureAwait(false);
                    throw new InvalidDataException("Job survivor probe unexpectedly exited");
                }
                catch (TimeoutException) when (killedIdentity is not null) { }
                evidence.CleanupKilledSurvivors = killedIdentity is not null && ProcessIdentity.State(killedIdentity) == ProcessIdentityState.Exited;
                evidence.TemporaryAclRemoved = grants.Complete(output, bundle);
                workspace.PublishOutput(published);
                evidence.PublishedOutputAclClean = AclLeaseTreeVerification.HasNoAllowForSid(published, profile.Sid);
                profile.VerifyStoreCleanAndClose();
                evidence.ProfileStoreClean = profile.VerifyStoreCleanAndClose();
                RequireEvidence(evidence);
                return evidence;
            }
            catch (QuiescenceUnprovenException)
            {
                workspace.PreserveForRecovery();
                grants.PreserveForRecovery();
                profile.PreserveForRecovery();
                Environment.FailFast("Self-test sandbox process quiescence could not be proven");
                throw;
            }
        }
        finally
        {
            listener.Stop();
            secretHandle.Dispose();
            TryDelete(ambientRead, file: true);
            TryDelete(ambientWrite, file: true);
            TryDelete(published, file: false);
        }
    }

    private static int RunProbe(string[] args)
    {
        try
        {
            string inputFile = args[1];
            string outputDirectory = args[2];
            string ambientRead = args[3];
            string ambientWrite = args[4];
            string userData = args[5];
            int port = int.Parse(args[6], CultureInfo.InvariantCulture);
            nint brokerHandle = new(long.Parse(args[7], CultureInfo.InvariantCulture));
            string expectedBundle = args[8];
            string expectedScratch = args[9];
            string nonce = args[10];
            bool appContainer = IsAppContainerToken();
            bool inJob = NativeMethods.IsProcessInJob(NativeMethods.GetCurrentProcess(), nint.Zero, out bool jobResult) && jobResult;
            bool inputRead = TryReadExact(inputFile, nonce);
            string outputFile = Path.Combine(outputDirectory, "probe-output.txt");
            bool outputWrite = TryWriteExact(outputFile, nonce);
            bool ambientReadDenied = !TryRead(ambientRead);
            bool ambientWriteDenied = !TryWriteExact(ambientWrite, nonce);
            bool userReadDenied = !TryRead(userData);
            bool userWriteDenied = !TryOpenWrite(userData);
            bool loopbackDenied = !TryLoopback(port);
            bool descendantsDenied = !TryCreateDescendant();
            bool handlesAbsent = HandleIsUnavailable(brokerHandle) && !HandleIsUnavailable(NativeMethods.GetCurrentProcess());
            string? actualBundle = Environment.GetEnvironmentVariable("DOTNET_BUNDLE_EXTRACT_BASE_DIR");
            bool environmentControlled = new[] { "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP" }
                .All(name => ControlledEnvironmentPath(Environment.GetEnvironmentVariable(name), expectedScratch)) &&
                Environment.GetEnvironmentVariable("PATH") is null && Environment.GetEnvironmentVariable("MINECRAFT_CORE_BROKER_SECRET") is null;
            bool bundleObserved = Directory.Exists(expectedBundle) && Directory.EnumerateFiles(expectedBundle, "*", SearchOption.AllDirectories).Any();
            bool bundleIsolated = string.Equals(Path.GetFullPath(actualBundle ?? string.Empty), Path.GetFullPath(expectedBundle), StringComparison.OrdinalIgnoreCase) &&
                bundleObserved && TryWriteExact(Path.Combine(expectedBundle, "bundle-marker"), nonce);
            bool stdinClosed = Console.OpenStandardInput().ReadByte() == -1;
            var evidence = new ContainmentEvidence
            {
                AppContainer = appContainer,
                ZeroCapabilities = appContainer && HasZeroCapabilities(),
                ExactInputRead = inputRead,
                ExactOutputWrite = outputWrite,
                AmbientTempReadDenied = ambientReadDenied,
                AmbientTempWriteDenied = ambientWriteDenied,
                UserDataReadDenied = userReadDenied,
                UserDataWriteDenied = userWriteDenied,
                LoopbackDenied = loopbackDenied,
                DescendantsDenied = descendantsDenied,
                UnrelatedEnvironmentAbsent = environmentControlled,
                UnrelatedHandlesAbsent = handlesAbsent,
                BundleExtractionIsolated = bundleIsolated && inJob,
                StandardInputClosed = stdinClosed
            };
            byte[] json = JsonSerializer.SerializeToUtf8Bytes(evidence, WorkerJsonContext.Default.ContainmentEvidence);
            using Stream standardOutput = Console.OpenStandardOutput();
            standardOutput.Write(json);
            standardOutput.Flush();
            return 0;
        }
        catch
        {
            return 1;
        }
    }

    private static bool TryCreateDescendant()
    {
        nint app = nint.Zero;
        nint command = nint.Zero;
        NativeMethods.ProcessInformation process = default;
        try
        {
            string application = Environment.ProcessPath!;
            app = Marshal.StringToHGlobalUni(application);
            command = Marshal.StringToHGlobalUni($"\"{application}\" --probe-descendant");
            NativeMethods.StartupInfo startup = new() { Cb = (uint)Marshal.SizeOf<NativeMethods.StartupInfo>() };
            bool created = NativeMethods.CreateProcessBasic(app, command, nint.Zero, nint.Zero, false, NativeMethods.CreateNoWindow, nint.Zero, nint.Zero, ref startup, out process);
            if (created)
            {
                _ = NativeMethods.TerminateProcess(process.Process, 1);
                _ = NativeMethods.WaitForSingleObject(process.Process, 5000);
                _ = NativeMethods.CloseHandle(process.Thread);
                _ = NativeMethods.CloseHandle(process.Process);
            }
            return created;
        }
        finally
        {
            if (app != nint.Zero) Marshal.FreeHGlobal(app);
            if (command != nint.Zero) Marshal.FreeHGlobal(command);
        }
    }

    private static bool HandleIsUnavailable(nint handle)
    {
        try
        {
            uint wait = NativeMethods.WaitForSingleObject(handle, 0);
            return wait == uint.MaxValue && Marshal.GetLastWin32Error() == 6;
        }
        catch (SEHException)
        {
            return true;
        }
    }

    private static bool ControlledEnvironmentPath(string? value, string expectedRoot)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        try
        {
            string root = Path.GetFullPath(expectedRoot).TrimEnd(Path.DirectorySeparatorChar);
            string candidate = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
            return string.Equals(root, candidate, StringComparison.OrdinalIgnoreCase) ||
                candidate.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static bool IsAppContainerToken()
    {
        if (!NativeMethods.OpenProcessToken(NativeMethods.GetCurrentProcess(), NativeMethods.TokenQuery, out nint token)) return false;
        nint value = Marshal.AllocHGlobal(sizeof(int));
        try
        {
            return NativeMethods.GetTokenInformation(token, NativeMethods.TokenIsAppContainer, value, sizeof(int), out _) && Marshal.ReadInt32(value) != 0;
        }
        finally
        {
            Marshal.FreeHGlobal(value);
            _ = NativeMethods.CloseHandle(token);
        }
    }

    private static bool HasZeroCapabilities()
    {
        if (!NativeMethods.OpenProcessToken(NativeMethods.GetCurrentProcess(), NativeMethods.TokenQuery, out nint token)) return false;
        try
        {
            _ = NativeMethods.GetTokenInformation(token, NativeMethods.TokenCapabilities, nint.Zero, 0, out uint length);
            if (length < sizeof(uint) || length > 1024 * 1024) return false;
            nint value = Marshal.AllocHGlobal(checked((int)length));
            try
            {
                return NativeMethods.GetTokenInformation(token, NativeMethods.TokenCapabilities, value, length, out uint returned) &&
                    returned == length && Marshal.ReadInt32(value) == 0;
            }
            finally { Marshal.FreeHGlobal(value); }
        }
        finally { _ = NativeMethods.CloseHandle(token); }
    }

    private static bool TryLoopback(int port)
    {
        try
        {
            using var client = new TcpClient(AddressFamily.InterNetwork);
            return client.ConnectAsync(IPAddress.Loopback, port).Wait(TimeSpan.FromSeconds(1));
        }
        catch { return false; }
    }

    private static bool TryReadExact(string file, string expected) { try { return File.ReadAllText(file, StrictUtf8) == expected; } catch { return false; } }
    private static bool TryRead(string file) { try { _ = File.ReadAllBytes(file); return true; } catch { return false; } }
    private static bool TryWriteExact(string file, string value) { try { File.WriteAllText(file, value, StrictUtf8); return File.ReadAllText(file, StrictUtf8) == value; } catch { return false; } }
    private static bool TryOpenWrite(string file) { try { using FileStream stream = File.Open(file, FileMode.Open, FileAccess.Write, FileShare.Read); return true; } catch { return false; } }

    private static IReadOnlyDictionary<string, string> MinimalEnvironment(string scratch, string? bundleDirectory)
    {
        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["SystemRoot"] = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows",
            ["windir"] = Environment.GetEnvironmentVariable("windir") ?? @"C:\Windows",
            ["SystemDrive"] = Path.GetPathRoot(Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows") ?? @"C:\",
            ["TEMP"] = scratch,
            ["TMP"] = scratch,
            ["LOCALAPPDATA"] = scratch,
            ["APPDATA"] = scratch,
            ["USERPROFILE"] = scratch,
            ["DOTNET_EnableDiagnostics"] = "0",
            ["COMPlus_EnableDiagnostics"] = "0"
        };
        if (bundleDirectory is not null) environment["DOTNET_BUNDLE_EXTRACT_BASE_DIR"] = bundleDirectory;
        return environment;
    }

    private static void ValidateControlIdentity(WorkerRequest request)
    {
        if (!IdentifierPattern().IsMatch(request.LeaseId ?? string.Empty) || request.ControlToken is null || request.ControlToken.Length != 64 ||
            !request.ControlToken.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f') || string.IsNullOrWhiteSpace(request.AppOwnedRoot))
            throw new InvalidDataException("Control identity invalid");
        const string prefix = "\\\\.\\pipe\\MinecraftCore.ArchiveWorker.";
        if (request.ControlPipeName is null || !request.ControlPipeName.StartsWith(prefix, StringComparison.Ordinal) ||
            request.ControlPipeName.Length > 256 || request.ControlPipeName[prefix.Length..].Length is < 3 or > 96 ||
            request.ControlPipeName[prefix.Length..].Any(character => !char.IsAsciiLetterOrDigit(character) && character != '.'))
            throw new InvalidDataException("Control pipe invalid");
    }

    private static async Task MonitorControlAsync(Stream input, string expectedToken, CancellationTokenSource operationCancellation, CancellationToken stopToken)
    {
        byte[] expected = Convert.FromHexString(expectedToken);
        try
        {
            while (true)
            {
                using var heartbeat = CancellationTokenSource.CreateLinkedTokenSource(stopToken);
                heartbeat.CancelAfter(ControlHeartbeatTimeout);
                ControlFrame? frame;
                try { frame = await FrameReader.ReadOneOrEndAsync(input, WorkerJsonContext.Default.ControlFrame, heartbeat.Token).ConfigureAwait(false); }
                catch (OperationCanceledException) when (!stopToken.IsCancellationRequested)
                {
                    throw new TimeoutException("Control heartbeat expired");
                }
                if (frame is null)
                {
                    operationCancellation.Cancel();
                    return;
                }
                byte[] supplied;
                try { supplied = Convert.FromHexString(frame.Token ?? string.Empty); }
                catch (FormatException) { throw new InvalidDataException("Control authentication failed"); }
                if (supplied.Length != expected.Length || !CryptographicOperations.FixedTimeEquals(supplied, expected)) throw new InvalidDataException("Control authentication failed");
                if (frame.Type == "cancel")
                {
                    operationCancellation.Cancel();
                    return;
                }
                if (frame.Type != "keepalive") throw new InvalidDataException("Control frame invalid");
            }
        }
        catch
        {
            operationCancellation.Cancel();
            throw;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(expected);
        }
    }

    private static void ValidateArchiveShape(WorkerRequest request)
    {
        if (request.Operation is not ("list" or "test" or "extract" or "read-entry") || !IdentifierPattern().IsMatch(request.OperationId ?? string.Empty) ||
            request.ArchiveFamily is not ("zip" or "rar4" or "rar5") || request.ResourcesRoot is null || request.ResourcesLayout is not ("repository" or "packaged") || request.AppOwnedRoot is null ||
            request.InputDirectory is null || request.ArchivePath is null || request.InputParts is not { Length: > 0 and <= 1024 } || request.UserDataSentinel is not null)
            throw new InvalidDataException("Archive request invalid");
        if ((request.Operation == "extract") != (request.OutputDirectory is not null) || (request.Operation == "read-entry") != (request.EntryName is not null)) throw new InvalidDataException("Archive request shape invalid");
        if (request.EntryName is not null && !SafeEntryName(request.EntryName)) throw new InvalidDataException("Archive entry invalid");
        if (request.Operation != "read-entry" && request.MaxDataBytes is not null) throw new InvalidDataException("Archive data cap invalid");
        if (request.MaxDataBytes is not null) _ = ParseDecimal(request.MaxDataBytes, 64 * 1024 * 1024, requirePositive: true);
        var inputPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (WorkerInputPart part in request.InputParts)
        {
            if (part.Path is null || part.Size is null || part.Sha256 is null || part.Sha512 is null ||
                !long.TryParse(part.Size, NumberStyles.None, CultureInfo.InvariantCulture, out long size) || size < 0 ||
                part.Sha256.Length != 64 || part.Sha512.Length != 128 || !part.Sha256.All(Uri.IsHexDigit) || !part.Sha512.All(Uri.IsHexDigit) ||
                !inputPaths.Add(Path.GetFullPath(part.Path))) throw new InvalidDataException("Archive input identity invalid");
        }
        if (!inputPaths.Contains(Path.GetFullPath(request.ArchivePath))) throw new InvalidDataException("Primary archive identity invalid");
    }

    private static void ValidateSelfTestShape(WorkerRequest request)
    {
        if (request.ResourcesRoot is null || request.ResourcesLayout is not ("repository" or "packaged") || request.AppOwnedRoot is null || request.UserDataSentinel is null || request.OperationId is not null || request.ArchiveFamily is not null ||
            request.InputDirectory is not null || request.ArchivePath is not null || request.InputParts is not null || request.OutputDirectory is not null || request.EntryName is not null || request.MaxDataBytes is not null)
            throw new InvalidDataException("Self-test request invalid");
    }

    private static bool SafeEntryName(string value)
    {
        if (value.Length is < 1 or > 1024 || value.StartsWith('@') || Path.IsPathFullyQualified(value) || value.StartsWith('/') || value.StartsWith('\\') || value.Contains(':') || value.Any(character => character < 0x20 || character == 0x7f)) return false;
        return !value.Replace('\\', '/').Split('/').Any(part => part.Length == 0 || part is "." or ".." || part.EndsWith('.') || part.EndsWith(' '));
    }

    private static void ValidateLimits(WorkerLimits? limits)
    {
        if (limits is null || limits.Version != 1 || limits.MaxArtifactSetBytes != "17179869184" || limits.MaxArchiveEntries != 250000 ||
            limits.MaxExpandedBytes != "68719476736" || limits.MaxFileExpandedBytes != "17179869184" || limits.MaxPathDepth != 64 ||
            limits.MaxNormalizedPathLength != 1024 || limits.MaxTechnicalStdoutBytes != "67108864" || limits.MaxTechnicalStderrBytes != "8388608" ||
            limits.MaxListTestMs != 300000 || limits.MaxExtractionMs != 3600000 || limits.MaxChildJobMemoryBytes != "2147483648" ||
            limits.MaxPerEntryCompressionRatio != 1000 || limits.MinPerEntryRatioExpandedBytes != "67108864" || limits.MaxAggregateCompressionRatio != 1000 ||
            limits.MinAggregateRatioExpandedBytes != "268435456" || limits.MinPreflightReserveBytes != "2147483648" || limits.PreflightReservePercent != 10) throw new InvalidDataException("Limit policy mismatch");
    }

    private static long ParseDecimal(string value, long maximum, bool requirePositive = false)
    {
        if (!long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out long parsed) || parsed < (requirePositive ? 1 : 0) || parsed > maximum) throw new InvalidDataException("Limit rejected");
        return parsed;
    }

    private static void RequireEvidence(ContainmentEvidence evidence)
    {
        var missing = new List<string>();
        if (!evidence.AppContainer) missing.Add(nameof(evidence.AppContainer));
        if (!evidence.ZeroCapabilities) missing.Add(nameof(evidence.ZeroCapabilities));
        if (!evidence.ExactInputRead) missing.Add(nameof(evidence.ExactInputRead));
        if (!evidence.ExactOutputWrite) missing.Add(nameof(evidence.ExactOutputWrite));
        if (!evidence.AmbientTempReadDenied) missing.Add(nameof(evidence.AmbientTempReadDenied));
        if (!evidence.AmbientTempWriteDenied) missing.Add(nameof(evidence.AmbientTempWriteDenied));
        if (!evidence.UserDataReadDenied) missing.Add(nameof(evidence.UserDataReadDenied));
        if (!evidence.UserDataWriteDenied) missing.Add(nameof(evidence.UserDataWriteDenied));
        if (!evidence.LoopbackDenied) missing.Add(nameof(evidence.LoopbackDenied));
        if (!evidence.DescendantsDenied) missing.Add(nameof(evidence.DescendantsDenied));
        if (!evidence.UnrelatedEnvironmentAbsent) missing.Add(nameof(evidence.UnrelatedEnvironmentAbsent));
        if (!evidence.UnrelatedHandlesAbsent) missing.Add(nameof(evidence.UnrelatedHandlesAbsent));
        if (!evidence.BundleExtractionIsolated) missing.Add(nameof(evidence.BundleExtractionIsolated));
        if (!evidence.StandardInputClosed) missing.Add(nameof(evidence.StandardInputClosed));
        if (!evidence.CleanupKilledSurvivors) missing.Add(nameof(evidence.CleanupKilledSurvivors));
        if (!evidence.TemporaryAclRemoved) missing.Add(nameof(evidence.TemporaryAclRemoved));
        if (!evidence.ProfileStoreClean) missing.Add(nameof(evidence.ProfileStoreClean));
        if (!evidence.PublishedOutputAclClean) missing.Add(nameof(evidence.PublishedOutputAclClean));
        if (missing.Count != 0) throw new InvalidDataException($"Containment evidence failed: {string.Join(',', missing)}");
    }

    private static async Task<int> RunBuildSelfTestAsync(string resourcesRootValue, string operationRootValue)
    {
        string resourcesRoot = CanonicalPaths.ExistingDirectory(resourcesRootValue);
        string operationRoot = CanonicalPaths.RequireWithin(resourcesRoot, operationRootValue, file: false);
        if (Directory.EnumerateFileSystemEntries(operationRoot).Any()) throw new InvalidDataException("Build self-test root must be empty");
        string appRoot = Path.Combine(operationRoot, "a");
        Directory.CreateDirectory(appRoot);
        appRoot = CanonicalPaths.RequireWithin(operationRoot, appRoot, file: false);
        string sentinel = Path.Combine(operationRoot, "sentinel.txt");
        File.WriteAllText(sentinel, "private", StrictUtf8);
        var limits = new WorkerLimits
        {
            Version = 1, MaxArtifactSetBytes = "17179869184", MaxArchiveEntries = 250000, MaxExpandedBytes = "68719476736",
            MaxFileExpandedBytes = "17179869184", MaxPathDepth = 64, MaxNormalizedPathLength = 1024, MaxTechnicalStdoutBytes = "67108864",
            MaxTechnicalStderrBytes = "8388608", MaxListTestMs = 300000, MaxExtractionMs = 3600000, MaxChildJobMemoryBytes = "2147483648",
            MaxPerEntryCompressionRatio = 1000, MinPerEntryRatioExpandedBytes = "67108864", MaxAggregateCompressionRatio = 1000,
            MinAggregateRatioExpandedBytes = "268435456", MinPreflightReserveBytes = "2147483648", PreflightReservePercent = 10
        };
        string selfTestLease = $"b-{Guid.NewGuid():N}"[..18];
        ContainmentEvidence evidence = await ExecuteSelfTestAsync(resourcesRoot, "repository", appRoot, selfTestLease, sentinel, limits, CancellationToken.None).ConfigureAwait(false);
        RequireEvidence(evidence);
        if (File.ReadAllText(sentinel, StrictUtf8) != "private") throw new InvalidDataException("Build self-test sentinel changed");
        return 0;
    }

    private static int PreserveWorkspaceFixture(string appOwnedRootValue, string leaseId)
    {
        using OperationWorkspace workspace = OperationWorkspace.Create(appOwnedRootValue, leaseId);
        File.WriteAllText(Path.Combine(workspace.Scratch, "fixture.txt"), "preserved", StrictUtf8);
        workspace.PreserveForRecovery();
        return 0;
    }

    private static int CancelledStagingSelfTest(string appOwnedRootValue)
    {
        string appOwnedRoot = CanonicalPaths.ExistingDirectory(appOwnedRootValue);
        string sourceRoot = Path.Combine(appOwnedRoot, "cancel-source");
        Directory.CreateDirectory(sourceRoot);
        sourceRoot = CanonicalPaths.RequireWithin(appOwnedRoot, sourceRoot, file: false);
        string source = Path.Combine(sourceRoot, "archive.zip");
        byte[] bytes = new byte[1024 * 1024];
        RandomNumberGenerator.Fill(bytes);
        File.WriteAllBytes(source, bytes);
        string sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        string sha512 = Convert.ToHexString(SHA512.HashData(bytes)).ToLowerInvariant();
        CryptographicOperations.ZeroMemory(bytes);
        string leaseId = $"cancel-{Guid.NewGuid():N}"[..20];
        try
        {
            using OperationWorkspace workspace = OperationWorkspace.Create(appOwnedRoot, leaseId);
            using var cancellation = new CancellationTokenSource();
            cancellation.Cancel();
            try
            {
                workspace.StageInputs(sourceRoot, source, [new WorkerInputPart
                {
                    Path = source,
                    Size = new FileInfo(source).Length.ToString(CultureInfo.InvariantCulture),
                    Sha256 = sha256,
                    Sha512 = sha512
                }], cancellation.Token);
                throw new InvalidDataException("Cancelled staging completed");
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
            if (Directory.EnumerateFileSystemEntries(workspace.Input).Any()) throw new InvalidDataException("Cancelled staging copied input");
            return 0;
        }
        finally { TryDelete(sourceRoot, file: false); }
    }

    private static int CancelledRuntimeSelfTest(string resourcesRootValue, string appOwnedRootValue)
    {
        string resourcesRoot = CanonicalPaths.ExistingDirectory(resourcesRootValue);
        string appOwnedRoot = CanonicalPaths.ExistingDirectory(appOwnedRootValue);
        string stagingRoot = Path.Combine(appOwnedRoot, "cancelled-runtime");
        Directory.CreateDirectory(stagingRoot);
        stagingRoot = CanonicalPaths.RequireWithin(appOwnedRoot, stagingRoot, file: false);
        try
        {
            using var cancellation = new CancellationTokenSource();
            cancellation.Cancel();
            try
            {
                using SevenZipRuntime _ = SevenZipRuntimeVerifier.Verify(resourcesRoot, "repository", cancellation.Token);
                throw new InvalidDataException("Cancelled runtime verification completed");
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }

            using SevenZipRuntime source = SevenZipRuntimeVerifier.Verify(resourcesRoot, "repository", CancellationToken.None);
            try
            {
                using SevenZipRuntime _ = SevenZipRuntimeVerifier.Stage(source, stagingRoot, cancellation.Token);
                throw new InvalidDataException("Cancelled runtime staging completed");
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
            if (Directory.EnumerateFileSystemEntries(stagingRoot).Any()) throw new InvalidDataException("Cancelled runtime staging copied engine bytes");
            return 0;
        }
        finally { TryDelete(stagingRoot, file: false); }
    }

    private static string CreateFreshSelfTestPublication(string appOwnedRootValue, string leaseId)
    {
        string appOwnedRoot = CanonicalPaths.ExistingDirectory(appOwnedRootValue);
        string parent = Path.Combine(appOwnedRoot, "self-test-publications");
        Directory.CreateDirectory(parent);
        parent = CanonicalPaths.RequireWithin(appOwnedRoot, parent, file: false);
        string target = Path.Combine(parent, leaseId);
        if (File.Exists(target) || Directory.Exists(target)) throw new InvalidDataException("Self-test publication already exists");
        Directory.CreateDirectory(target);
        return CanonicalPaths.RequireWithin(parent, target, file: false);
    }

    private static void TryDelete(string value, bool file)
    {
        try { if (file && File.Exists(value)) File.Delete(value); else if (!file && Directory.Exists(value)) Directory.Delete(value, true); } catch { /* self-test cleanup is verified by its owner */ }
    }
}
