const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  isAppIssuedForgeCandidateHealthAuthorization,
  issueForgeCandidateHealthAuthorization
} = require('../electron/services/forge-candidate-health-authorization.cjs');

const RUNTIME = Object.freeze({
  minecraftVersion: '1.12.2',
  loaderFamily: 'forge',
  loaderVersion: '14.23.5.2860',
  javaMajor: 8,
  os: 'win32',
  architecture: 'x64'
});

function metadata(overrides = {}) {
  return {
    candidatePath: 'C:\\Minecraft\\.server.minecraft-core.job-one.candidate',
    instanceId: 'server-one',
    jobId: 'job-one',
    operationKind: 'upgrade',
    restorePointId: 'restore-one',
    restorePointSha256: 'a'.repeat(64),
    runtime: RUNTIME,
    serverPath: 'C:\\Minecraft\\server',
    sourceRevision: 7,
    ...overrides
  };
}

test('Forge candidate health authorization is opaque, app-issued, and bound to the exact protected operation', () => {
  const expected = metadata();
  const authorization = issueForgeCandidateHealthAuthorization(expected);
  const healthOperationId = `health-${crypto.createHash('sha256')
    .update(`candidate:${expected.jobId}`)
    .digest('hex')
    .slice(0, 32)}`;

  assert.equal(Object.isFrozen(authorization), true);
  assert.equal(Object.getPrototypeOf(authorization), null);
  assert.deepEqual(Object.keys(authorization), []);
  assert.equal(isAppIssuedForgeCandidateHealthAuthorization(authorization, {
    ...expected,
    healthOperationId
  }), true);
  assert.equal(isAppIssuedForgeCandidateHealthAuthorization({ ...authorization }, expected), false);
  assert.equal(isAppIssuedForgeCandidateHealthAuthorization(Object.create(null), expected), false);
});

test('Forge candidate health authorization fails closed for every mismatched boundary', () => {
  const expected = metadata();
  const authorization = issueForgeCandidateHealthAuthorization(expected);
  const mismatches = [
    { candidatePath: 'C:\\Minecraft\\other-candidate' },
    { serverPath: 'C:\\Minecraft\\other-live' },
    { instanceId: 'server-two' },
    { jobId: 'job-two' },
    { healthOperationId: 'health-wrong' },
    { operationKind: 'downgrade' },
    { restorePointId: 'restore-two' },
    { restorePointSha256: 'b'.repeat(64) },
    { runtime: { ...RUNTIME, loaderVersion: '14.23.5.2859' } },
    { sourceRevision: 8 }
  ];

  for (const mismatch of mismatches) {
    assert.equal(
      isAppIssuedForgeCandidateHealthAuthorization(authorization, mismatch),
      false,
      JSON.stringify(mismatch)
    );
  }
});

test('only protected Forge lifecycle operations can receive a candidate health authorization', () => {
  for (const operationKind of ['install', 'upgrade', 'downgrade', 'switch', 'repair', 'rollback']) {
    assert.doesNotThrow(() => issueForgeCandidateHealthAuthorization(metadata({ operationKind })));
  }
  for (const operationKind of ['detach', 'uninstall', 'import', 'files-only']) {
    assert.throws(
      () => issueForgeCandidateHealthAuthorization(metadata({ operationKind })),
      TypeError
    );
  }
  assert.throws(
    () => issueForgeCandidateHealthAuthorization(metadata({
      runtime: { ...RUNTIME, loaderFamily: 'fabric', loaderVersion: '0.16.14' }
    })),
    TypeError
  );
  assert.throws(
    () => issueForgeCandidateHealthAuthorization(metadata({
      candidatePath: 'C:\\Minecraft\\server'
    })),
    TypeError
  );
});
