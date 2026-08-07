namespace MinecraftCore.ArchiveWorker.Sandbox;

internal static class AclAccessMaskPolicy
{
    internal const uint GenericRead = 0x80000000;
    internal const uint GenericWrite = 0x40000000;
    internal const uint GenericExecute = 0x20000000;
    internal const uint GenericAll = 0x10000000;
    internal const uint FileGenericRead = 0x00120089;
    internal const uint FileGenericWrite = 0x00120116;
    internal const uint FileGenericExecute = 0x001200a0;
    private const uint GenericBits = GenericRead | GenericWrite | GenericExecute | GenericAll;

    internal static uint MapFile(uint mask)
    {
        if ((mask & GenericAll) != 0) throw new InvalidDataException("Generic-all ACL grants are rejected");
        uint mapped = mask & ~GenericBits;
        if ((mask & GenericRead) != 0) mapped |= FileGenericRead;
        if ((mask & GenericWrite) != 0) mapped |= FileGenericWrite;
        if ((mask & GenericExecute) != 0) mapped |= FileGenericExecute;
        return mapped;
    }
}
