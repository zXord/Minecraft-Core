using System.Buffers;
using System.Buffers.Binary;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

namespace MinecraftCore.ArchiveWorker.Protocol;

internal static class FrameReader
{
    private const int MaximumRequestBytes = 1024 * 1024;
    private const int MaximumTokens = 16 * 1024;
    private const int MaximumStringBytes = 256 * 1024;

    internal static async Task<T> ReadExactlyOneAsync<T>(Stream stream, JsonTypeInfo<T> typeInfo, CancellationToken cancellationToken) where T : class
    {
        T result = await ReadOneRequiredAsync(stream, typeInfo, cancellationToken).ConfigureAwait(false);
        byte[] extra = new byte[1];
        if (await stream.ReadAsync(extra, cancellationToken).ConfigureAwait(false) != 0) throw new InvalidDataException("More than one request");
        return result;
    }

    internal static async Task<T> ReadOneRequiredAsync<T>(Stream stream, JsonTypeInfo<T> typeInfo, CancellationToken cancellationToken) where T : class =>
        await ReadOneOrEndAsync(stream, typeInfo, cancellationToken).ConfigureAwait(false) ?? throw new EndOfStreamException("Missing frame");

    internal static async Task<T?> ReadOneOrEndAsync<T>(Stream stream, JsonTypeInfo<T> typeInfo, CancellationToken cancellationToken) where T : class
    {
        byte[] prefix = new byte[4];
        int first = await stream.ReadAsync(prefix.AsMemory(0, 1), cancellationToken).ConfigureAwait(false);
        if (first == 0) return null;
        await ReadExactlyAsync(stream, prefix.AsMemory(1), cancellationToken).ConfigureAwait(false);
        uint length = BinaryPrimitives.ReadUInt32LittleEndian(prefix);
        if (length is < 2 or > MaximumRequestBytes) throw new InvalidDataException("Invalid frame length");
        byte[] rented = ArrayPool<byte>.Shared.Rent((int)length);
        try
        {
            Memory<byte> body = rented.AsMemory(0, (int)length);
            await ReadExactlyAsync(stream, body, cancellationToken).ConfigureAwait(false);
            ValidateStrictJson(body.Span);
            return JsonSerializer.Deserialize(body.Span, typeInfo) ?? throw new InvalidDataException("Missing request");
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(rented, clearArray: true);
        }
    }

    private static async Task ReadExactlyAsync(Stream stream, Memory<byte> destination, CancellationToken cancellationToken)
    {
        int offset = 0;
        while (offset < destination.Length)
        {
            int read = await stream.ReadAsync(destination[offset..], cancellationToken).ConfigureAwait(false);
            if (read == 0) throw new EndOfStreamException("Truncated frame");
            offset += read;
        }
    }

    internal static void ValidateStrictJson(ReadOnlySpan<byte> bytes)
    {
        var reader = new Utf8JsonReader(bytes, new JsonReaderOptions { MaxDepth = 32, CommentHandling = JsonCommentHandling.Disallow });
        var objectProperties = new Stack<HashSet<string>>(32);
        int tokens = 0;
        while (reader.Read())
        {
            if (++tokens > MaximumTokens) throw new JsonException("JSON token limit");
            long valueLength = reader.HasValueSequence ? reader.ValueSequence.Length : reader.ValueSpan.Length;
            if ((reader.TokenType is JsonTokenType.String or JsonTokenType.PropertyName) && valueLength > MaximumStringBytes) throw new JsonException("JSON string limit");
            switch (reader.TokenType)
            {
                case JsonTokenType.StartObject:
                    objectProperties.Push(new HashSet<string>(StringComparer.Ordinal));
                    break;
                case JsonTokenType.PropertyName:
                    if (objectProperties.Count == 0 || !objectProperties.Peek().Add(reader.GetString()!)) throw new JsonException("Duplicate JSON key");
                    break;
                case JsonTokenType.EndObject:
                    if (objectProperties.Count == 0) throw new JsonException("Invalid JSON object");
                    objectProperties.Pop();
                    break;
            }
        }
        if (reader.BytesConsumed != bytes.Length || objectProperties.Count != 0) throw new JsonException("Invalid JSON");
    }
}
