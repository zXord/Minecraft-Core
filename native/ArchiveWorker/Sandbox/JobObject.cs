using System.Runtime.InteropServices;

namespace MinecraftCore.ArchiveWorker.Sandbox;

internal sealed class JobObject : IDisposable
{
    private nint handle;
    private bool preserveAuthority;

    internal JobObject(TimeSpan deadline, ulong memoryLimit)
    {
        handle = NativeMethods.CreateJobObject(nint.Zero, null);
        if (handle == nint.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var limits = new NativeMethods.JobObjectExtendedLimitInformation
            {
                BasicLimitInformation = new NativeMethods.JobObjectBasicLimitInformation
                {
                    PerProcessUserTimeLimit = checked(deadline.Ticks),
                    LimitFlags = NativeMethods.JobObjectLimitProcessTime | NativeMethods.JobObjectLimitActiveProcess |
                        NativeMethods.JobObjectLimitProcessMemory | NativeMethods.JobObjectLimitJobMemory | NativeMethods.JobObjectLimitKillOnJobClose,
                    ActiveProcessLimit = 1
                },
                ProcessMemoryLimit = checked((nuint)memoryLimit),
                JobMemoryLimit = checked((nuint)memoryLimit)
            };
            Set(NativeMethods.JobObjectExtendedLimitInformationClass, limits);
            Set(NativeMethods.JobObjectBasicUiRestrictionsClass, new NativeMethods.JobObjectBasicUiRestrictions
            {
                UiRestrictionsClass = NativeMethods.JobObjectUiLimitAllRestrictions
            });
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    internal void Assign(nint process)
    {
        if (!NativeMethods.AssignProcessToJobObject(handle, process)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }

    internal void TerminateAndWait(nint process, TimeSpan timeout)
    {
        if (handle == nint.Zero || process == nint.Zero) throw new QuiescenceUnprovenException("Sandbox termination authority missing");
        if (!NativeMethods.TerminateJobObject(handle, 1))
            throw new QuiescenceUnprovenException("Sandbox Job termination failed", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        uint milliseconds = checked((uint)Math.Clamp((long)timeout.TotalMilliseconds, 1, uint.MaxValue - 1));
        uint wait = NativeMethods.WaitForSingleObject(process, milliseconds);
        if (wait != NativeMethods.WaitObject0 || !NativeMethods.GetExitCodeProcess(process, out uint exitCode) || exitCode == NativeMethods.StillActive)
            throw new QuiescenceUnprovenException("Sandbox process quiescence was not proven");
    }

    internal void PreserveAuthority() => preserveAuthority = true;

    private void Set<T>(int informationClass, T value) where T : struct
    {
        int size = Marshal.SizeOf<T>();
        nint pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(value, pointer, false);
            if (!NativeMethods.SetInformationJobObject(handle, informationClass, pointer, (uint)size)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    public void Dispose()
    {
        if (preserveAuthority) return;
        nint value = Interlocked.Exchange(ref handle, nint.Zero);
        if (value != nint.Zero) _ = NativeMethods.CloseHandle(value);
    }
}

internal sealed class QuiescenceUnprovenException : IOException
{
    internal QuiescenceUnprovenException(string message, Exception? inner = null) : base(message, inner) { }
}
