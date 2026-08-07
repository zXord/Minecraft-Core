const assert = require('node:assert/strict');
const test = require('node:test');

const { createArtifactSetPlan, finalizeVerifiedArtifactSet } = require('../../electron/services/modpacks/contracts.cjs');
const { VerifiedArtifactAcquisition } = require('../../electron/services/modpacks/artifacts/verified-artifact-acquisition.cjs');

function verified() {
  const plan = createArtifactSetPlan({
    provider: 'local',
    artifactSet: {
      kind: 'single', primaryPartId: 'part-one', groupingScheme: 'single', providerImmutable: false,
      attestationStatus: 'unavailable', parts: [{ partId: 'part-one', fileName: 'pack.zip', size: '3' }]
    }
  });
  return finalizeVerifiedArtifactSet(plan, [{
    partId: 'part-one', measuredSize: '3', sha256: 'a'.repeat(64), sha512: 'b'.repeat(128)
  }]);
}

test('app-issued local verified sets bypass the remote downloader without weakening validation', async () => {
  let calls = 0;
  const acquisition = new VerifiedArtifactAcquisition({ artifactDownloader: { async downloadSet() { calls += 1; } } });
  const exact = verified();
  assert.equal(await acquisition.downloadSet(exact), exact);
  assert.equal(calls, 0);
  await assert.rejects(acquisition.downloadSet(structuredClone(exact)), error => error.code === 'INVALID_REQUEST');
  assert.equal(calls, 0);
});

test('provider plans remain delegated to the streaming artifact downloader', async () => {
  const expected = verified();
  const plan = { type: 'artifact-set-plan' };
  const acquisition = new VerifiedArtifactAcquisition({
    artifactDownloader: { async downloadSet(value, options) { assert.equal(value, plan); assert.deepEqual(options, { signal: null }); return expected; } }
  });
  assert.equal(await acquisition.downloadSet(plan, { signal: null }), expected);
});
