const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let protocol = null;
try {
  protocol = require('../electron/services/forge-installer-worker-protocol.cjs');
} catch {
  // The first TDD run intentionally reaches the assertions below without the module.
}

const token = 'a'.repeat(64);
const requestId = 'b'.repeat(32);
const payload = Object.freeze({
  targetPath: path.resolve('protocol-fixture', 'server'),
  minecraftVersion: '1.12.2',
  loaderVersion: '14.23.5.2860',
  javaPath: path.resolve('protocol-fixture', 'java', 'bin', 'java.exe')
});

test('Forge worker requests authenticate every bounded payload field without carrying the secret', () => {
  assert.equal(typeof protocol?.createForgeInstallRequest, 'function');
  const request = protocol.createForgeInstallRequest({ token, requestId, payload });

  assert.equal(JSON.stringify(request).includes(token), false);
  assert.deepEqual(protocol.verifyForgeInstallRequest(request, token), {
    requestId,
    payload: { ...payload }
  });

  assert.throws(
    () => protocol.verifyForgeInstallRequest({
      ...request,
      payload: { ...request.payload, targetPath: path.resolve('tampered', 'server') }
    }, token),
    error => error.code === 'FORGE_WORKER_PROTOCOL'
  );
  assert.throws(
    () => protocol.verifyForgeInstallRequest({ ...request, unexpected: true }, token),
    error => error.code === 'FORGE_WORKER_PROTOCOL'
  );
});

test('Forge worker responses authenticate one closed result shape and cannot carry diagnostics', () => {
  assert.equal(typeof protocol?.createForgeInstallResponse, 'function');
  const success = protocol.createForgeInstallResponse({ token, requestId, ok: true });
  const failure = protocol.createForgeInstallResponse({ token, requestId, ok: false });

  assert.deepEqual(protocol.verifyForgeInstallResponse(success, token, requestId), { ok: true });
  assert.deepEqual(protocol.verifyForgeInstallResponse(failure, token, requestId), { ok: false });
  assert.deepEqual(Object.keys(failure).sort(), ['auth', 'code', 'ok', 'protocolVersion', 'requestId']);
  assert.equal(JSON.stringify(failure).includes(payload.targetPath), false);
  assert.equal(JSON.stringify(failure).includes(payload.javaPath), false);

  assert.throws(
    () => protocol.verifyForgeInstallResponse({ ...success, ok: false }, token, requestId),
    error => error.code === 'FORGE_WORKER_PROTOCOL'
  );
  assert.throws(
    () => protocol.verifyForgeInstallResponse({ ...failure, diagnostic: payload.targetPath }, token, requestId),
    error => error.code === 'FORGE_WORKER_PROTOCOL'
  );
});
