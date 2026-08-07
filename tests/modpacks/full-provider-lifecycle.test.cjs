const assert = require('node:assert/strict');
const test = require('node:test');

let harness = {};
try {
  harness = require('./fixtures/lifecycle-harness.cjs');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error.message).includes('lifecycle-harness.cjs')) throw error;
}

async function lifecycleFixture(t) {
  assert.equal(typeof harness.createLifecycleHarness, 'function', 'full provider lifecycle harness is required');
  const fixture = await harness.createLifecycleHarness();
  t.after(() => fixture.cleanup());
  return fixture;
}

test('Modrinth, GitHub, and local sources complete inspection, planning, lifecycle, and managed publication offline', async (t) => {
  const fixture = await lifecycleFixture(t);
  const expected = {
    modrinth: { archiveFamily: 'mrpack', classificationKind: 'mrpack-server', loaderFamily: 'fabric' },
    github: { archiveFamily: 'zip', classificationKind: 'prepared-server-pack', loaderFamily: 'vanilla' },
    local: { archiveFamily: 'zip', classificationKind: 'prepared-server-pack', loaderFamily: 'vanilla' }
  };

  for (const provider of Object.keys(expected)) {
    const result = await fixture.runProviderLifecycle(provider);
    assert.equal(result.provider, provider);
    assert.equal(result.archiveFamily, expected[provider].archiveFamily);
    assert.equal(result.classificationKind, expected[provider].classificationKind);
    assert.equal(result.runtime.loaderFamily, expected[provider].loaderFamily);
    assert.equal(result.job.phase, 'completed');
    assert.equal(result.job.outcome.status, 'completed');
    assert.equal(result.managedState.modpackManaged, true);
    assert.equal(result.managedState.source.provider, provider);
    assert.equal(result.canonicalSnapshot['server.jar'].type, 'file');
    assert.equal(result.canonicalSnapshot['world/level.dat'].type, 'file');
  }

  assert.equal(fixture.network.ambientRequests, 0);
  assert.ok(fixture.network.dnsCalls.length > 0);
  assert.ok(fixture.runtime.calls.some(call => call.type === 'loader' && call.loaderFamily === 'fabric'));
  assert.ok(fixture.runtime.calls.some(call => call.type === 'java'));
  assert.ok(fixture.runtime.calls.some(call => call.type === 'status' && call.healthy === true));
});
test('GitHub missing-digest review, trusted source mapping, and reviewed asset pattern remain explicit', async (t) => {
  const fixture = await lifecycleFixture(t);
  const evidence = await fixture.reviewGithubEvidence();
  assert.deepEqual(evidence.warnings, [{ code: 'MISSING_PROVIDER_DIGEST', partId: 'asset-301' }]);
  assert.deepEqual(evidence.mapping, {
    type: 'provider-source-mapping', version: 1,
    modrinthProjectId: 'project-fixture', githubRepositoryId: '101',
    githubOwner: 'FixtureOrg', githubRepo: 'FixturePack'
  });
  assert.deepEqual(evidence.patternMatch, { type: 'HIGH_CONFIDENCE', selectedAssetIds: ['301'] });
});

test('republished multipart GitHub bytes fail digest verification without partial or canonical publication', async (t) => {
  const fixture = await lifecycleFixture(t);
  const outcome = await fixture.exerciseMutatedMultipart();
  assert.equal(outcome.errorCode, 'HASH_MISMATCH');
  assert.equal(outcome.canonicalPublished, false);
  assert.deepEqual(outcome.partialFiles, []);
  assert.ok(outcome.retainedCacheParts >= 1, 'already verified immutable parts remain reusable');
});

test('generated ZIP and MRPACK plus reviewed RAR fixtures classify without installed archive tools', async (t) => {
  const fixture = await lifecycleFixture(t);
  assert.deepEqual(await fixture.classifyReviewedArchives(), {
    zip: 'zip',
    mrpack: 'mrpack',
    rar4: 'rar4',
    rar5: 'rar5',
    multipartRar4: 'multipart-rar',
    multipartRar5: 'multipart-rar'
  });
  assert.equal(fixture.runtime.ambientArchiveProcesses, 0);
});

test('fixed clock, IDs, services, and archive bytes produce identical managed byte trees', async (t) => {
  const left = await lifecycleFixture(t);
  const right = await lifecycleFixture(t);
  const leftResult = await left.runProviderLifecycle('modrinth');
  const rightResult = await right.runProviderLifecycle('modrinth');
  assert.deepEqual(leftResult.canonicalSnapshot, rightResult.canonicalSnapshot);
  assert.deepEqual(leftResult.managedState, rightResult.managedState);
  assert.equal(left.clock.now(), right.clock.now());
});
