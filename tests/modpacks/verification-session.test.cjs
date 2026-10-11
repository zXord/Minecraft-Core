const assert = require('node:assert/strict');
const test = require('node:test');

const load = () => import('../../src/utils/modpacks/verificationSession.js');
const reference = { serverId: 'server-a', jobId: 'verify-a' };
const sample = { entryName: 'mods/managed.jar', origin: 'pack', role: 'mod', status: 'modified' };
function job() {
  return { type: 'minecraft-core-modpack-job', schemaVersion: 1, sequence: 3,
    ...reference, operationKind: 'verify', phase: 'completed', terminalAt: '2026-08-01T12:00:00.000Z',
    events: [], outcome: { status: 'completed', kind: 'completed', actions: [], result: {
      instanceId: 'server-a', type: 'modpack-verification-result', contentRevision: 3,
      verifiedAt: '2026-08-01T12:00:00.000Z', checkedFiles: '4596', mismatchCount: '1', healthy: false,
      repairAvailable: true, repair: { operationKind: 'repair', mismatchCount: '1' }, mismatches: [{ ...sample }]
    } } };
}

test('references retain frozen isolated identity pairs only and invalid writes do not mutate', async () => {
  const { createVerificationReferences } = await load();
  const refs = createVerificationReferences();
  assert.equal(refs.get(''), null);
  assert.equal(refs.get(), null);
  const first = refs.record('server-a', 'verify-a');
  assert.deepEqual(first, { reference, changed: true });
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.reference));
  assert.equal(refs.get('server-a'), first.reference);
  assert.equal(refs.get('server-b'), null);
  for (const invalid of ['', '../a', 'a/b', 'a'.repeat(129), {}, 7]) {
    assert.throws(() => refs.record(invalid, 'verify-b'), TypeError);
    assert.throws(() => refs.record('server-a', invalid), TypeError);
    if (invalid !== '') assert.throws(() => refs.get(invalid), TypeError);
    assert.equal(refs.get('server-a'), first.reference);
  }
  assert.deepEqual(refs.record('constructor', 'verify-prototype').reference, { serverId: 'constructor', jobId: 'verify-prototype' });
  assert.equal(createVerificationReferences().get('server-a'), null);
});

test('128-pair capacity evicts least recently recorded, not read, preserving same-pair identity', async () => {
  const { createVerificationReferences } = await load();
  const refs = createVerificationReferences();
  for (let index = 0; index < 128; index++) refs.record(`server-${index}`, `verify-${index}`);
  const first = refs.get('server-0');
  assert.equal(refs.record('server-0', 'verify-0').changed, false);
  assert.equal(refs.get('server-0'), first);
  refs.get('server-1');
  refs.record('server-128', 'verify-128');
  assert.equal(refs.get('server-1'), null);
  assert.equal(refs.get('server-0'), first);
  refs.record('server-0', 'verify-other');
  const returned = refs.record('server-0', 'verify-0').reference;
  assert.notEqual(returned, first);
  assert.equal(refs.get('server-127').jobId, 'verify-127');
});

test('projection copies historical decimal evidence while dropping authority and live references', async () => {
  const { projectVerificationAttempt: project } = await load();
  const input = job();
  const projected = project(input, reference);
  assert.deepEqual(projected, { ...reference, status: 'completed', verifiedAt: '2026-08-01T12:00:00.000Z',
    contentRevision: 3, checkedFiles: '4596', mismatchCount: '1', healthy: false,
    mismatches: [sample], shownMismatchCount: '1', omittedMismatchCount: '0', mismatchesTruncated: false });
  assert.ok(Object.isFrozen(projected) && Object.isFrozen(projected.mismatches) && Object.isFrozen(projected.mismatches[0]));
  input.outcome.result.mismatches[0].entryName = 'changed';
  assert.equal(projected.mismatches[0].entryName, 'mods/managed.jar');
  const healthy = job();
  Object.assign(healthy.outcome.result, { mismatchCount: '0', healthy: true, repairAvailable: false, repair: null, mismatches: [] });
  assert.equal(project(healthy, reference).healthy, true);
  const truncated = job();
  Object.assign(truncated.outcome.result, { mismatchCount: '147', repair: { operationKind: 'repair', mismatchCount: '147' },
    shownMismatchCount: '1', omittedMismatchCount: '146', mismatchesTruncated: true });
  assert.equal(project(truncated, reference).omittedMismatchCount, '146');
  Object.assign(truncated.outcome.result, { checkedFiles: '9007199254740991' });
  assert.equal(project(truncated, reference).checkedFiles, '9007199254740991');
});

test('projection records unsuccessful or unfinished attempts without success counts or errors', async () => {
  const { projectVerificationAttempt: project } = await load();
  for (const phase of ['failed', 'cancelled', 'rolled-back', 'recovery-required']) {
    assert.deepEqual(project({ ...job(), phase }, reference), { ...reference, status: phase, terminalAt: '2026-08-01T12:00:00.000Z' });
  }
  assert.deepEqual(project({ ...job(), phase: 'queued' }, reference), { ...reference, status: 'in-progress' });
});

