using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using MinecraftCore.ArchiveWorker.Protocol;

namespace MinecraftCore.ArchiveWorker.Sandbox;

internal static class SandboxedProcess
{
    internal static async Task<ProcessCapture> RunAsync(
        string application,
        IReadOnlyList<string> arguments,
        string workingDirectory,
        IReadOnlyDictionary<string, string> environment,
        nint appContainerSid,
        TimeSpan deadline,
        ulong memoryLimit,
        long maximumStdoutBytes,
        long maximumStderrBytes,
        CancellationToken cancellationToken,
        Action<nint, uint> childIdentityObserver)
    {
        using var job = new JobObject(deadline, memoryLimit);
        NativeMethods.SecurityAttributes pipeAttributes = new()
        {
            Length = (uint)Marshal.SizeOf<NativeMethods.SecurityAttributes>(),
            InheritHandle = 1
        };
        nint stdoutRead = nint.Zero;
        nint stdoutWrite = nint.Zero;
        nint stderrRead = nint.Zero;
        nint stderrWrite = nint.Zero;
        nint stdinRead = nint.Zero;
        nint stdinWrite = nint.Zero;
        nint attributeList = nint.Zero;
        nint handleList = nint.Zero;
        nint capabilitiesPointer = nint.Zero;
        nint applicationPointer = nint.Zero;
        nint commandPointer = nint.Zero;
        nint environmentPointer = nint.Zero;
        nint currentDirectoryPointer = nint.Zero;
        NativeMethods.ProcessInformation process = default;
        bool processCreated = false;
        bool jobAssigned = false;
        bool processQuiesced = false;
        bool preserveAuthority = false;
        var stopwatch = Stopwatch.StartNew();
        try
        {
            CreateOutputPipe(ref pipeAttributes, out stdoutRead, out stdoutWrite);
            CreateOutputPipe(ref pipeAttributes, out stderrRead, out stderrWrite);
            if (!NativeMethods.CreatePipe(out stdinRead, out stdinWrite, ref pipeAttributes, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            if (!NativeMethods.SetHandleInformation(stdinWrite, NativeMethods.HandleFlagInherit, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            _ = NativeMethods.CloseHandle(stdinWrite);
            stdinWrite = nint.Zero;

            nuint attributeBytes = 0;
            _ = NativeMethods.InitializeProcThreadAttributeList(nint.Zero, 2, 0, ref attributeBytes);
            if (attributeBytes == 0) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            attributeList = Marshal.AllocHGlobal(checked((int)attributeBytes));
            if (!NativeMethods.InitializeProcThreadAttributeList(attributeList, 2, 0, ref attributeBytes)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

            handleList = Marshal.AllocHGlobal(3 * nint.Size);
            Marshal.WriteIntPtr(handleList, 0, stdinRead);
            Marshal.WriteIntPtr(handleList, nint.Size, stdoutWrite);
            Marshal.WriteIntPtr(handleList, 2 * nint.Size, stderrWrite);
            if (!NativeMethods.UpdateProcThreadAttribute(attributeList, 0, NativeMethods.ProcThreadAttributeHandleList, handleList, (nuint)(3 * nint.Size), nint.Zero, nint.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

            var capabilities = new NativeMethods.SecurityCapabilities { AppContainerSid = appContainerSid, CapabilityCount = 0 };
            capabilitiesPointer = Marshal.AllocHGlobal(Marshal.SizeOf<NativeMethods.SecurityCapabilities>());
            Marshal.StructureToPtr(capabilities, capabilitiesPointer, false);
            if (!NativeMethods.UpdateProcThreadAttribute(attributeList, 0, NativeMethods.ProcThreadAttributeSecurityCapabilities, capabilitiesPointer,
                (nuint)Marshal.SizeOf<NativeMethods.SecurityCapabilities>(), nint.Zero, nint.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

            string commandLine = BuildCommandLine(application, arguments);
            applicationPointer = Marshal.StringToHGlobalUni(application);
            commandPointer = Marshal.StringToHGlobalUni(commandLine);
            string environmentBlock = BuildEnvironmentBlock(environment, workingDirectory);
            byte[] environmentBytes = System.Text.Encoding.Unicode.GetBytes(environmentBlock);
            environmentPointer = Marshal.AllocHGlobal(environmentBytes.Length);
            Marshal.Copy(environmentBytes, 0, environmentPointer, environmentBytes.Length);
            currentDirectoryPointer = Marshal.StringToHGlobalUni(workingDirectory);
            NativeMethods.StartupInfoEx startup = new()
            {
                StartupInfo = new NativeMethods.StartupInfo
                {
                    Cb = (uint)Marshal.SizeOf<NativeMethods.StartupInfoEx>(),
                    Flags = NativeMethods.StartfUseStdHandles,
                    StandardInput = stdinRead,
                    StandardOutput = stdoutWrite,
                    StandardError = stderrWrite
                },
                AttributeList = attributeList
            };
            uint flags = NativeMethods.ExtendedStartupInfoPresent | NativeMethods.CreateSuspended | NativeMethods.CreateNoWindow | NativeMethods.CreateUnicodeEnvironment;
            if (!NativeMethods.CreateProcess(applicationPointer, commandPointer, nint.Zero, nint.Zero, true, flags, environmentPointer, currentDirectoryPointer, ref startup, out process)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW AppContainer launch failed");
            processCreated = true;
            job.Assign(process.Process);
            jobAssigned = true;
            childIdentityObserver(process.Process, process.ProcessId);
            if (NativeMethods.ResumeThread(process.Thread) == uint.MaxValue) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            _ = NativeMethods.CloseHandle(process.Thread);
            process.Thread = nint.Zero;
            _ = NativeMethods.CloseHandle(stdoutWrite);
            stdoutWrite = nint.Zero;
            _ = NativeMethods.CloseHandle(stderrWrite);
            stderrWrite = nint.Zero;
            _ = NativeMethods.CloseHandle(stdinRead);
            stdinRead = nint.Zero;

            using var stdoutHandle = new SafeFileHandle(stdoutRead, ownsHandle: true);
            stdoutRead = nint.Zero;
            using var stderrHandle = new SafeFileHandle(stderrRead, ownsHandle: true);
            stderrRead = nint.Zero;
            using var stdoutStream = new FileStream(stdoutHandle, FileAccess.Read, 4096, isAsync: false);
            using var stderrStream = new FileStream(stderrHandle, FileAccess.Read, 4096, isAsync: false);
            Task<byte[]> stdoutTask = ReadBoundedAsync(stdoutStream, maximumStdoutBytes, cancellationToken);
            Task<byte[]> stderrTask = ReadBoundedAsync(stderrStream, maximumStderrBytes, cancellationToken);
            Task waitTask = Task.Run(() =>
            {
                uint wait = NativeMethods.WaitForSingleObject(process.Process, checked((uint)Math.Min(deadline.TotalMilliseconds, uint.MaxValue - 1)));
                if (wait != NativeMethods.WaitObject0) throw new TimeoutException("Sandbox deadline exceeded");
            }, CancellationToken.None);
            var pending = new HashSet<Task> { stdoutTask, stderrTask, waitTask };
            while (pending.Count > 0)
            {
                Task completed = await Task.WhenAny(pending).WaitAsync(cancellationToken).ConfigureAwait(false);
                await completed.ConfigureAwait(false);
                pending.Remove(completed);
            }
            if (!NativeMethods.GetExitCodeProcess(process.Process, out uint exitCode)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            if (exitCode == NativeMethods.StillActive) throw new QuiescenceUnprovenException("Sandbox exit was not observed");
            processQuiesced = true;
            stopwatch.Stop();
            int normalizedExitCode = exitCode <= int.MaxValue ? (int)exitCode : 255;
            return new ProcessCapture(await stdoutTask.ConfigureAwait(false), await stderrTask.ConfigureAwait(false), normalizedExitCode, exitCode, stopwatch.Elapsed);
        }
        catch
        {
            if (processCreated && !processQuiesced)
            {
                try
                {
                    if (jobAssigned)
                    {
                        job.TerminateAndWait(process.Process, TimeSpan.FromSeconds(5));
                    }
                    else
                    {
                        if (!NativeMethods.TerminateProcess(process.Process, 1))
                            throw new QuiescenceUnprovenException("Suspended sandbox termination failed", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
                        uint wait = NativeMethods.WaitForSingleObject(process.Process, 5000);
                        if (wait != NativeMethods.WaitObject0 || !NativeMethods.GetExitCodeProcess(process.Process, out uint exitCode) || exitCode == NativeMethods.StillActive)
                            throw new QuiescenceUnprovenException("Suspended sandbox quiescence was not proven");
                    }
                    processQuiesced = true;
                }
                catch (QuiescenceUnprovenException)
                {
                    preserveAuthority = true;
                    job.PreserveAuthority();
                    throw;
                }
            }
            throw;
        }
        finally
        {
            if (process.Thread != nint.Zero) _ = NativeMethods.CloseHandle(process.Thread);
            if (process.Process != nint.Zero && !preserveAuthority) _ = NativeMethods.CloseHandle(process.Process);
            if (stdoutRead != nint.Zero) _ = NativeMethods.CloseHandle(stdoutRead);
            if (stdoutWrite != nint.Zero) _ = NativeMethods.CloseHandle(stdoutWrite);
            if (stderrRead != nint.Zero) _ = NativeMethods.CloseHandle(stderrRead);
            if (stderrWrite != nint.Zero) _ = NativeMethods.CloseHandle(stderrWrite);
            if (stdinRead != nint.Zero) _ = NativeMethods.CloseHandle(stdinRead);
            if (stdinWrite != nint.Zero) _ = NativeMethods.CloseHandle(stdinWrite);
            if (attributeList != nint.Zero) { NativeMethods.DeleteProcThreadAttributeList(attributeList); Marshal.FreeHGlobal(attributeList); }
            if (handleList != nint.Zero) Marshal.FreeHGlobal(handleList);
            if (capabilitiesPointer != nint.Zero) Marshal.FreeHGlobal(capabilitiesPointer);
            if (applicationPointer != nint.Zero) Marshal.FreeHGlobal(applicationPointer);
            if (commandPointer != nint.Zero) Marshal.FreeHGlobal(commandPointer);
            if (environmentPointer != nint.Zero) Marshal.FreeHGlobal(environmentPointer);
            if (currentDirectoryPointer != nint.Zero) Marshal.FreeHGlobal(currentDirectoryPointer);
        }
    }

    private static void CreateOutputPipe(ref NativeMethods.SecurityAttributes attributes, out nint read, out nint write)
    {
        if (!NativeMethods.CreatePipe(out read, out write, ref attributes, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        if (!NativeMethods.SetHandleInformation(read, NativeMethods.HandleFlagInherit, 0))
        {
            _ = NativeMethods.CloseHandle(read);
            _ = NativeMethods.CloseHandle(write);
            read = nint.Zero;
            write = nint.Zero;
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    private static async Task<byte[]> ReadBoundedAsync(Stream stream, long maximumBytes, CancellationToken cancellationToken)
    {
        if (maximumBytes < 0 || maximumBytes > int.MaxValue) throw new InvalidDataException("Output limit unavailable");
        using var memory = new MemoryStream();
        byte[] buffer = new byte[64 * 1024];
        while (true)
        {
            int read = await stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read == 0) break;
            if (memory.Length + read > maximumBytes) throw new ArchiveOutputLimitException("Sandbox output limit exceeded");
            memory.Write(buffer, 0, read);
        }
        return memory.ToArray();
    }

    private static string BuildEnvironmentBlock(IReadOnlyDictionary<string, string> environment, string workingDirectory)
    {
        if (environment.Count is < 1 or > 16) throw new InvalidDataException("Environment rejected");
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var entries = new List<string>(environment.Count);
        foreach ((string key, string value) in environment.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase))
        {
            if (!names.Add(key) || key.Length is < 1 or > 64 || value.Length > 32767 || key.Contains('=') || key.Contains('\0') || value.Contains('\0')) throw new InvalidDataException("Environment rejected");
            entries.Add($"{key}={value}");
        }
        string? driveRoot = Path.GetPathRoot(workingDirectory);
        if (driveRoot is { Length: >= 2 } && driveRoot[1] == ':') entries.Insert(0, $"={char.ToUpperInvariant(driveRoot[0])}:={workingDirectory}");
        return string.Join('\0', entries) + "\0\0";
    }

    private static string BuildCommandLine(string application, IReadOnlyList<string> arguments)
    {
        var values = new List<string>(arguments.Count + 1) { application };
        values.AddRange(arguments);
        return string.Join(' ', values.Select(QuoteArgument));
    }

    private static string QuoteArgument(string value)
    {
        if (value.IndexOf('\0') >= 0) throw new InvalidDataException("Command argument rejected");
        var result = new System.Text.StringBuilder(value.Length + 2).Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { backslashes++; continue; }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1).Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes).Append(character);
            backslashes = 0;
        }
        result.Append('\\', backslashes * 2).Append('"');
        return result.ToString();
    }
}

internal sealed class ArchiveOutputLimitException : IOException
{
    internal ArchiveOutputLimitException(string message) : base(message) { }
}
