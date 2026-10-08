const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let protocol = null;
try {
  protocol = require('../electron/services/managed-runtime-worker-protocol.cjs');
} catch {
  // The first TDD run intentionally reaches the assertions below without the module.
}

const token = 'a'.repeat(64);
const requestId = 'b'.repeat(32);
const targetPath = path.resolve('managed-runtime-protocol', 'server');
const javaPath = path.resolve('managed-runtime-protocol', 'java', 'bin', 'java.exe');
const runtime = Object.freeze({
  minecraftVersion: '1.20.1',
  loaderFamily: 'fabric',
  loaderVersion: '0.16.14',
  javaMajor: 17,
  os: 'win32',
  architecture: 'x64'
});

function protocolFailure(error) {
  return error?.code === 'MANAGED_RUNTIME_WORKER_PROTOCOL';
}

test('prepare requests authenticate the exact canonical target, runtime, and Java payload', () => {
  assert.equal(typeof protocol?.createManagedRuntimeRequest, 'function');
  const request = protocol.createManagedRuntimeRequest({
    token,
    requestId,
    operation: protocol.MANAGED_RUNTIME_PREPARE_OPERATION,
    payload: { targetPath, runtime, javaPath }
  });

  assert.equal(JSON.stringify(request).includes(token), false);
  assert.deepEqual(protocol.verifyManagedRuntimeRequest(request, token), {
    requestId,
    operation: protocol.MANAGED_RUNTIME_PREPARE_OPERATION,
    payload: { targetPath, runtime, javaPath }
  });

  for (const [field, value] of [
    ['targetPath', path.resolve('managed-runtime-protocol', 'other-server')],
    ['javaPath', path.resolve('managed-runtime-protocol', 'other-java.exe')]
  ]) {
    assert.throws(
      () => protocol.verifyManagedRuntimeRequest({
        ...request,
        payload: { ...request.payload, [field]: value }
      }, token),
      protocolFailure
    );
  }
  assert.throws(
    () => protocol.verifyManagedRuntimeRequest({
      ...request,
      payload: { ...request.payload, runtime: { ...runtime, loaderVersion: '0.16.15' } }
    }, token),
    protocolFailure
  );
  assert.throws(
    () => protocol.verifyManagedRuntimeRequest({ ...request, unexpected: true }, token),
    protocolFailure
  );
});

test('request operations have distinct exact payloads and reject non-canonical or unbounded paths', () => {
  assert.equal(typeof protocol?.createManagedRuntimeRequest, 'function');
  const verifyRequest = protocol.createManagedRuntimeRequest({
    token,
    requestId,
    operation: protocol.MANAGED_RUNTIME_VERIFY_OPERATION,
    payload: { targetPath, runtime }
  });

  assert.deepEqual(protocol.verifyManagedRuntimeRequest(verifyRequest, token), {
    requestId,
    operation: protocol.MANAGED_RUNTIME_VERIFY_OPERATION,
    payload: { targetPath, runtime }
  });
  assert.throws(
    () => protocol.createManagedRuntimeRequest({
      token,
      requestId,
      operation: protocol.MANAGED_RUNTIME_VERIFY_OPERATION,
      payload: { targetPath, runtime, javaPath }
    }),
    protocolFailure
  );
  assert.throws(
    () => protocol.createManagedRuntimeRequest({
      token,
      requestId,
      operation: protocol.MANAGED_RUNTIME_PREPARE_OPERATION,
      payload: { targetPath: `${targetPath}${path.sep}..${path.sep}server`, runtime, javaPath }
    }),
    protocolFailure
  );
  assert.throws(
    () => protocol.createManagedRuntimeRequest({
      token,
      requestId,
      operation: protocol.MANAGED_RUNTIME_PREPARE_OPERATION,
      payload: { targetPath, runtime, javaPath: `${path.parse(javaPath).root}${'x'.repeat(32768)}` }
    }),
    protocolFailure
  );
});

