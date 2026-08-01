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

test('retries partial file-handle writes and verifies the persisted target bytes before publish', async (t) => {
  const shortWriteFs = { ...fs, open: async (target, flags, ...rest) => {
    const handle = await fs.open(target, flags, ...rest);
    if (flags !== 'wx') return handle;
    return {
      read: handle.read.bind(handle), close: handle.close.bind(handle), sync: handle.sync.bind(handle),
      write: async (buffer, offset = 0, length = buffer.length - offset, position = null) => handle.write(buffer, offset, Math.min(length, 3), position)
    };
  } };
  const f = await fixture({ fsApi: shortWriteFs }); t.after(f.cleanup);
  const content = Buffer.from('short write regression'.repeat(100)); const sha256 = digest(content);
  await f.cache.commitPart({ partialPath: await partial(f.root, 'short-write.part', content), sha256, measuredSize: String(content.length) });
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

test('refuses symlinked partials and cache entries where file symlinks are supported', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-external-')); t.after(() => fs.rm(external, { recursive: true, force: true }));
  const content = Buffer.from('outside bytes'); const sha256 = digest(content);
  const outsidePartial = path.join(external, 'outside.part'); await fs.writeFile(outsidePartial, content);
  const linkedPartial = path.join(f.root, 'partials', 'linked.part'); await fs.mkdir(path.dirname(linkedPartial), { recursive: true });
  try { await fs.symlink(outsidePartial, linkedPartial, 'file'); } catch (error) { if (error.code === 'EPERM') { t.skip('file symlinks require Windows privilege'); return; } throw error; }
  await assert.rejects(f.cache.commitPart({ partialPath: linkedPartial, sha256, measuredSize: String(content.length) }), error => error.code === 'INVALID_REQUEST');
  const realPartial = await partial(f.root, 'real.part', content); await f.cache.commitPart({ partialPath: realPartial, sha256, measuredSize: String(content.length) });
  const entry = f.cache.pathForSha256(sha256); await fs.rm(entry); const outsideEntry = path.join(external, 'entry'); await fs.writeFile(outsideEntry, content); await fs.symlink(outsideEntry, entry, 'file');
  assert.equal(await f.cache.verifyEntry({ sha256, size: String(content.length) }), false);
});

test('refuses junctioned cache prefixes and controlled workspace roots', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const content = Buffer.from('outside bytes'); const sha256 = digest(content);
  const prefixRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-prefix-')); t.after(() => fs.rm(prefixRoot, { recursive: true, force: true }));
  const prefixCacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-prefix-cache-')); t.after(() => fs.rm(prefixCacheRoot, { recursive: true, force: true }));
  const prefixWorkspace = path.join(prefixRoot, 'workspaces'); const prefixCache = new ArtifactCache({ root: prefixRoot, workspaceRoot: prefixWorkspace }); await fs.symlink(prefixCacheRoot, path.join(prefixRoot, 'sha256'), 'junction');
  await assert.rejects(prefixCache.commitPart({ partialPath: await partial(prefixRoot, 'prefix.part', content), sha256, measuredSize: String(content.length) }), error => error.code === 'INVALID_REQUEST');
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-external-workspace-')); t.after(() => fs.rm(external, { recursive: true, force: true }));
  const linkedWorkspace = path.join(f.root, 'workspace-link'); await fs.symlink(external, linkedWorkspace, 'junction');
  const workspaceCache = new ArtifactCache({ root: f.root, workspaceRoot: linkedWorkspace });
  await assert.rejects(workspaceCache.materializeSet(verifiedSet([verifiedPart('p', 'server.zip', content)]), path.join(linkedWorkspace, 'input')), error => error.code === 'INVALID_REQUEST');
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
  assert.equal(await f.cache.removeIfUnreferenced(sha256), false);
});

test('returns false when an unreferenced cache entry was never created', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  assert.equal(await f.cache.removeIfUnreferenced('a'.repeat(64)), false);
});
