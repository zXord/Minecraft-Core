const assert = require('node:assert/strict');
const test = require('node:test');

const { groupMultipartCandidates } = require('../../electron/services/modpacks/artifacts/multipart-names.cjs');

function remote(assetId, fileName, releaseId = 'release-1') {
  return { assetId, fileName, size: '10', releaseId };
}

test('groups a single archive as a provisional single choice', () => {
  const [choice] = groupMultipartCandidates([remote('a1', 'server.zip')]);
  assert.deepEqual(choice.parts.map((part) => part.fileName), ['server.zip']);
  assert.equal(choice.type, 'provisional-group');
  assert.equal(choice.kind, 'single');
  assert.equal(choice.disabled, false);
  assert.equal(choice.tailCompleteness, 'unknown');
});

test('groups part-number volumes in deterministic numeric order', () => {
  const [choice] = groupMultipartCandidates([
    remote('a2', 'server.part2.rar'), remote('a1', 'server.part1.rar'), remote('a3', 'server.part3.rar')
  ]);
  assert.equal(choice.groupingScheme, 'part-number');
  assert.equal(choice.primaryPartId, 'a1');
  assert.deepEqual(choice.parts.map((part) => part.fileName), ['server.part1.rar', 'server.part2.rar', 'server.part3.rar']);
  assert.equal(choice.disabled, false);
  assert.equal(choice.tailCompleteness, 'unknown');
});

test('normalizes zero-padded part numbers while preserving original basenames', () => {
  const [choice] = groupMultipartCandidates([remote('a2', 'server.part02.rar'), remote('a1', 'server.part01.rar')]);
  assert.deepEqual(choice.parts.map((part) => part.fileName), ['server.part01.rar', 'server.part02.rar']);
  assert.equal(choice.primaryPartId, 'a1');
});

test('groups .rar and .r00 volumes with the rar file as primary', () => {
  const [choice] = groupMultipartCandidates([remote('a2', 'server.r00'), remote('a1', 'server.rar'), remote('a3', 'server.r01')]);
  assert.equal(choice.groupingScheme, 'rar-rxx');
  assert.deepEqual(choice.parts.map((part) => part.fileName), ['server.rar', 'server.r00', 'server.r01']);
});

test('groups numeric volumes and disables known missing middle and tail gaps', () => {
  const [middle] = groupMultipartCandidates([remote('a1', 'server.001'), remote('a3', 'server.003')]);
  assert.equal(middle.disabled, true);
  assert.deepEqual(middle.missingVolumes, [2]);

  const [tail] = groupMultipartCandidates([remote('a2', 'server.part2.rar'), remote('a3', 'server.part3.rar')]);
  assert.equal(tail.disabled, true);
  assert.deepEqual(tail.missingVolumes, [1]);
});

test('disables duplicate numbers and Windows case or Unicode aliases', () => {
  const [numberDuplicate] = groupMultipartCandidates([remote('a1', 'server.part1.rar'), remote('a2', 'server.part01.rar')]);
  assert.equal(numberDuplicate.disabled, true);
  assert.equal(numberDuplicate.disabledReason, 'duplicate-volume');

  const [aliasDuplicate] = groupMultipartCandidates([
    remote('a1', 'caf\u00e9.part1.rar'), remote('a2', 'cafe\u0301.part01.rar')
  ]);
  assert.equal(aliasDuplicate.disabled, true);
  assert.equal(aliasDuplicate.disabledReason, 'duplicate-volume');
});

test('ignores recovery volumes and does not merge unrelated siblings', () => {
  const choices = groupMultipartCandidates([
    remote('a1', 'alpha.part1.rar'), remote('a2', 'beta.part1.rar'), remote('a3', 'alpha.rev')
  ]);
  assert.deepEqual(choices.map((choice) => choice.parts[0].fileName), ['alpha.part1.rar', 'beta.part1.rar']);
  assert.equal(choices.some((choice) => choice.parts.some((part) => part.fileName.endsWith('.rev'))), false);
});

test('rejects groups that mix provider releases or local selections', () => {
  assert.throws(
    () => groupMultipartCandidates([remote('a1', 'server.part1.rar', 'release-1'), remote('a2', 'server.part2.rar', 'release-2')]),
    error => error.code === 'INVALID_REQUEST'
  );
  assert.throws(
    () => groupMultipartCandidates([
      { assetId: 'l1', fileName: 'server.part1.rar', size: '1', selectionId: 'selection-a' },
      { assetId: 'l2', fileName: 'server.part2.rar', size: '1', selectionId: 'selection-b' }
    ]),
    error => error.code === 'INVALID_REQUEST'
  );
});
