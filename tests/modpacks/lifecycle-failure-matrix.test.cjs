const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

let harness = {};
try {
  harness = require('./fixtures/lifecycle-harness.cjs');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error.message).includes('lifecycle-harness.cjs')) throw error;
}

const EXPECTED_BOUNDARIES = Object.freeze({
  'registry:create': ['preflight', 'none', 'none', 'old'],
  'registry:transition': ['preflight', 'none', 'none', 'old'],
  'registry:corrupt-envelope': ['recovery-required', 'none', 'global', 'old'],
  'download:part-write': ['staging', 'none', 'none', 'old'],
  'download:part-sync': ['staging', 'none', 'none', 'old'],
  'cache:publish': ['staging', 'none', 'none', 'old'],
  'cache:directory-flush': ['staging', 'none', 'none', 'old'],
  'restore:archive-close': ['snapshotting', 'none', 'server', 'old'],
  'restore:metadata-publish': ['snapshotting', 'none', 'server', 'old'],
  'candidate:create': ['staging', 'none', 'server', 'old'],
  'candidate:content-flush': ['staging', 'none', 'server', 'old'],
  'journal:publish': ['staging', 'none', 'server', 'old'],
  'health:candidate': ['validating-candidate', 'none', 'server', 'old'],
  'rename:prepare': ['committing', 'prepared', 'server', 'old'],
  'rename:live-to-rollback': ['committing', 'live-moved', 'server', 'old'],
  'rename:candidate-to-live': ['committing', 'candidate-published', 'server', 'new'],
  'rename:directory-flush': ['committing', 'candidate-published', 'server', 'new'],
  'commit:state': ['committed-healthy', 'candidate-published', 'server', 'new'],
  'commit:event': ['committed-healthy', 'candidate-published', 'server', 'new'],
  'cleanup:rollback': ['cleanup', 'candidate-published', 'server', 'new'],
  'rollback:failed-live-aside': ['rolling-back', 'failed-live-moved', 'server', 'old'],
  'rollback:restore-original': ['rolling-back', 'rollback-restored', 'server', 'old'],
  'reconstruction:restore-point': ['recovery-required', 'reconstructing', 'server', 'old'],
  'registration:instance-store': ['registering', 'candidate-published', 'server', 'new'],
  'registration:context-refresh': ['registering', 'candidate-published', 'server', 'new']
});
const matrix = harness.DURABLE_FAULT_MATRIX ?? [];

function missingRequiredFaultPoints(entries) {
  const represented = new Set(entries.map(entry => entry?.id));
  return Object.keys(EXPECTED_BOUNDARIES).filter(id => !represented.has(id));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('every durable boundary is represented in the fault matrix', () => {
  assert.deepEqual(missingRequiredFaultPoints(matrix), []);
  assert.equal(new Set(matrix.map(entry => entry.id)).size, matrix.length);
  assert.deepEqual(matrix.map(entry => [entry.id, entry.phase, entry.swapStep, entry.block, entry.expectedCanonical]),
    Object.entries(EXPECTED_BOUNDARIES).map(([id, expected]) => [id, ...expected]));
});

test('every injected durable fault recovers one exact canonical tree and restart recovery is idempotent', async (t) => {
  assert.equal(typeof harness.createLifecycleHarness, 'function', 'deterministic lifecycle harness is required');
  const fixture = await harness.createLifecycleHarness();
  t.after(() => fixture.cleanup());
  const oldServerHash = sha256('old-server\n');
  const newServerHash = sha256('new-server\n');
  const worldHash = sha256('world-state\n');

  for (const [id, [phase, swapStep, block, expectedCanonical]] of Object.entries(EXPECTED_BOUNDARIES)) {
    const result = await fixture.runFaultScenario(id);
    assert.deepEqual(result.atCrash, {
      phase,
      swapStep,
      blocks: { start: block, mutation: block },
      canonicalCount: result.atCrash.canonicalCount
    }, `${id} persisted the wrong crash boundary`);
    assert.ok([0, 1].includes(result.atCrash.canonicalCount), `${id} exposed multiple canonical servers`);
    assert.equal(result.firstRecovery.canonicalCount, 1, `${id} did not recover exactly one canonical server`);
    assert.equal(result.firstRecovery.canonicalSnapshot['server.jar'].sha256,
      expectedCanonical === 'new' ? newServerHash : oldServerHash, `${id} recovered the wrong server bytes`);
    assert.equal(result.firstRecovery.canonicalSnapshot['world/level.dat'].sha256, worldHash,
      `${id} changed protected world bytes`);
    assert.deepEqual(result.secondRecovery, result.firstRecovery, `${id} restart recovery was not idempotent`);
    assert.equal(result.cacheRetained, true, `${id} lost verified cache ownership`);
    assert.equal(result.restoreRetained, true, `${id} lost the verified restore point`);
    assert.equal(result.tempEscaped, false, `${id} wrote outside its isolated roots`);
  }
});
