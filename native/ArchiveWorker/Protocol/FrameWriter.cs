using System.Buffers.Binary;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

namespace MinecraftCore.ArchiveWorker.Protocol;

internal static class FrameWriter
{
    private const int MaximumFrameBytes = 1024 * 1024;

    internal static async Task WriteAsync<T>(Stream stream, T value, JsonTypeInfo<T> typeInfo, CancellationToken cancellationToken = default)
    {
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(value, typeInfo);
        if (body.Length is < 2 or > MaximumFrameBytes) throw new InvalidDataException("Invalid output frame size");
        byte[] prefix = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(prefix, (uint)body.Length);
        await stream.WriteAsync(prefix, cancellationToken).ConfigureAwait(false);
        await stream.WriteAsync(body, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
    }
}
