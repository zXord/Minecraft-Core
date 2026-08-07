using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using MinecraftCore.ArchiveWorker.Security;

namespace MinecraftCore.ArchiveWorker.Sandbox;

internal sealed class AppContainerProfile : IDisposable
{
    private const string ProfileName = "MinecraftCore.ArchiveWorker";
    private const string ProfileMutexName = @"Local\MinecraftCore.ArchiveWorker.Profile.v1";
    private const int AlreadyExistsHResult = unchecked((int)0x800700b7);
    private const int FileNotFoundHResult = unchecked((int)0x80070002);
    private const int NotFoundHResult = unchecked((int)0x80070490);
    private nint sid;
    private NamedMutexScope? profileMutex;
    private CrossSessionProfileLock? crossSessionLock;
    private string? profileFolder;
    private bool preserved;
    private bool cleaned;

    private AppContainerProfile(nint sidValue, string folder, NamedMutexScope mutex, CrossSessionProfileLock crossSession)
    {
        sid = sidValue;
        profileFolder = folder;
        profileMutex = mutex;
        crossSessionLock = crossSession;
    }

    internal nint Sid => sid != nint.Zero ? sid : throw new ObjectDisposedException(nameof(AppContainerProfile));

    internal static AppContainerProfile Open(string appOwnedRoot)
    {
        string canonicalRoot = CanonicalPaths.ExistingDirectory(appOwnedRoot);
        CrossSessionProfileLock? crossSession = CrossSessionProfileLock.Acquire(canonicalRoot);
        NamedMutexScope? mutex = null;
        nint profileSid = nint.Zero;
        try
        {
            mutex = NamedMutexScope.Enter(ProfileMutexName);
            int derive = NativeMethods.DeriveAppContainerSidFromAppContainerName(ProfileName, out nint recoverySid);
            if (derive < 0 || recoverySid == nint.Zero) Marshal.ThrowExceptionForHR(derive < 0 ? derive : unchecked((int)0x80004005));
            try { AclLease.RecoverBeforeProfileReset(appOwnedRoot, recoverySid); }
            finally { _ = NativeMethods.FreeSid(recoverySid); }
            DeleteExistingProfileAndVerify();
            int result = NativeMethods.CreateAppContainerProfile(ProfileName, "Minecraft Core Archive Worker", "Zero-capability archive extraction boundary", nint.Zero, 0, out profileSid);
            if (result == AlreadyExistsHResult) throw new InvalidDataException("AppContainer profile was recreated concurrently");
            if (result < 0 || profileSid == nint.Zero) Marshal.ThrowExceptionForHR(result < 0 ? result : unchecked((int)0x80004005));
            string folder = GetProfileFolder(profileSid);
            if (!Directory.Exists(folder)) throw new InvalidDataException("AppContainer profile store was not created");
            CanonicalPaths.RejectReparseTree(folder);
            if (Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories).Any()) throw new InvalidDataException("AppContainer profile store was not clean before execution");
            var profile = new AppContainerProfile(profileSid, folder, mutex, crossSession);
            profileSid = nint.Zero;
            mutex = null;
            crossSession = null;
            return profile;
        }
        catch
        {
            if (profileSid != nint.Zero) _ = NativeMethods.FreeSid(profileSid);
            mutex?.Dispose();
            crossSession?.Dispose();
            throw;
        }
    }

    internal bool VerifyStoreCleanAndClose()
    {
        if (preserved) throw new InvalidOperationException("AppContainer profile is preserved for recovery");
        CleanupProfile();
        return cleaned;
    }

    internal void PreserveForRecovery() => preserved = true;

    private static void DeleteExistingProfileAndVerify()
    {
        int derive = NativeMethods.DeriveAppContainerSidFromAppContainerName(ProfileName, out nint existingSid);
        if (derive is FileNotFoundHResult or NotFoundHResult) return;
        if (derive < 0 || existingSid == nint.Zero) Marshal.ThrowExceptionForHR(derive < 0 ? derive : unchecked((int)0x80004005));
        string? folder;
        try { folder = TryGetProfileFolder(existingSid); }
        finally { _ = NativeMethods.FreeSid(existingSid); }
        int deleted = NativeMethods.DeleteAppContainerProfile(ProfileName);
        if (deleted < 0 && deleted is not FileNotFoundHResult and not NotFoundHResult) Marshal.ThrowExceptionForHR(deleted);
        if (folder is not null && Directory.Exists(folder)) throw new IOException("AppContainer profile store cleanup was not verified");
    }

    private static string GetProfileFolder(nint value) =>
        TryGetProfileFolder(value) ?? throw new FileNotFoundException("AppContainer profile store was not created");

    private static string? TryGetProfileFolder(nint value)
    {
        string sidText = SidToString(value);
        int result = NativeMethods.GetAppContainerFolderPath(sidText, out nint path);
        if (result is FileNotFoundHResult or NotFoundHResult)
        {
            if (path != nint.Zero) Marshal.FreeCoTaskMem(path);
            return null;
        }
        if (result < 0 || path == nint.Zero) Marshal.ThrowExceptionForHR(result < 0 ? result : unchecked((int)0x80004005));
        try
        {
            string folder = Marshal.PtrToStringUni(path) ?? throw new InvalidDataException("AppContainer profile store path invalid");
            return Path.GetFullPath(folder);
        }
        finally { Marshal.FreeCoTaskMem(path); }
    }

    private static string SidToString(nint value)
    {
        if (!NativeMethods.ConvertSidToStringSid(value, out nint text) || text == nint.Zero)
            throw new IOException("AppContainer SID conversion failed", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        try { return Marshal.PtrToStringUni(text) ?? throw new InvalidDataException("AppContainer SID invalid"); }
        finally { _ = NativeMethods.LocalFree(text); }
    }

    private void CleanupProfile()
    {
        if (cleaned) return;
        int result = NativeMethods.DeleteAppContainerProfile(ProfileName);
        if (result < 0 && result is not FileNotFoundHResult and not NotFoundHResult) Marshal.ThrowExceptionForHR(result);
        if (profileFolder is not null && Directory.Exists(profileFolder)) throw new IOException("AppContainer profile store persisted after execution");
        cleaned = true;
        nint value = Interlocked.Exchange(ref sid, nint.Zero);
        if (value != nint.Zero) _ = NativeMethods.FreeSid(value);
        profileFolder = null;
        NamedMutexScope? mutex = Interlocked.Exchange(ref profileMutex, null);
        mutex?.Dispose();
        CrossSessionProfileLock? crossSession = Interlocked.Exchange(ref crossSessionLock, null);
        crossSession?.Dispose();
    }

    public void Dispose()
    {
        if (preserved) return;
        CleanupProfile();
    }
}

