namespace MinecraftCore.ArchiveWorker.Sandbox;

internal sealed class NamedMutexScope : IDisposable
{
    private static readonly TimeSpan AcquisitionTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan OwnerResponseTimeout = TimeSpan.FromSeconds(35);
    private readonly ManualResetEventSlim ready = new(false);
    private readonly ManualResetEventSlim release = new(false);
    private readonly ManualResetEventSlim exited = new(false);
    private Exception? ownerError;
    private int disposeStarted;

    private NamedMutexScope() { }

    internal static NamedMutexScope Enter(string name)
    {
        var scope = new NamedMutexScope();
        var ownerThread = new Thread(() => scope.Own(name))
        {
            IsBackground = true,
            Name = "ArchiveWorker security lease lock"
        };
        ownerThread.Start();
        if (!scope.ready.Wait(OwnerResponseTimeout))
        {
            scope.release.Set();
            if (scope.exited.Wait(TimeSpan.FromSeconds(5))) scope.DisposeSignals();
            throw new TimeoutException("Archive worker security lease lock owner did not respond");
        }
        if (scope.ownerError is not null)
        {
            if (!scope.exited.Wait(OwnerResponseTimeout))
                throw new TimeoutException("Archive worker security lease lock owner did not exit after acquisition failure");
            Exception error = scope.ownerError;
            scope.DisposeSignals();
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error).Throw();
        }
        return scope;
    }

    private void Own(string name)
    {
        Mutex? value = null;
        bool signaled = false;
        try
        {
            value = new Mutex(false, name);
            bool acquired;
            try { acquired = value.WaitOne(AcquisitionTimeout); }
            catch (AbandonedMutexException) { acquired = true; }
            if (!acquired) throw new TimeoutException("Archive worker security lease lock timed out");
            ready.Set();
            signaled = true;
            release.Wait();
            value.ReleaseMutex();
        }
        catch (Exception exception)
        {
            ownerError = exception;
            if (!signaled) ready.Set();
        }
        finally
        {
            value?.Dispose();
            exited.Set();
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposeStarted, 1) != 0) return;
        release.Set();
        if (!exited.Wait(OwnerResponseTimeout)) throw new TimeoutException("Archive worker security lease lock owner did not exit");
        Exception? error = ownerError;
        DisposeSignals();
        if (error is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error).Throw();
    }

    private void DisposeSignals()
    {
        ready.Dispose();
        release.Dispose();
        exited.Dispose();
    }
}
