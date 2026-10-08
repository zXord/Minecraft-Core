namespace MinecraftCore.ArchiveWorker.Durability;

internal static class DurabilityRetryExecutor
{
    internal static async Task ExecuteAsync(
        Action execute,
        Func<Exception, string> classifyFailureKind,
        Func<Exception, string> classifyFailureStage,
        Func<int, Task> delayAsync,
        Action<int, int>? onRetry = null)
    {
        ArgumentNullException.ThrowIfNull(execute);
        ArgumentNullException.ThrowIfNull(classifyFailureKind);
        ArgumentNullException.ThrowIfNull(classifyFailureStage);
        ArgumentNullException.ThrowIfNull(delayAsync);

        int retryIndex = 0;
        while (true)
        {
            try
            {
                execute();
                return;
            }
            catch (Exception exception)
            {
                string failureKind = classifyFailureKind(exception);
                string failureStage = classifyFailureStage(exception);
                if (!DurabilityRetryPolicy.TryGetDelayMilliseconds(
                    failureKind, failureStage, retryIndex, out int delayMilliseconds))
                {
                    throw;
                }
                retryIndex++;
                onRetry?.Invoke(retryIndex, delayMilliseconds);
                await delayAsync(delayMilliseconds).ConfigureAwait(false);
            }
        }
    }
}
