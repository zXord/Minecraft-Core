namespace MinecraftCore.ArchiveWorker.Security;

internal static class PathInputPolicy
{
    internal static bool HasTraversalAlias(string value) =>
        value.Split(['\\', '/'], StringSplitOptions.None).Any(component => component is "." or "..");
}
