const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ArtifactCache } = require('../../electron/services/modpacks/artifacts/artifact-cache.cjs');
const { computeArtifactSetDigest } = require('../../electron/services/modpacks/contracts.cjs');

async function fixture({ fsApi } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-cache-'));
  const workspaceRoot = path.join(root, 'workspaces');
  return { root, workspaceRoot, cache: new ArtifactCache({ root, workspaceRoot, fsApi }), async cleanup() { await fs.rm(root, { recursive: true, force: true }); } };
}

async function partial(root, name, content) {
  const directory = path.join(root, 'partials');
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, name);
  await fs.writeFile(target, content);
  return target;
}

function digest(content, algorithm = 'sha256') { return crypto.createHash(algorithm).update(content).digest('hex'); }
function verifiedPart(partId, fileName, content) {
  return { partId, fileName, size: String(content.length), measuredSize: String(content.length), calculatedDigests: { sha256: digest(content), sha512: digest(content, 'sha512') } };
}
function verifiedSet(parts, primaryPartId = parts[0].partId) {
  return { type: 'verified-artifact-set', artifactSet: { kind: parts.length === 1 ? 'single' : 'multipart', groupingScheme: parts.length === 1 ? 'single' : 'part-number', providerImmutable: false, attestationStatus: 'unverified', primaryPartId, parts, setDigest: computeArtifactSetDigest(parts) } };
}

test('commits verified bytes to the content-addressed SHA-256 path without readFile buffering', async (t) => {
  const noReadFile = { ...fs, readFile: async () => { throw new Error('readFile must not be used for artifacts'); } };
  const f = await fixture({ fsApi: noReadFile }); t.after(f.cleanup);
  const content = Buffer.from('archive bytes'.repeat(1000)); const sha256 = digest(content);
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
  await f.cache.commitPart({ partialPath: await partial(f.root, 'three.part', content), sha256, measuredSize: String(content.length) });
  await fs.writeFile(target, Buffer.alloc(content.length, 0x78));
  assert.equal(await f.cache.verifyEntry({ sha256, size: String(content.length) }), false);
});

test('materializes exact verified parts only into a fresh controlled child and returns primary', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const one = Buffer.from('one'); const two = Buffer.from('two');
  await f.cache.commitPart({ partialPath: await partial(f.root, 'one.part', one), sha256: digest(one), measuredSize: '3' });
  await f.cache.commitPart({ partialPath: await partial(f.root, 'two.part', two), sha256: digest(two), measuredSize: '3' });
  const destination = path.join(f.workspaceRoot, 'workspace');
  const primary = await f.cache.materializeSet(verifiedSet([
    verifiedPart('one', 'server.part1.rar', one), verifiedPart('two', 'server.part2.rar', two)
  ]), destination);
  assert.equal(primary, path.join(destination, 'server.part1.rar'));
  assert.deepEqual((await fs.readdir(destination)).sort(), ['server.part1.rar', 'server.part2.rar']);
  await assert.rejects(f.cache.materializeSet(verifiedSet([verifiedPart('one', 'server.part1.rar', one)]), destination), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(f.cache.materializeSet(verifiedSet([verifiedPart('one', 'server.part1.rar', one)]), path.join(f.root, 'outside')), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(f.cache.materializeSet({ type: 'verified-artifact-set', artifactSet: { primaryPartId: 'one', parts: [{ ...verifiedPart('one', 'CON.rar', one) }], setDigest: 'a'.repeat(64) } }, path.join(f.workspaceRoot, 'unsafe')), error => error.code === 'INVALID_REQUEST');
});

test('rejects reparse workspace components and forged or tampered verified sets', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const content = Buffer.from('tamper'); const part = verifiedPart('part-1', 'server.rar', content);
  await f.cache.commitPart({ partialPath: await partial(f.root, 'tamper.part', content), sha256: part.calculatedDigests.sha256, measuredSize: part.measuredSize });
  await fs.mkdir(f.workspaceRoot, { recursive: true });
  await fs.symlink(os.tmpdir(), path.join(f.workspaceRoot, 'linked'), 'junction');
  await assert.rejects(f.cache.materializeSet(verifiedSet([part]), path.join(f.workspaceRoot, 'linked', 'escape')), error => error.code === 'INVALID_REQUEST');
  await fs.writeFile(f.cache.pathForSha256(part.calculatedDigests.sha256), 'forged');
  await assert.rejects(f.cache.materializeSet(verifiedSet([part]), path.join(f.workspaceRoot, 'tampered')), error => error.code === 'HASH_MISMATCH');
  await assert.rejects(f.cache.materializeSet({ type: 'verified-artifact-set', artifactSet: { primaryPartId: 'part-1', parts: [{ ...part, calculatedDigests: { sha256: part.calculatedDigests.sha256, sha512: 'nope' } }], setDigest: 'a'.repeat(64) } }, path.join(f.workspaceRoot, 'forged')), error => error.code === 'INVALID_REQUEST');
});

test('removes an unreferenced cache entry only after every reference is released', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const content = Buffer.from('remove'); const sha256 = digest(content);
  await f.cache.commitPart({ partialPath: await partial(f.root, 'remove.part', content), sha256, measuredSize: String(content.length) });
  f.cache.retain(sha256); f.cache.retain(sha256);
  assert.equal(await f.cache.removeIfUnreferenced(sha256), false);
  f.cache.release(sha256);
  assert.equal(await f.cache.removeIfUnreferenced(sha256), false);
  f.cache.release(sha256);
  assert.equal(await f.cache.removeIfUnreferenced(sha256), true);
});
