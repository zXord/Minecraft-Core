using System.Buffers;
using System.Text;

namespace MinecraftCore.ArchiveWorker.Protocol;

internal static class TextChunker
{
    internal static IEnumerable<string> SplitScalars(string value, int maximumUtf16CodeUnits)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (maximumUtf16CodeUnits < 1) throw new ArgumentOutOfRangeException(nameof(maximumUtf16CodeUnits));
        int start = 0;
        while (start < value.Length)
        {
            int end = start;
            while (end < value.Length)
            {
                OperationStatus status = Rune.DecodeFromUtf16(value.AsSpan(end), out _, out int consumed);
                if (status != OperationStatus.Done) throw new InvalidDataException("Invalid Unicode scalar sequence");
                if (end > start && end + consumed - start > maximumUtf16CodeUnits) break;
                end += consumed;
                if (end - start >= maximumUtf16CodeUnits) break;
            }
            yield return value[start..end];
            start = end;
        }
    }
}
