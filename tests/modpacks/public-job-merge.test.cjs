const assert = require('node:assert/strict');
const test = require('node:test');

test('public job merge rejects older wrong-job updates and preserves equal-sequence durable enrichment', async () => {
  const { mergePublicJob } = await import('../../src/utils/modpacks/publicJobMerge.js');
  const current = { jobId: 'job-one', sequence: 4, phase: 'staging', cancellationRequested: true,
    progress: { message: 'new' }, outcome: null, events: [{ sequence: 3, message: 'kept' }] };
  assert.equal(mergePublicJob(current, { jobId: 'job-other', sequence: 9 }), current);
  assert.equal(mergePublicJob(current, { ...current, sequence: 2, phase: 'snapshotting', cancellationRequested: false, events: [] }), current);
  const terminal = mergePublicJob(current, { jobId: 'job-one', sequence: 6, phase: 'completed', outcome: { status: 'completed' } });
  const hydrated = mergePublicJob(terminal, { ...terminal, events: [{ sequence: 5, message: 'final log' }] }, { durable: true });
  assert.deepEqual(hydrated.events.map(event => event.message), ['kept', 'final log']);
  const duplicate = mergePublicJob(hydrated, { jobId: 'job-one', sequence: 6, phase: 'completed', outcome: null, events: [], cancellationRequested: false });
  assert.deepEqual(duplicate.outcome, { status: 'completed' });
  assert.equal(duplicate.cancellationRequested, true);
  assert.deepEqual(duplicate.events.map(event => event.message), ['kept', 'final log']);
});
