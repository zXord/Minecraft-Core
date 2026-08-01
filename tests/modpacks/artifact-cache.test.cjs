const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ArtifactCache } = require('../../electron/services/modpacks/artifacts/artifact-cache.cjs');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-cache-'));
  return { root, cache: new ArtifactCache({ root }), async cleanup() { await fs.rm(root, { recursive: true, force: true }); } };
}

async function partial(root, name, content) {
  const directory = path.join(root, 'partials');
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, name);
  await fs.writeFile(target, content);
  return target;
}

function digest(content) { return crypto.createHash('sha256').update(content).digest('hex'); }

test('commits verified bytes to the content-addressed SHA-256 path', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const content = Buffer.from('archive bytes'); const sha256 = digest(content);
  const committed = await f.cache.commitPart({ partialPath: await partial(f.root, 'one.part', content), sha256, measuredSize: String(content.length) });
  assert.equal(committed, path.join(f.root, 'sha256', sha256.slice(0, 2), sha256));
  assert.equal(await f.cache.verifyEntry({ sha256, size: String(content.length) }), true);
});

test('race commits verify the winner and never accept truncated or same-size wrong-hash cache content', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const content = Buffer.from('same archive'); const sha256 = digest(content);
  await Promise.all([
    f.cache.commitPart({ partialPath: await partial(f.root, 'one.part', content), sha256, measuredSize: String(content.length) }),
    f.cache.commitPart({ partialPath: await partial(f.root, 'two.part', content), sha256, measuredSize: String(content.length) })
  ]);
  const target = f.cache.pathForSha256(sha256);
  await fs.writeFile(target, 'short');
  assert.equal(await f.cache.verifyEntry({ sha256, size: String(content.length) }), false);
  assert.equal(await fs.stat(target).then(() => true, () => false), false);
  await f.cache.commitPart({ partialPath: await partial(f.root, 'three.part', content), sha256, measuredSize: String(content.length) });
  await fs.writeFile(target, Buffer.alloc(content.length, 0x78));
  assert.equal(await f.cache.verifyEntry({ sha256, size: String(content.length) }), false);
});

test('materializes exact verified parts under safe original basenames and returns only primary path', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const one = Buffer.from('one'); const two = Buffer.from('two');
  const shaOne = digest(one); const shaTwo = digest(two);
  await f.cache.commitPart({ partialPath: await partial(f.root, 'one.part', one), sha256: shaOne, measuredSize: '3' });
  await f.cache.commitPart({ partialPath: await partial(f.root, 'two.part', two), sha256: shaTwo, measuredSize: '3' });
  const destination = path.join(f.root, 'workspace');
  await fs.mkdir(destination); await fs.writeFile(path.join(destination, 'unrelated.txt'), 'remove me');
  const primary = await f.cache.materializeSet({
    type: 'verified-artifact-set', artifactSet: { primaryPartId: 'one', parts: [
      { partId: 'one', fileName: 'server.part1.rar', measuredSize: '3', calculatedDigests: { sha256: shaOne } },
      { partId: 'two', fileName: 'server.part2.rar', measuredSize: '3', calculatedDigests: { sha256: shaTwo } }
    ] }
  }, destination);
  assert.equal(primary, path.join(destination, 'server.part1.rar'));
  assert.deepEqual((await fs.readdir(destination)).sort(), ['server.part1.rar', 'server.part2.rar']);
  await assert.rejects(
    f.cache.materializeSet({ type: 'verified-artifact-set', artifactSet: { primaryPartId: 'bad', parts: [{ partId: 'bad', fileName: '../escape.rar', measuredSize: '3', calculatedDigests: { sha256: shaOne } }] } }, path.join(f.root, 'unsafe')),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('removes an unreferenced cache entry', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const content = Buffer.from('remove'); const sha256 = digest(content);
  await f.cache.commitPart({ partialPath: await partial(f.root, 'remove.part', content), sha256, measuredSize: String(content.length) });
  assert.equal(await f.cache.removeIfUnreferenced(sha256), true);
  assert.equal(await f.cache.verifyEntry({ sha256, size: String(content.length) }), false);
});
