const { runtimeDiagnosticFor } = require('./runtime-diagnostic.cjs');
const {
  FORGE_WORKER_TOKEN_ENV,
  createForgeInstallResponse,
  verifyForgeInstallRequest
} = require('./forge-installer-worker-protocol.cjs');

const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;

function startForgeInstallerWorker(options = {}) {
  const processRef = options.processRef || process;
  const environment = processRef.env || {};
  const token = environment[FORGE_WORKER_TOKEN_ENV];
  delete environment[FORGE_WORKER_TOKEN_ENV];

  const requestTimeoutMs = Number.isSafeInteger(options.requestTimeoutMs) && options.requestTimeoutMs > 0
    ? options.requestTimeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS;
  let accepted = false;
  let finished = false;
  let parentDisconnected = false;
  let requestTimer = null;
  let installTask = null;
  let cancellationWork = null;
  const activeChildren = new Set();
  const childClosures = [];
  const cancelInstallation = () => {
    for (const child of activeChildren) {
      try { child.kill('SIGKILL'); } catch { /* close remains the only cleanup authority */ }
    }
    if (installTask && !cancellationWork) {
      cancellationWork = Promise.resolve().then(() => installTask.cancel()).catch(() => {});
    }
  };
  const spawnOwnedJava = (...args) => {
    if (parentDisconnected) throw new Error('Forge installation was cancelled');
    const child = (options.spawnImpl || require('node:child_process').spawn)(...args);
    activeChildren.add(child);
    childClosures.push(new Promise(resolve => {
      child.once('close', () => {
        activeChildren.delete(child);
        resolve();
      });
    }));
    return child;
  };

  const hardExit = code => {
    if (finished) return;
    finished = true;
    clearTimeout(requestTimer);
    processRef.exit(code);
  };
  const sendAndExit = (response, code) => {
    if (finished) return;
    finished = true;
    clearTimeout(requestTimer);
    let exitTimer = setTimeout(() => processRef.exit(70), 1000);
    try {
      if (!processRef.connected || typeof processRef.send !== 'function') {
        clearTimeout(exitTimer);
        processRef.exit(70);
        return;
      }
      processRef.send(response, error => {
        clearTimeout(exitTimer);
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

  processRef.once?.('disconnect', () => {
    parentDisconnected = true;
    cancelInstallation();
    clearTimeout(requestTimer);
    // Once an install has started, its promise owns any Java processor
    // children. Keep this worker alive until that operation settles so an IPC
    // disconnect cannot orphan those children.
    if (!accepted) hardExit(65);
  });
  processRef.on?.('message', async message => {
    if (finished) return;
    if (accepted) {
      hardExit(64);
      return;
    }
    accepted = true;
    clearTimeout(requestTimer);

    let verified;
    try {
      verified = verifyForgeInstallRequest(message, token);
    } catch {
      hardExit(64);
      return;
    }

    try {
      const version = {
        version: verified.payload.loaderVersion,
        mcversion: verified.payload.minecraftVersion
      };
      try {
        if (options.installForgeImpl && !options.installForgeTaskImpl) {
          await options.installForgeImpl(version, verified.payload.targetPath, {
            side: 'server', java: verified.payload.javaPath
          });
        } else {
          const createTask = options.installForgeTaskImpl || require('@xmcl/installer').installForgeTask;
          installTask = createTask(version, verified.payload.targetPath, {
            side: 'server', java: verified.payload.javaPath, spawn: spawnOwnedJava
          });
          await installTask.startAndWait();
        }
      } finally {
        if (cancellationWork) await cancellationWork;
        // XMCL can settle on exit (and cancel before killing). Only each exact
        // spawned child's close event proves its output and file writes ended.
        await Promise.all(childClosures);
      }
      if (finished) return;
      if (parentDisconnected) {
        hardExit(65);
        return;
      }
      sendAndExit(createForgeInstallResponse({
        token,
        requestId: verified.requestId,
        ok: true
      }), 0);
    } catch (error) {
      if (finished) return;
      if (parentDisconnected) {
        hardExit(65);
        return;
      }
      sendAndExit(createForgeInstallResponse({
        token,
        requestId: verified.requestId,
        ok: false,
        runtimeDiagnostic: runtimeDiagnosticFor(error, 'forge-installer')
      }), 1);
    }
  });

  requestTimer = setTimeout(() => hardExit(64), requestTimeoutMs);
  requestTimer.unref?.();
  return { started: true };
}

if (require.main === module) {
  startForgeInstallerWorker();
}

module.exports = {
  startForgeInstallerWorker
};