const malformed = {
  'foreign job': value => { value.jobId = 'other'; },
  'foreign server': value => { value.serverId = 'other'; },
  'wrong kind': value => { value.operationKind = 'repair'; },
  'wrong envelope type': value => { value.type = 'other'; },
  'wrong schema': value => { value.schemaVersion = 2; },
  'negative sequence': value => { value.sequence = -1; },
  'unknown phase': value => { value.phase = 'invented'; },
  'wrong outcome': value => { value.outcome.status = 'failed'; },
  'foreign result': value => { value.outcome.result.instanceId = 'other'; },
  'wrong result type': value => { value.outcome.result.type = 'other'; },
  'negative revision': value => { value.outcome.result.contentRevision = -1; },
  'noncanonical date': value => { value.outcome.result.verifiedAt = '2026-08-01'; },
  'invalid date': value => { value.outcome.result.verifiedAt = '2026-02-30T12:00:00.000Z'; },
  'numeric count': value => { value.outcome.result.checkedFiles = 4596; },
  'leading zero count': value => { value.outcome.result.checkedFiles = '04596'; },
  'oversized count': value => { value.outcome.result.checkedFiles = '9'.repeat(10000); },
  'unsafe count': value => { value.outcome.result.checkedFiles = '9007199254740992'; },
  'mismatches exceed checked': value => { value.outcome.result.checkedFiles = '0'; },
  'inconsistent health': value => { value.outcome.result.healthy = true; },
  'repair absent': value => { value.outcome.result.repair = null; },
  'repair count mismatch': value => { value.outcome.result.repair.mismatchCount = '2'; },
  'repair extra authority': value => { value.outcome.result.repair.action = 'start'; },
  'result extra authority': value => { value.outcome.result.planId = 'plan-a'; },
  'missing sample': value => { value.outcome.result.mismatches = []; },
  'too many samples': value => { value.outcome.result.mismatches = Array(65).fill(sample); },
  'sample extra authority': value => { value.outcome.result.mismatches[0].path = 'mods/x'; },
  'sample overlong': value => { value.outcome.result.mismatches[0].role = 'x'.repeat(1025); },
  'absolute sample': value => { value.outcome.result.mismatches[0].entryName = '/private/file'; },
  'traversal sample': value => { value.outcome.result.mismatches[0].entryName = 'mods/../private'; },
  'URL label': value => { value.outcome.result.mismatches[0].origin = 'https://bad.invalid'; },
  'drive label': value => { value.outcome.result.mismatches[0].origin = 'C:\\secret'; },
  'UNC label': value => { value.outcome.result.mismatches[0].origin = '\\\\host\\secret'; },
  'credential label': value => { value.outcome.result.mismatches[0].status = 'Bearer abc'; },
  'password label': value => { value.outcome.result.mismatches[0].status = 'password=abc'; },
  'partial truncation': value => { value.outcome.result.shownMismatchCount = '1'; },
  'false truncation': value => { Object.assign(value.outcome.result, { shownMismatchCount: '1', omittedMismatchCount: '0', mismatchesTruncated: false }); },
  'inconsistent truncation': value => { Object.assign(value.outcome.result, { shownMismatchCount: '1', omittedMismatchCount: '2', mismatchesTruncated: true }); },
  'outcome byte overflow': value => { value.outcome.padding = 'é'.repeat(7000); },
  'symbol key': value => { value[Symbol('hidden')] = true; },
  'nonplain result': value => { Object.setPrototypeOf(value.outcome.result, null); }
};
for (const [name, mutate] of Object.entries(malformed)) test(`projection rejects ${name}`, async () => {
  const { projectVerificationAttempt: project } = await load();
  const input = job(); mutate(input);
  assert.equal(project(input, reference), null);
});

test('inspected records and arrays never invoke accessors or toJSON during validation', async () => {
  const { projectVerificationAttempt: project } = await load();
  let invoked = 0;
  for (const location of ['job', 'outcome', 'result', 'sample', 'array', 'reference']) {
    const input = job(); const expected = { ...reference };
    const target = { job: input, outcome: input.outcome, result: input.outcome.result,
      sample: input.outcome.result.mismatches[0], array: input.outcome.result.mismatches, reference: expected }[location];
    Object.defineProperty(target, 'trap', { enumerable: true, get() { invoked++; return 'bad'; } });
    assert.equal(project(input, expected), null);
  }
  const input = job(); input.outcome.toJSON = () => { invoked++; return {}; };
  assert.equal(project(input, reference), null);
  assert.equal(invoked, 0);
  const largeLog = job(); largeLog.events = [{ message: 'x'.repeat(20000) }];
  assert.equal(project(largeLog, reference).mismatchCount, '1');
});
