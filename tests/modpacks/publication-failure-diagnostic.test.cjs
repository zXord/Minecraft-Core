const assert = require('node:assert/strict');
const test = require('node:test');

const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
const {
  candidateBootFailureDiagnosticFromError,
  failureDiagnosticFromError,
  filesystemFailureDiagnosticFromError,
  normalizeFailureDiagnostic,
  normalizePublicationFailureDiagnostic,
  publicationFailureDiagnosticFromError
} = require('../../electron/services/modpack-lifecycle/publication-failure-diagnostic.cjs');

const DURABLE_FAILURE_KINDS = [
  'sharing-violation',
  'access-denied',
  'timeout',
  'integrity-failure',
  'io-failure',
  'worker-failure'
];

test('publication failure diagnostics expose every durable failure kind through one closed shape', () => {
  for (const category of DURABLE_FAILURE_KINDS) {
    const error = new ModpackError('COMMIT_FAILED', 'The server could not be published', {
      cause: new Error('C:\\private\\candidate must never be exposed')
    });
    Object.defineProperty(error, 'durableFailureKind', { value: category });
    Object.defineProperty(error, 'commitPhase', { value: 'post-publication-uncertain' });

    const diagnostic = publicationFailureDiagnosticFromError(error);

    assert.deepEqual(diagnostic, { stage: 'durable-move', category });
    assert.equal(Object.isFrozen(diagnostic), true);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private|candidate|errno|stack/i);
  }
});

test('publication failure diagnostics use only closed commit phases and a closed fallback', () => {
  for (const category of ['pre-publication', 'post-publication', 'post-publication-uncertain']) {
    const error = new ModpackError('COMMIT_FAILED', 'The server could not be published');
    Object.defineProperty(error, 'commitPhase', { value: category });
    assert.deepEqual(publicationFailureDiagnosticFromError(error), {
      stage: 'durable-move', category
    });
  }
  assert.deepEqual(publicationFailureDiagnosticFromError(new Error('C:\\private\\server')), {
    stage: 'durable-move', category: 'publication-failed'
  });
});

test('publication failure diagnostic normalization rejects malformed data without invoking accessors', () => {
  let reads = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'stage', {
    enumerable: true,
    get() { reads += 1; return 'durable-move'; }
  });
  Object.defineProperty(accessor, 'category', { enumerable: true, value: 'sharing-violation' });

  for (const value of [
    accessor,
    { stage: 'durable-move', category: 'C:\\private\\server' },
    { stage: 'filesystem-operation', category: 'pre-publication' },
    { stage: 'other-stage', category: 'sharing-violation' },
    { stage: 'durable-move', category: 'sharing-violation', cause: 'private' },
    Object.assign(Object.create(null), { stage: 'durable-move', category: 'sharing-violation' }),
    ['durable-move', 'sharing-violation']
  ]) {
    assert.equal(normalizePublicationFailureDiagnostic(value), null);
  }
  assert.equal(reads, 0);

  const normalized = normalizePublicationFailureDiagnostic({
    stage: 'durable-move', category: 'sharing-violation'
  });
  assert.deepEqual(normalized, { stage: 'durable-move', category: 'sharing-violation' });
  assert.equal(Object.isFrozen(normalized), true);

  assert.equal(normalizePublicationFailureDiagnostic({
    stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
  }), null);
});

test('nested safe error metadata is found without copying a raw cause', () => {
  const inner = new ModpackError('COMMIT_FAILED', 'The durable move failed', {
    cause: new Error('C:\\private\\candidate access denied with errno 5')
  });
  Object.defineProperty(inner, 'durableFailureKind', { value: 'access-denied' });
  const outer = new ModpackError('RECOVERY_REQUIRED', 'Reviewed recovery is required', { cause: inner });

  assert.deepEqual(publicationFailureDiagnosticFromError(outer), {
    stage: 'durable-move', category: 'access-denied'
  });
});

