namespace MinecraftCore.ArchiveWorker.Security;

using System.ComponentModel;
using MinecraftCore.ArchiveWorker.Sandbox;

internal static class Redaction
{
    internal static string StableErrorCode(Exception exception) => exception switch
    {
        OperationCanceledException => "CANCELLED",
        ArchiveOutputLimitException => "ARCHIVE_LIMIT_EXCEEDED",
        QuiescenceUnprovenException => "EXTRACTOR_UNAVAILABLE",
        InvalidDataException => "EXTRACTOR_UNAVAILABLE",
        IOException => "EXTRACTOR_UNAVAILABLE",
        Win32Exception => "EXTRACTOR_UNAVAILABLE",
        TimeoutException => "EXTRACTOR_UNAVAILABLE",
        UnauthorizedAccessException => "EXTRACTOR_UNAVAILABLE",
        _ => "EXTRACTOR_FAILED"
    };
}
