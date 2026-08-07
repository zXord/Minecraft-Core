const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  SERVER_WRITER_HANDLER_FILES,
  SERVER_WRITER_WRITE_SITE_DIGESTS,
  scanUnaccountedWriteSites,
  scanUnaccountedWriterChannels
} = require('../electron/services/server-writer-inventory.cjs');
const {
  SERVER_WRITER_POLICIES
} = require('../electron/services/server-mutation-policy.cjs');

const repositoryRoot = path.resolve(__dirname, '..');

test('registered filesystem writers are inventoried or explicitly ancillary', () => {
  assert.deepEqual(scanUnaccountedWriteSites({
    repositoryRoot,
    readFile: filePath => fs.readFileSync(filePath, 'utf8'),
    expectedDigests: SERVER_WRITER_WRITE_SITE_DIGESTS
  }), []);
});

test('registered mutating channels have a closed policy or reviewed ancillary classification', () => {
  assert.deepEqual(scanUnaccountedWriterChannels({
    repositoryRoot,
    readFile: filePath => fs.readFileSync(filePath, 'utf8'),
    handlerFiles: SERVER_WRITER_HANDLER_FILES,
    policies: SERVER_WRITER_POLICIES
  }), []);
});

test('the inventory scanner reports a newly introduced write site', () => {
  const result = scanUnaccountedWriteSites({
    repositoryRoot,
    expectedDigests: { 'fixture.cjs': 'reviewed' },
    readFile: () => "async function mutate() { await fs.writeFile('new.txt', 'x'); }"
  });
  assert.deepEqual(result, ['fixture.cjs']);
});

test('the channel scanner reports an unclassified mutating registration', () => {
  const result = scanUnaccountedWriterChannels({
    repositoryRoot,
    handlerFiles: ['fixture.cjs'],
    policies: {},
    readFile: () => "function createHandlers() { return { 'new-writer': async () => fs.writeFile('x', 'y') }; }"
  });
  assert.deepEqual(result, ['new-writer']);
});