test('generic filesystem diagnostics retain only closed durable kind and boundary metadata', () => {
  // This fails if a generic failed job loses its actionable safe boundary or serializes a path/message/provider.
  const error = new ModpackError('COMMIT_FAILED', 'The filesystem operation could not continue', {
    cause: new Error('C:\\private\\provider-name\\archive.zip raw native exception text')
  });
  Object.defineProperty(error, 'durableFailureKind', { value: 'integrity-failure' });
  Object.defineProperty(error, 'durableFailureStage', { value: 'destination-parent-open' });

  const diagnostic = filesystemFailureDiagnosticFromError(error);

  assert.deepEqual(diagnostic, {
    stage: 'filesystem-operation', category: 'integrity-failure', boundary: 'destination-parent-open'
  });
  assert.equal(Object.isFrozen(diagnostic), true);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|provider|archive|native|exception/i);
  assert.equal(filesystemFailureDiagnosticFromError(new Error('C:\\private\\provider-name')), null);
});

test('closed filesystem evidence wins when an error also carries candidate boot metadata', () => {
  const error = new ModpackError('HEALTH_CHECK_FAILED', 'Server health validation failed');
  Object.defineProperty(error, 'durableFailureKind', { value: 'sharing-violation' });
  Object.defineProperty(error, 'durableFailureStage', { value: 'destination-parent-open' });
  Object.defineProperty(error, 'candidateBootDiagnostic', {
    enumerable: false,
    value: Object.freeze({
      stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
    })
  });

  assert.deepEqual(failureDiagnosticFromError(error), {
    stage: 'filesystem-operation', category: 'sharing-violation', boundary: 'destination-parent-open'
  });
});

test('candidate boot diagnostics normalize a closed stage, boundary, and category only', () => {
  const error = new ModpackError('HEALTH_CHECK_FAILED', 'Server health validation failed', {
    cause: new Error('C:\\private\\server raw process output')
  });
  Object.defineProperty(error, 'candidateBootDiagnostic', {
    enumerable: false,
    value: Object.freeze({
      stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
    })
  });

  assert.deepEqual(candidateBootFailureDiagnosticFromError(error), {
    stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
  });
  assert.deepEqual(failureDiagnosticFromError(error), {
    stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
  });
  assert.equal(Object.isFrozen(candidateBootFailureDiagnosticFromError(error)), true);
  assert.doesNotMatch(JSON.stringify(candidateBootFailureDiagnosticFromError(error)), /private|server|process/i);
});

test('candidate boot diagnostic normalization rejects malformed values without invoking accessors', () => {
  let reads = 0;
  const accessor = { stage: 'candidate-boot', boundary: 'readiness' };
  Object.defineProperty(accessor, 'category', {
    enumerable: true,
    get() { reads += 1; return 'mod-loading-failure'; }
  });

  for (const value of [
    accessor,
    { stage: 'candidate-boot', boundary: 'readiness', category: 'C:\\private\\server' },
    { stage: 'candidate-boot', boundary: 'unknown', category: 'health-failure' },
    { stage: 'other-stage', boundary: 'readiness', category: 'health-failure' },
    { stage: 'candidate-boot', boundary: 'readiness', category: 'health-failure', message: 'raw' },
    Object.assign(Object.create(null), {
      stage: 'candidate-boot', boundary: 'readiness', category: 'health-failure'
    }),
    ['candidate-boot', 'readiness', 'health-failure']
  ]) {
    assert.equal(normalizeFailureDiagnostic(value), null);
    assert.equal(normalizePublicationFailureDiagnostic(value), null);
  }
  assert.equal(reads, 0);

  const normalized = normalizeFailureDiagnostic({
    stage: 'candidate-boot', boundary: 'readiness', category: 'health-failure'
  });
  assert.deepEqual(normalized, {
    stage: 'candidate-boot', boundary: 'readiness', category: 'health-failure'
  });
  assert.equal(Object.isFrozen(normalized), true);
});
