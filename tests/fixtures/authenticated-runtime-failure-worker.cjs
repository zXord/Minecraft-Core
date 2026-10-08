'use strict';

// Protocol-only fixture: never imports a runtime installer, spawns descendants,
// opens a profile, writes files, starts Electron UI, or accesses the network.
process.once('message', request => {
  let response;
  if (request.operation === 'install-forge-server') {
    const protocol = require('../../electron/services/forge-installer-worker-protocol.cjs');
    const verified = protocol.verifyForgeInstallRequest(request, process.env[protocol.FORGE_WORKER_TOKEN_ENV]);
    response = protocol.createForgeInstallResponse({ token: process.env[protocol.FORGE_WORKER_TOKEN_ENV],
      requestId: verified.requestId, ok: false,
      runtimeDiagnostic: { stage: 'forge-installer', reason: 'unknown' } });
  } else {
    const protocol = require('../../electron/services/managed-runtime-worker-protocol.cjs');
    const verified = protocol.verifyManagedRuntimeRequest(request, process.env[protocol.MANAGED_RUNTIME_WORKER_TOKEN_ENV]);
    response = protocol.createManagedRuntimeResponse({ token: process.env[protocol.MANAGED_RUNTIME_WORKER_TOKEN_ENV],
      requestId: verified.requestId, operation: verified.operation, ok: false, code: 'RUNTIME_INCOMPLETE',
      runtimeDiagnostic: { stage: 'managed-verify', reason: 'unknown' } });
  }
  process.send(response, error => {
    if (!error && process.connected) process.disconnect();
    process.exit(error ? 70 : 1);
  });
});
