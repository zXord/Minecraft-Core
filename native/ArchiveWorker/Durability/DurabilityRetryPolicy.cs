namespace MinecraftCore.ArchiveWorker.Durability;

internal static class DurabilityRetryPolicy
{
    private static readonly int[] RetryDelaysMilliseconds = [50, 150, 400, 800];

    internal static bool TryGetDelayMilliseconds(
        string failureKind,
        string failureStage,
        int retryIndex,
        out int delayMilliseconds)
    {
        delayMilliseconds = 0;
        // Disposition/close/parent-flush can already have deleted the leaf.
        if (failureStage is "handle-disposition" or "delete-close" or "delete-parent-flush") return false;
        if (!string.Equals(failureKind, "sharing-violation", StringComparison.Ordinal) ||
            retryIndex < 0 || retryIndex >= RetryDelaysMilliseconds.Length)
        {
            return false;
        }

        bool prePublicationStage = failureStage is
            "root-open" or
            "source-open" or
            "destination-parent-open" or
            "source-parent-open" or
            "ancestor-open" or
            "preflight-revalidation";
        if (!prePublicationStage) return false;

        delayMilliseconds = RetryDelaysMilliseconds[retryIndex];
        return true;
    }
}
