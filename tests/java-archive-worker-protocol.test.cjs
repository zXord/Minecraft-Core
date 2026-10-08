const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let protocol = null;
try {
  protocol = require('../electron/services/java-archive-worker-protocol.cjs');
} catch {
  // The first TDD run intentionally reaches the assertions without the module.
}

const token = 'a'.repeat(64);
const requestId = 'b'.repeat(32);
const rootPath = path.resolve('java-archive-protocol');
const archivePath = path.join(rootPath, 'temp', 'runtime.zip');
const destinationPath = path.join(rootPath, 'java-17');

function protocolFailure(error) {
  return error?.code === 'JAVA_ARCHIVE_WORKER_PROTOCOL';
}

test('Java archive requests authenticate only canonical bounded extraction authority', () => {
  assert.equal(typeof protocol?.createJavaArchiveRequest, 'function');
  const request = protocol.createJavaArchiveRequest({
    token,
    requestId,
    payload: {
      rootPath,
      archivePath,
      destinationPath,
      maxArchiveBytes: 268435456,
      expectedArchiveSize: 123456,
      expectedSha256: '1'.repeat(64)
    }
  });

  assert.equal(JSON.stringify(request).includes(token), false);
  assert.deepEqual(protocol.verifyJavaArchiveRequest(request, token), {
    requestId,
    payload: {
      rootPath,
      archivePath,
      destinationPath,
      maxArchiveBytes: 268435456,
      expectedArchiveSize: 123456,
      expectedSha256: '1'.repeat(64)
    }
  });
  assert.throws(() => protocol.verifyJavaArchiveRequest({
    ...request,
    payload: { ...request.payload, destinationPath: path.resolve('outside', 'java-17') }
  }, token), protocolFailure);
  assert.throws(() => protocol.verifyJavaArchiveRequest({ ...request, extra: true }, token), protocolFailure);
});

test('Java archive responses authenticate a closed success result or closed failure code', () => {
  assert.equal(typeof protocol?.createJavaArchiveResponse, 'function');
  const success = protocol.createJavaArchiveResponse({
    token,
    requestId,
    ok: true,
    result: {
      entryCount: 412,
      expandedBytes: '198765432',
      javaExecutableRelativePath: 'bin/java.exe'
    }
  });
  const failure = protocol.createJavaArchiveResponse({
    token,
    requestId,
    ok: false,
    code: 'JAVA_ARCHIVE_UNSAFE'
  });

  assert.deepEqual(protocol.verifyJavaArchiveResponse(success, token, requestId), {
    ok: true,
    code: null,
    result: {
      entryCount: 412,
      expandedBytes: '198765432',
      javaExecutableRelativePath: 'bin/java.exe'
    }
  });
  assert.deepEqual(protocol.verifyJavaArchiveResponse(failure, token, requestId), {
    ok: false,
    code: 'JAVA_ARCHIVE_UNSAFE',
    result: null
  });
  assert.equal(JSON.stringify(failure).includes(rootPath), false);
  assert.throws(() => protocol.verifyJavaArchiveResponse({
    ...failure,
    diagnostic: archivePath
  }, token, requestId), protocolFailure);
});