test('prepare responses authenticate a small closed result and a closed failure code', () => {
  assert.equal(typeof protocol?.createManagedRuntimeResponse, 'function');
  const success = protocol.createManagedRuntimeResponse({
    token,
    requestId,
    operation: protocol.MANAGED_RUNTIME_PREPARE_OPERATION,
    ok: true,
    result: { valid: true, runtime }
  });
  const failure = protocol.createManagedRuntimeResponse({
    token,
    requestId,
    operation: protocol.MANAGED_RUNTIME_PREPARE_OPERATION,
    ok: false,
    code: 'LOADER_VERSION_UNAVAILABLE'
  });

  assert.deepEqual(protocol.verifyManagedRuntimeResponse(
    success,
    token,
    requestId,
    protocol.MANAGED_RUNTIME_PREPARE_OPERATION,
    runtime
  ), { ok: true, code: null, result: { valid: true, runtime } });
  assert.deepEqual(protocol.verifyManagedRuntimeResponse(
    failure,
    token,
    requestId,
    protocol.MANAGED_RUNTIME_PREPARE_OPERATION,
    runtime
  ), { ok: false, code: 'LOADER_VERSION_UNAVAILABLE', result: null });
  assert.deepEqual(Object.keys(failure).sort(), [
    'auth', 'code', 'ok', 'operation', 'protocolVersion', 'requestId', 'result'
  ]);
  assert.equal(JSON.stringify(failure).includes(targetPath), false);
  assert.equal(JSON.stringify(failure).includes(javaPath), false);
  assert.throws(
    () => protocol.verifyManagedRuntimeResponse(
      { ...failure, diagnostic: targetPath },
      token,
      requestId,
      protocol.MANAGED_RUNTIME_PREPARE_OPERATION,
      runtime
    ),
    protocolFailure
  );
});

test('verify responses authenticate bounded validation evidence for later async launch validation', () => {
  assert.equal(typeof protocol?.createManagedRuntimeResponse, 'function');
  const validation = {
    valid: true,
    runtime,
    loader: { family: 'fabric', launcherJar: 'fabric-server-launch.jar' },
    artifacts: [{
      relativePath: 'fabric-server-launch.jar',
      size: 7,
      sha256: 'c'.repeat(64),
      sha512: 'd'.repeat(128)
    }, {
      relativePath: 'server.jar',
      size: 8,
      sha256: 'e'.repeat(64),
      sha512: 'f'.repeat(128)
    }]
  };
  const response = protocol.createManagedRuntimeResponse({
    token,
    requestId,
    operation: protocol.MANAGED_RUNTIME_VERIFY_OPERATION,
    ok: true,
    result: validation
  });

  assert.deepEqual(protocol.verifyManagedRuntimeResponse(
    response,
    token,
    requestId,
    protocol.MANAGED_RUNTIME_VERIFY_OPERATION,
    runtime
  ), { ok: true, code: null, result: validation });
  assert.throws(
    () => protocol.verifyManagedRuntimeResponse({
      ...response,
      result: { ...response.result, runtime: { ...runtime, javaMajor: 21 } }
    }, token, requestId, protocol.MANAGED_RUNTIME_VERIFY_OPERATION, runtime),
    protocolFailure
  );
  assert.throws(
    () => protocol.createManagedRuntimeResponse({
      token,
      requestId,
      operation: protocol.MANAGED_RUNTIME_VERIFY_OPERATION,
      ok: true,
      result: {
        ...validation,
        artifacts: Array.from({ length: 10001 }, (_, index) => ({
          ...validation.artifacts[0],
          relativePath: `libraries/example/${index}.jar`
        }))
      }
    }),
    protocolFailure
  );
});

