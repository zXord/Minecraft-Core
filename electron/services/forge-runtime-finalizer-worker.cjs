const { runtimeDiagnosticFor } = require('./runtime-diagnostic.cjs');
const {
  FORGE_FINALIZER_TOKEN_ENV,
  createForgeFinalizerResponse,
  verifyForgeFinalizerRequest
} = require('./forge-runtime-finalizer-worker-protocol.cjs');

// The parent boundary permits fifteen minutes for a real Forge finalization.
// Do not let this child impose a shorter, hidden 30-second deadline.
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

function startForgeRuntimeFinalizerWorker(options = {}) {
  const processRef = options.processRef || process;
  const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
  const environment = processRef.env || {};
  const token = environment[FORGE_FINALIZER_TOKEN_ENV];
  delete environment[FORGE_FINALIZER_TOKEN_ENV];
  const requestTimeoutMs = Number.isSafeInteger(options.requestTimeoutMs) && options.requestTimeoutMs > 0
    ? options.requestTimeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS;
  let accepted = false;
  let finished = false;
  let requestTimer = null;

  const hardExit = code => {
    if (finished) return;
    finished = true;
    clearTimeoutImpl(requestTimer);
    processRef.exit(code);
  };
  const sendAndExit = (response, code) => {
    if (finished) return;
    finished = true;
    clearTimeoutImpl(requestTimer);
    let exitTimer = setTimeoutImpl(() => processRef.exit(70), 1000);
    try {
      if (!processRef.connected || typeof processRef.send !== 'function') {
        clearTimeoutImpl(exitTimer);
        processRef.exit(70);
        return;
      }
      processRef.send(response, error => {
        clearTimeoutImpl(exitTimer);
        exitTimer = null;
        if (!error) {
          try { processRef.disconnect?.(); } catch { /* process exit remains authoritative */ }
        }
        processRef.exit(error ? 70 : code);
      });
    } catch {
      clearTimeout(exitTimer);
      processRef.exit(70);
    }
  };

  processRef.once?.('disconnect', () => hardExit(65));
  processRef.on?.('message', async message => {
    if (finished) return;
    if (accepted) {
      hardExit(64);
      return;
    }
    accepted = true;
    clearTimeoutImpl(requestTimer);

    let verified;
    try {
      verified = verifyForgeFinalizerRequest(message, token);
    } catch {
      hardExit(64);
      return;
    }

    let diagnosticStage = 'finalizer-load';
    try {
      const finalizer = options.finalizeForgeRuntimeImpl ||
        require('./loader-install-service.cjs').__testUtils.finalizeForgeRuntimeMetadata;
      if (typeof finalizer !== 'function') throw new Error('Forge runtime finalizer unavailable');
      diagnosticStage = 'finalizer-layout';
      const validation = await finalizer(verified.payload.targetPath, verified.payload.runtime);
      if (finished) return;
      diagnosticStage = 'finalizer-response';
      sendAndExit(createForgeFinalizerResponse({
        token,
        requestId: verified.requestId,
        ok: true,
        validation
      }), 0);
    } catch (error) {
      if (finished) return;
      sendAndExit(createForgeFinalizerResponse({
        token,
        requestId: verified.requestId,
        ok: false,
        validation: null,
        runtimeDiagnostic: runtimeDiagnosticFor(error, diagnosticStage)
      }), 1);
    }
  });

  requestTimer = setTimeoutImpl(() => hardExit(64), requestTimeoutMs);
  requestTimer.unref?.();
  return { started: true };
}

if (require.main === module) {
  startForgeRuntimeFinalizerWorker();
}

module.exports = {
  startForgeRuntimeFinalizerWorker
};
