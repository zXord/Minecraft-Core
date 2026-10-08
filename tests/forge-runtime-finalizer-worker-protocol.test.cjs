const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let protocol = null;
try {
  protocol = require('../electron/services/forge-runtime-finalizer-worker-protocol.cjs');
} catch {
  // The first TDD run intentionally reaches the assertions below without the module.
}

const token = '1'.repeat(64);
const requestId = '2'.repeat(32);
const runtime = Object.freeze({
  minecraftVersion: '1.12.2',
  loaderFamily: 'forge',
  loaderVersion: '14.23.5.2860',
  javaMajor: 8,
  os: 'win32',
  architecture: 'x64'
});
const validation = Object.freeze({
  valid: true,
  runtime,
  loader: {
    family: 'forge',
    launchJar: 'forge-1.12.2-14.23.5.2860.jar',
    serverJar: 'minecraft_server.1.12.2.jar',
    libraries: ['libraries/example/runtime.jar']
  },
  artifacts: [
    {
      relativePath: 'forge-1.12.2-14.23.5.2860.jar',
      size: 5,
      sha256: 'c'.repeat(64),
      sha512: 'd'.repeat(128)
    },
    {
      relativePath: 'libraries/example/runtime.jar',
      size: 7,
      sha256: 'a'.repeat(64),
      sha512: 'b'.repeat(128)
    },
    {
      relativePath: 'minecraft_server.1.12.2.jar',
      size: 6,
      sha256: 'e'.repeat(64),
      sha512: 'f'.repeat(128)
    }
  ]
});

test('finalizer request authenticates the exact target and Forge runtime tuple', () => {
  assert.equal(typeof protocol?.createForgeFinalizerRequest, 'function');
  const targetPath = path.resolve('forge-finalizer-protocol', 'server');
  const request = protocol.createForgeFinalizerRequest({
    token,
    requestId,
    payload: { targetPath, runtime }
  });

  assert.deepEqual(protocol.verifyForgeFinalizerRequest(request, token), {
    requestId,
    payload: { targetPath, runtime }
  });
  assert.throws(
    () => protocol.verifyForgeFinalizerRequest({ ...request, payload: {
      ...request.payload,
      runtime: { ...runtime, loaderVersion: '14.23.5.9999' }
    } }, token),
    error => error.code === 'FORGE_FINALIZER_PROTOCOL'
  );
});

test('finalizer request rejects absolute path aliases instead of authenticating ambiguous targets', () => {
  assert.equal(typeof protocol?.createForgeFinalizerRequest, 'function');
  const root = path.resolve('forge-finalizer-protocol');
  const aliasedTarget = `${root}${path.sep}nested${path.sep}..${path.sep}server`;

  assert.equal(path.isAbsolute(aliasedTarget), true);
  assert.notEqual(path.normalize(aliasedTarget), aliasedTarget);
  assert.throws(
    () => protocol.createForgeFinalizerRequest({
      token,
      requestId,
      payload: { targetPath: aliasedTarget, runtime }
    }),
    error => error.code === 'FORGE_FINALIZER_PROTOCOL'
  );
});

test('finalizer response authenticates the complete validation result', () => {
  assert.equal(typeof protocol?.createForgeFinalizerResponse, 'function');
  const response = protocol.createForgeFinalizerResponse({ token, requestId, ok: true, validation });

  assert.deepEqual(protocol.verifyForgeFinalizerResponse(response, token, requestId, runtime), {
    ok: true,
    validation
  });
  assert.throws(
    () => protocol.verifyForgeFinalizerResponse({
      ...response,
      validation: {
        ...response.validation,
        artifacts: [{ ...response.validation.artifacts[0], size: 8 }]
      }
    }, token, requestId, runtime),
    error => error.code === 'FORGE_FINALIZER_PROTOCOL'
  );
});

test('finalizer response rejects malformed and oversized result shapes', () => {
  assert.equal(typeof protocol?.createForgeFinalizerResponse, 'function');
  assert.throws(
    () => protocol.createForgeFinalizerResponse({
      token,
      requestId,
      ok: true,
      validation: { ...validation, artifacts: Array.from({ length: 10001 }, () => validation.artifacts[0]) }
    }),
    error => error.code === 'FORGE_FINALIZER_PROTOCOL'
  );
  assert.throws(
    () => protocol.createForgeFinalizerResponse({ token, requestId, ok: false, validation }),
    error => error.code === 'FORGE_FINALIZER_PROTOCOL'
  );
  assert.throws(
    () => protocol.createForgeFinalizerResponse({
      token,
      requestId,
      ok: true,
      validation: {
        ...validation,
        loader: { ...validation.loader, launchJar: 'forge-1.12.2-14.23.5.9999.jar' }
      }
    }),
    error => error.code === 'FORGE_FINALIZER_PROTOCOL'
  );
  assert.throws(
    () => protocol.createForgeFinalizerResponse({
      token,
      requestId,
      ok: true,
      validation: { ...validation, artifacts: validation.artifacts.slice(1) }
    }),
    error => error.code === 'FORGE_FINALIZER_PROTOCOL'
  );
  assert.throws(
    () => protocol.createForgeFinalizerResponse({
      token,
      requestId,
      ok: true,
      validation: {
        ...validation,
        artifacts: [...validation.artifacts, {
          relativePath: 'libraries/optional/config.',
          size: 1,
          sha256: '1'.repeat(64),
          sha512: '2'.repeat(128)
        }]
      }
    }),
    error => error.code === 'FORGE_FINALIZER_PROTOCOL'
  );
});
