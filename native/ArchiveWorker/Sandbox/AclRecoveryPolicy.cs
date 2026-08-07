namespace MinecraftCore.ArchiveWorker.Sandbox;

internal enum ProcessIdentityState { Exited, Live, Ambiguous }

internal static class AclRecoveryPolicy
{
    internal static bool CanReclaim(ProcessIdentityState owner, IEnumerable<ProcessIdentityState> children) =>
        owner == ProcessIdentityState.Exited && children.All(state => state == ProcessIdentityState.Exited);

    internal static int ExcessExactAceCount(int current, int baseline)
    {
        if (current < 0 || baseline < 0 || current < baseline) throw new InvalidDataException("ACL exact baseline was reduced externally");
        return current - baseline;
    }
}

internal static class AclCompletionPolicy
{
    internal static void Complete<T>(IReadOnlyList<T> registeredTrees, Action cleanupDirectGrants, Action<T> scrubTree,
        Action closeJournal, Action clearRegistrations)
    {
        cleanupDirectGrants();
        foreach (T tree in registeredTrees) scrubTree(tree);
        closeJournal();
        clearRegistrations();
    }
}