internal sealed class CrossSessionProfileLock : IDisposable
{
    private SafeFileHandle? handle;
    private CrossSessionProfileLock(SafeFileHandle value) => handle = value;

    internal static CrossSessionProfileLock Acquire(string appOwnedRoot)
    {
        string lockPath = Path.Combine(appOwnedRoot, "profile-security.lock");
        var deadline = System.Diagnostics.Stopwatch.StartNew();
        while (true)
        {
            SafeFileHandle? handle = null;
            try
            {
                nint raw = NativeMethods.CreateFile(NativeFilePath.ForApi(lockPath), NativeMethods.GenericRead | NativeMethods.GenericWrite, NativeMethods.FileShareNone, nint.Zero,
                    NativeMethods.OpenAlways, NativeMethods.FileFlagOpenReparsePoint | NativeMethods.FileFlagWriteThrough, nint.Zero);
                if (raw == NativeMethods.InvalidHandleValue)
                    throw new IOException("Cross-session profile lock open failed", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
                handle = new SafeFileHandle(raw, ownsHandle: true);
                _ = ReparsePointPolicy.CaptureAllowed(raw);
                if (!NativeMethods.GetFileInformationByHandle(raw, out NativeMethods.ByHandleFileInformation information) ||
                    (information.FileAttributes & (uint)FileAttributes.Directory) != 0 ||
                    !string.Equals(Path.GetFullPath(lockPath), FinalPath(raw), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Cross-session profile lock identity invalid");
                return new CrossSessionProfileLock(handle);
            }
            catch (IOException) when (deadline.Elapsed < TimeSpan.FromSeconds(30))
            {
                handle?.Dispose();
                Thread.Sleep(50);
            }
            catch
            {
                handle?.Dispose();
                throw;
            }
        }
    }

    private static string FinalPath(nint handle)
    {
        char[] buffer = new char[32768];
        uint length = NativeMethods.GetFinalPathNameByHandle(handle, buffer, checked((uint)buffer.Length), 0);
        if (length == 0 || length >= buffer.Length) throw new IOException("Cross-session profile lock path unavailable", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        string value = new(buffer, 0, checked((int)length));
        if (value.StartsWith(@"\\?\", StringComparison.Ordinal)) value = value[4..];
        return Path.GetFullPath(value);
    }

    public void Dispose()
    {
        SafeFileHandle? value = Interlocked.Exchange(ref handle, null);
        value?.Dispose();
    }
}