test('verify responses preserve the exact NeoForge and Quilt loader metadata shapes', () => {
  assert.equal(typeof protocol?.createManagedRuntimeResponse, 'function');
  const fixtures = [
    {
      runtime: { ...runtime, loaderFamily: 'neoforge', loaderVersion: '21.1.172' },
      loader: {
        family: 'neoforge',
        argsFile: 'libraries/net/neoforged/neoforge/21.1.172/win_args.txt',
        universalJar: 'libraries/net/neoforged/neoforge/21.1.172/neoforge-21.1.172-universal.jar'
      },
      requiredPaths: [
        'libraries/net/neoforged/neoforge/21.1.172/win_args.txt',
        'libraries/net/neoforged/neoforge/21.1.172/neoforge-21.1.172-universal.jar',
        'server.jar',
        'user_jvm_args.txt'
      ]
    },
    {
      runtime: { ...runtime, loaderFamily: 'quilt', loaderVersion: '0.28.1' },
      loader: {
        family: 'quilt',
        launcherJar: 'quilt-server-launch.jar',
        properties: 'quilt-server-launcher.properties',
        libraries: [{
          coordinate: 'org.quiltmc:quilt-loader:0.28.1',
          repository: 'https://maven.quiltmc.org/repository/release/',
          relativePath: 'libraries/org/quiltmc/quilt-loader/0.28.1/quilt-loader-0.28.1.jar'
        }]
      },
      requiredPaths: [
        'quilt-server-launch.jar',
        'quilt-server-launcher.properties',
        'server.jar',
        'libraries/org/quiltmc/quilt-loader/0.28.1/quilt-loader-0.28.1.jar'
      ]
    }
  ];

  for (const fixture of fixtures) {
    const result = {
      valid: true,
      runtime: fixture.runtime,
      loader: fixture.loader,
      artifacts: fixture.requiredPaths.map((relativePath, index) => ({
        relativePath,
        size: 7 + index,
        sha256: 'e'.repeat(64),
        sha512: 'f'.repeat(128)
      }))
    };
    const response = protocol.createManagedRuntimeResponse({
      token,
      requestId,
      operation: protocol.MANAGED_RUNTIME_VERIFY_OPERATION,
      ok: true,
      result
    });
    assert.deepEqual(protocol.verifyManagedRuntimeResponse(
      response,
      token,
      requestId,
      protocol.MANAGED_RUNTIME_VERIFY_OPERATION,
      fixture.runtime
    ), { ok: true, code: null, result });
  }
});

test('verify responses bind tuple-derived loader names and every loader-critical artifact', () => {
  assert.equal(typeof protocol?.createManagedRuntimeResponse, 'function');
  const baseArtifact = relativePath => ({
    relativePath,
    size: 7,
    sha256: '1'.repeat(64),
    sha512: '2'.repeat(128)
  });
  const invalidResults = [
    {
      valid: true,
      runtime: { ...runtime, loaderFamily: 'vanilla', loaderVersion: '1.20.1' },
      loader: { family: 'vanilla', serverJar: 'custom-server.jar' },
      artifacts: [baseArtifact('custom-server.jar')]
    },
    {
      valid: true,
      runtime,
      loader: { family: 'fabric', launcherJar: 'custom-fabric.jar' },
      artifacts: [baseArtifact('custom-fabric.jar'), baseArtifact('server.jar')]
    },
    {
      valid: true,
      runtime,
      loader: { family: 'fabric', launcherJar: 'fabric-server-launch.jar' },
      artifacts: [baseArtifact('server.jar')]
    },
    {
      valid: true,
      runtime: { ...runtime, loaderFamily: 'forge', loaderVersion: '47.4.0' },
      loader: { family: 'forge', argsFile: 'libraries/arbitrary/win_args.txt' },
      artifacts: [baseArtifact('libraries/arbitrary/win_args.txt')]
    },
    {
      valid: true,
      runtime: { ...runtime, loaderFamily: 'neoforge', loaderVersion: '21.1.172' },
      loader: {
        family: 'neoforge',
        argsFile: 'libraries/net/neoforged/neoforge/21.1.172/win_args.txt',
        universalJar: 'libraries/net/neoforged/neoforge/21.1.172/neoforge-21.1.172-universal.jar'
      },
      artifacts: [
        baseArtifact('libraries/net/neoforged/neoforge/21.1.172/win_args.txt'),
        baseArtifact('server.jar'),
        baseArtifact('user_jvm_args.txt')
      ]
    },
    {
      valid: true,
      runtime: { ...runtime, loaderFamily: 'quilt', loaderVersion: '0.28.1' },
      loader: {
        family: 'quilt',
        launcherJar: 'quilt-server-launch.jar',
        properties: 'quilt-server-launcher.properties',
        libraries: [{
          coordinate: 'org.quiltmc:quilt-loader:0.28.1',
          repository: 'https://maven.quiltmc.org/repository/release/',
          relativePath: 'libraries/org/quiltmc/quilt-loader/0.28.1/quilt-loader-0.28.1.jar'
        }]
      },
      artifacts: [
        baseArtifact('quilt-server-launch.jar'),
        baseArtifact('quilt-server-launcher.properties'),
        baseArtifact('server.jar')
      ]
    }
  ];

  for (const result of invalidResults) {
    assert.throws(
      () => protocol.createManagedRuntimeResponse({
        token,
        requestId,
        operation: protocol.MANAGED_RUNTIME_VERIFY_OPERATION,
        ok: true,
        result
      }),
      protocolFailure
    );
  }
});
