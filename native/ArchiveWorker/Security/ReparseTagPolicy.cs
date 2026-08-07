namespace MinecraftCore.ArchiveWorker.Security;

internal static class ReparseTagPolicy
{
    private const uint NameSurrogateMask = 0x20000000;

    internal static bool IsNameSurrogate(uint tag) => (tag & NameSurrogateMask) != 0;
}
