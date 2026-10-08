const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ArtifactCache } = require('../../electron/services/modpacks/artifacts/artifact-cache.cjs');
const { computeArtifactSetDigest } = require('../../electron/services/modpacks/contracts.cjs');

async function fixture({ fsApi, durableFsFactory } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-cache-'));
  const workspaceRoot = path.join(root, 'workspaces');
  return {
    root,
    workspaceRoot,
    cache: new ArtifactCache({ root, workspaceRoot, fsApi, durableFsFactory }),
    async cleanup() { await fs.rm(root, { recursive: true, force: true }); }
  };
}

async function partial(root, name, content) {
  const directory = path.join(root, 'partials');
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, name);
  await fs.writeFile(target, content);
  return target;
}

async function seedCacheEntry(cache, content) {
  const sha256 = digest(content);
  const target = cache.pathForSha256(sha256);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return sha256;
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

test('materialization reads each cached archive once while hashing the source copy', async (t) => {
  // This fails if materialization restores a separate eager cache hash before its copy-and-verify pass.
  const content = Buffer.from('single-pass cached archive bytes'.repeat(5_000));
  let trackedEntry = null;
  let cacheBytesRead = 0;
  const measuringFs = {
    ...fs,
    async open(candidate, flags, ...rest) {
      const handle = await fs.open(candidate, flags, ...rest);
      if (flags !== 'r' || path.resolve(candidate) !== trackedEntry) return handle;
      return new Proxy(handle, {
        get(value, key) {
          if (key === 'read') {
            return async (...args) => {
              const result = await value.read(...args);
              cacheBytesRead += result.bytesRead;
              return result;
            };
          }
          const member = Reflect.get(value, key, value);
          return typeof member === 'function' ? member.bind(value) : member;
        }
      });
    }
  };
  const f = await fixture({ fsApi: measuringFs }); t.after(f.cleanup);
  const part = verifiedPart('server-pack', 'server-pack.zip', content);
  trackedEntry = path.resolve(f.cache.pathForSha256(part.calculatedDigests.sha256));
  await fs.mkdir(path.dirname(trackedEntry), { recursive: true });
  await fs.writeFile(trackedEntry, content);

  const destination = path.join(f.workspaceRoot, 'single-pass-workspace');
  await f.cache.materializeSet(verifiedSet([part]), destination);

  assert.equal(cacheBytesRead, content.length);
  assert.deepEqual(await fs.readFile(path.join(destination, part.fileName)), content);
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

test('prunes only old unreferenced artifacts and preserves active and explicitly retained bytes', async (t) => {
  // This fails if pruning ignores either the runtime reference or the persisted outcome retention hold.
  const now = Date.parse('2026-08-31T12:00:00.000Z');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-cache-retention-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = new ArtifactCache({ root, workspaceRoot: path.join(root, 'workspaces'), clock: () => now });
  const old = Buffer.from('old artifact');
  const active = Buffer.from('active artifact');
  const retained = Buffer.from('retained artifact');
  for (const [name, content] of [['old', old], ['active', active], ['retained', retained]]) {
    await cache.commitPart({ partialPath: await partial(root, `${name}.part`, content), sha256: digest(content), measuredSize: String(content.length) });
    await fs.utimes(cache.pathForSha256(digest(content)), new Date(now - (8 * 24 * 60 * 60 * 1000)), new Date(now - (8 * 24 * 60 * 60 * 1000)));
  }
  cache.retain(digest(active));
  await cache.retainForOutcome({ ownerId: 'job-retained', sha256s: [digest(retained)] });

  const result = await cache.prune();

  assert.deepEqual(result, { removed: 1, reclaimedBytes: old.length });
  await assert.rejects(fs.lstat(cache.pathForSha256(digest(old))), error => error.code === 'ENOENT');
  await fs.lstat(cache.pathForSha256(digest(active)));
  await fs.lstat(cache.pathForSha256(digest(retained)));
});

test('enforces a byte cap by deleting oldest eligible entries while persisted outcome retention survives restart', async (t) => {
  // This fails if cap eviction includes protected entries, chooses newest first, or forgets retention after restart.
  const now = Date.parse('2026-08-31T12:00:00.000Z');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-cache-cap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspaces');
  const cache = new ArtifactCache({ root, workspaceRoot, clock: () => now });
  const oldest = Buffer.from('1111');
  const newest = Buffer.from('22222');
  const retained = Buffer.from('333333');
  for (const [index, content] of [oldest, newest, retained].entries()) {
    await cache.commitPart({ partialPath: await partial(root, `cap-${index}.part`, content), sha256: digest(content), measuredSize: String(content.length) });
    await fs.utimes(cache.pathForSha256(digest(content)), new Date(now - ((3 - index) * 1000)), new Date(now - ((3 - index) * 1000)));
  }
  await cache.retainForOutcome({ ownerId: 'job-cap', sha256s: [digest(retained)] });

  const restarted = new ArtifactCache({ root, workspaceRoot, clock: () => now });
  const result = await restarted.prune({ maxBytes: newest.length + retained.length });

  assert.deepEqual(result, { removed: 1, reclaimedBytes: oldest.length });
  await assert.rejects(fs.lstat(restarted.pathForSha256(digest(oldest))), error => error.code === 'ENOENT');
  await fs.lstat(restarted.pathForSha256(digest(newest)));
  await fs.lstat(restarted.pathForSha256(digest(retained)));
  assert.equal(await restarted.removeIfUnreferenced(digest(retained)), false);
});

test('prune preserves an artifact referenced after eligibility was calculated but before unlink', { timeout: 5_000 }, async (t) => {
  // This fails if prune relies on its initial reference snapshot instead of revalidating at unlink.
  const now = Date.parse('2026-08-31T12:00:00.000Z');
  const content = Buffer.from('concurrently referenced artifact');
  const sha256 = digest(content);
  let target = null;
  let armed = false;
  let targetLstatCalls = 0;
  let releaseDeleteCheck;
  let reachedDeleteCheck;
  const deleteCheckReached = new Promise(resolve => { reachedDeleteCheck = resolve; });
  const deleteCheckRelease = new Promise(resolve => { releaseDeleteCheck = resolve; });
  t.after(() => releaseDeleteCheck());
  const fsApi = {
    ...fs,
    async lstat(candidate, ...args) {
      if (armed && path.resolve(candidate) === target) {
        targetLstatCalls += 1;
        if (targetLstatCalls === 3) {
          reachedDeleteCheck();
          await deleteCheckRelease;
        }
      }
      return fs.lstat(candidate, ...args);
    }
  };
  const f = await fixture({ fsApi }); t.after(f.cleanup);
  f.cache.clock = () => now;
  await f.cache.commitPart({
    partialPath: await partial(f.root, 'concurrent-reference.part', content),
    sha256,
    measuredSize: String(content.length)
  });
  target = f.cache.pathForSha256(sha256);
  await fs.utimes(target, new Date(now - (8 * 24 * 60 * 60 * 1000)), new Date(now - (8 * 24 * 60 * 60 * 1000)));
  armed = true;

  const pruning = f.cache.prune();
  await deleteCheckReached;
  f.cache.retain(sha256);
  releaseDeleteCheck();

  assert.deepEqual(await pruning, { removed: 0, reclaimedBytes: 0 });
  await fs.lstat(target);
});

test('prune preserves an artifact retained after eligibility was calculated but before unlink', { timeout: 5_000 }, async (t) => {
  // This fails if prune does not serialize its final retention check with retention publication.
  const now = Date.parse('2026-08-31T12:00:00.000Z');
  const content = Buffer.from('concurrently retained artifact');
  const sha256 = digest(content);
  let target = null;
  let armed = false;
  let targetLstatCalls = 0;
  let releaseDeleteCheck;
  let reachedDeleteCheck;
  const deleteCheckReached = new Promise(resolve => { reachedDeleteCheck = resolve; });
  const deleteCheckRelease = new Promise(resolve => { releaseDeleteCheck = resolve; });
  t.after(() => releaseDeleteCheck());
  const fsApi = {
    ...fs,
    async lstat(candidate, ...args) {
      if (armed && path.resolve(candidate) === target) {
        targetLstatCalls += 1;
        if (targetLstatCalls === 3) {
          reachedDeleteCheck();
          await deleteCheckRelease;
        }
      }
      return fs.lstat(candidate, ...args);
    }
  };
  const f = await fixture({ fsApi }); t.after(f.cleanup);
  f.cache.clock = () => now;
  await f.cache.commitPart({
    partialPath: await partial(f.root, 'concurrent-retention.part', content),
    sha256,
    measuredSize: String(content.length)
  });
  target = f.cache.pathForSha256(sha256);
  await fs.utimes(target, new Date(now - (8 * 24 * 60 * 60 * 1000)), new Date(now - (8 * 24 * 60 * 60 * 1000)));
  armed = true;

  const pruning = f.cache.prune();
  await deleteCheckReached;
  await f.cache.retainForOutcome({ ownerId: 'job-concurrent-retention', sha256s: [sha256] });
  releaseDeleteCheck();

  assert.deepEqual(await pruning, { removed: 0, reclaimedBytes: 0 });
  await fs.lstat(target);
});

test('retain fails closed while prune has an unlink in flight instead of creating a missing reference', { timeout: 5_000 }, async (t) => {
  // This fails if reference acquisition can report success after prune has linearized deletion.
  const now = Date.parse('2026-08-31T12:00:00.000Z');
  const content = Buffer.from('in-flight unlink reference');
  const sha256 = digest(content);
  let target = null;
  let releaseUnlink;
  let reachedUnlink;
  const unlinkReached = new Promise(resolve => { reachedUnlink = resolve; });
  const unlinkRelease = new Promise(resolve => { releaseUnlink = resolve; });
  t.after(() => releaseUnlink());
  const fsApi = {
    ...fs,
    async unlink(candidate) {
      if (path.resolve(candidate) === target) {
        reachedUnlink();
        await unlinkRelease;
      }
      return fs.unlink(candidate);
    }
  };
  const f = await fixture({ fsApi }); t.after(f.cleanup);
  f.cache.clock = () => now;
  await f.cache.commitPart({
    partialPath: await partial(f.root, 'in-flight-unlink.part', content),
    sha256,
    measuredSize: String(content.length)
  });
  target = f.cache.pathForSha256(sha256);
  await fs.utimes(target, new Date(now - (8 * 24 * 60 * 60 * 1000)), new Date(now - (8 * 24 * 60 * 60 * 1000)));

  const pruning = f.cache.prune();
  await unlinkReached;
  assert.throws(() => f.cache.retain(sha256), error => error?.code === 'PLAN_STALE');
  releaseUnlink();

  assert.deepEqual(await pruning, { removed: 1, reclaimedBytes: content.length });
  await assert.rejects(fs.lstat(target), error => error.code === 'ENOENT');
});

test('retain refuses a digest whose cache entry was already removed', async (t) => {
  // This fails if a later consumer can create a reference that points to no cache bytes.
  const f = await fixture(); t.after(f.cleanup);
  assert.throws(() => f.cache.retain('c'.repeat(64)), error => error?.code === 'PLAN_STALE');
});

test('outcome retention fails closed when prune has already linearized deletion', { timeout: 5_000 }, async (t) => {
  // This fails if a queued durable hold can be published for bytes removed by the prune holding its lock.
  const now = Date.parse('2026-08-31T12:00:00.000Z');
  const content = Buffer.from('in-flight unlink outcome retention');
  const sha256 = digest(content);
  let target = null;
  let releaseUnlink;
  let reachedUnlink;
  const unlinkReached = new Promise(resolve => { reachedUnlink = resolve; });
  const unlinkRelease = new Promise(resolve => { releaseUnlink = resolve; });
  t.after(() => releaseUnlink());
  const fsApi = {
    ...fs,
    async unlink(candidate) {
      if (path.resolve(candidate) === target) {
        reachedUnlink();
        await unlinkRelease;
      }
      return fs.unlink(candidate);
    }
  };
  const f = await fixture({ fsApi }); t.after(f.cleanup);
  f.cache.clock = () => now;
  await f.cache.commitPart({
    partialPath: await partial(f.root, 'in-flight-outcome-retention.part', content),
    sha256,
    measuredSize: String(content.length)
  });
  target = f.cache.pathForSha256(sha256);
  await fs.utimes(target, new Date(now - (8 * 24 * 60 * 60 * 1000)), new Date(now - (8 * 24 * 60 * 60 * 1000)));

  const pruning = f.cache.prune();
  await unlinkReached;
  const retaining = assert.rejects(
    f.cache.retainForOutcome({ ownerId: 'job-in-flight-retention', sha256s: [sha256] }),
    error => error?.code === 'PLAN_STALE'
  );
  releaseUnlink();

  assert.deepEqual(await pruning, { removed: 1, reclaimedBytes: content.length });
  await retaining;
  assert.equal(await f.cache.hasRetainedOutcome({ ownerId: 'job-in-flight-retention', sha256 }), false);
});

test('outcome retention refuses a digest whose cache entry is unavailable', async (t) => {
  // This fails if a manual outcome can publish a durable hold that points to no downloadable bytes.
  const f = await fixture(); t.after(f.cleanup);
  const sha256 = '9'.repeat(64);

  await assert.rejects(
    f.cache.retainForOutcome({ ownerId: 'job-missing-retention', sha256s: [sha256] }),
    error => error?.code === 'PLAN_STALE'
  );
  assert.equal(await f.cache.hasRetainedOutcome({ ownerId: 'job-missing-retention', sha256 }), false);
});

test('artifact publication rejects when the renamed cache file cannot be synced', async (t) => {
  // This fails if a renamed artifact is reported committed before its final-name file barrier.
  const content = Buffer.from('artifact file durability');
  const sha256 = digest(content);
  const syncFailure = Object.assign(new Error('injected artifact target sync failure'), { code: 'EIO' });
  let target = null;
  const fsApi = {
    ...fs,
    async open(candidate, flags, ...args) {
      const handle = await fs.open(candidate, flags, ...args);
      if (flags !== 'r+' || path.resolve(candidate) !== target) return handle;
      return new Proxy(handle, {
        get(value, key) {
          if (key === 'sync') return async () => { throw syncFailure; };
          const member = Reflect.get(value, key, value);
          return typeof member === 'function' ? member.bind(value) : member;
        }
      });
    }
  };
  const f = await fixture({
    fsApi,
    durableFsFactory: () => ({ async flushDirectoriesAsync() {} })
  });
  t.after(f.cleanup);
  target = f.cache.pathForSha256(sha256);

  await assert.rejects(f.cache.commitPart({
    partialPath: await partial(f.root, 'artifact-file-durability.part', content),
    sha256,
    measuredSize: String(content.length)
  }), error => error === syncFailure);
});

test('artifact publication rejects until every containing directory reaches the durable barrier', async (t) => {
  // This fails if publication omits the prefix, sha256, or cache-root directory entry barrier.
  const content = Buffer.from('artifact directory durability');
  const sha256 = digest(content);
  const reachedExpectedBarrier = new Error('expected artifact directory barrier reached');
  const wrongBarrier = new Error('artifact directory barrier was incomplete');
  const f = await fixture({
    durableFsFactory: () => ({
      async flushDirectoriesAsync(directories) {
        const expected = [
          f.root,
          path.join(f.root, 'sha256'),
          path.dirname(f.cache.pathForSha256(sha256))
        ].map(candidate => path.resolve(candidate)).sort();
        const actual = directories.map(candidate => path.resolve(candidate)).sort();
        throw actual.length === expected.length && actual.every((candidate, index) => candidate === expected[index])
          ? reachedExpectedBarrier
          : wrongBarrier;
      }
    })
  });
  t.after(f.cleanup);

  await assert.rejects(f.cache.commitPart({
    partialPath: await partial(f.root, 'artifact-directory-durability.part', content),
    sha256,
    measuredSize: String(content.length)
  }), error => error === reachedExpectedBarrier);
});

test('artifact publication flushes every newly creatable directory up to its durability root', async (t) => {
  // This fails if recursive cache-directory creation can be lost even though the leaf entry was flushed.
  const container = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-cache-directory-chain-'));
  t.after(() => fs.rm(container, { recursive: true, force: true }));
  const durabilityRoot = path.join(container, 'user-data');
  const root = path.join(durabilityRoot, 'modpack-lifecycle', 'cache');
  const workspaceRoot = path.join(durabilityRoot, 'modpack-lifecycle', 'workspaces');
  await fs.mkdir(durabilityRoot);
  const content = Buffer.from('complete artifact directory chain');
  const sha256 = digest(content);
  const reachedExpectedBarrier = new Error('complete artifact directory chain reached');
  const wrongBarrier = new Error('artifact directory chain was incomplete');
  let cache;
  cache = new ArtifactCache({
    root,
    workspaceRoot,
    durabilityRoot,
    durableFsFactory: () => ({
      async flushDirectoriesAsync(directories) {
        const expected = [
          durabilityRoot,
          path.join(durabilityRoot, 'modpack-lifecycle'),
          root,
          path.join(root, 'sha256'),
          path.dirname(cache.pathForSha256(sha256))
        ].map(candidate => path.resolve(candidate)).sort();
        const actual = directories.map(candidate => path.resolve(candidate)).sort();
        throw actual.length === expected.length && actual.every((candidate, index) => candidate === expected[index])
          ? reachedExpectedBarrier
          : wrongBarrier;
      }
    })
  });

  await assert.rejects(cache.commitPart({
    partialPath: await partial(root, 'complete-directory-chain.part', content),
    sha256,
    measuredSize: String(content.length)
  }), error => error === reachedExpectedBarrier);
});

test('production artifact publication delegates the final move to the durable rename authority', async (t) => {
  // This fails if sync-folder publication uses raw rename without write-through reconciliation.
  const content = Buffer.from('production artifact durable move');
  const sha256 = digest(content);
  const authorityFailure = new Error('durable rename authority reached');
  const f = await fixture({
    durableFsFactory: () => ({
      async renameDurableAsync() { throw authorityFailure; },
      async flushDirectoriesAsync() {}
    })
  });
  t.after(f.cleanup);

  await assert.rejects(f.cache.commitPart({
    partialPath: await partial(f.root, 'production-durable-move.part', content),
    sha256,
    measuredSize: String(content.length)
  }), error => error === authorityFailure);
});

test('retention publication rejects when the renamed metadata file cannot be synced', async (t) => {
  // This fails if terminal outcome retention returns before its final-name file barrier.
  const syncFailure = Object.assign(new Error('injected retention target sync failure'), { code: 'EIO' });
  let target = null;
  const fsApi = {
    ...fs,
    async open(candidate, flags, ...args) {
      const handle = await fs.open(candidate, flags, ...args);
      if (flags !== 'r+' || path.resolve(candidate) !== target) return handle;
      return new Proxy(handle, {
        get(value, key) {
          if (key === 'sync') return async () => { throw syncFailure; };
          const member = Reflect.get(value, key, value);
          return typeof member === 'function' ? member.bind(value) : member;
        }
      });
    }
  };
  const f = await fixture({
    fsApi,
    durableFsFactory: () => ({ async flushDirectoriesAsync() {} })
  });
  t.after(f.cleanup);
  target = path.join(f.root, '.retained-artifacts.json');
  const sha256 = await seedCacheEntry(f.cache, Buffer.from('retention target sync'));

  await assert.rejects(f.cache.retainForOutcome({
    ownerId: 'job-retention-file-durability',
    sha256s: [sha256]
  }), error => error === syncFailure);
});

test('retention publication rejects until the cache directory entry reaches the durable barrier', async (t) => {
  // This fails if terminal outcome retention returns before the metadata rename is directory-durable.
  const reachedExpectedBarrier = new Error('expected retention directory barrier reached');
  const wrongBarrier = new Error('retention directory barrier was incomplete');
  const f = await fixture({
    durableFsFactory: () => ({
      async flushDirectoriesAsync(directories) {
        const actual = directories.map(candidate => path.resolve(candidate));
        throw actual.length === 1 && actual[0] === path.resolve(f.root)
          ? reachedExpectedBarrier
          : wrongBarrier;
      }
    })
  });
  t.after(f.cleanup);
  const sha256 = await seedCacheEntry(f.cache, Buffer.from('retention directory barrier'));

  await assert.rejects(f.cache.retainForOutcome({
    ownerId: 'job-retention-directory-durability',
    sha256s: [sha256]
  }), error => error === reachedExpectedBarrier);
});

test('pre-publication retention failure leaves no phantom in-memory hold', async (t) => {
  // This fails if retain mutates the authoritative Map before durable publication succeeds.
  const syncFailure = Object.assign(new Error('injected retention temporary sync failure'), { code: 'EIO' });
  const fsApi = {
    ...fs,
    async open(candidate, flags, ...args) {
      const handle = await fs.open(candidate, flags, ...args);
      if (flags !== 'r+' || !path.basename(candidate).endsWith('.tmp')) return handle;
      return new Proxy(handle, {
        get(value, key) {
          if (key === 'sync') return async () => { throw syncFailure; };
          const member = Reflect.get(value, key, value);
          return typeof member === 'function' ? member.bind(value) : member;
        }
      });
    }
  };
  const f = await fixture({ fsApi }); t.after(f.cleanup);
  const sha256 = await seedCacheEntry(f.cache, Buffer.from('pre-publication add'));

  await assert.rejects(f.cache.retainForOutcome({
    ownerId: 'job-pre-publication-add',
    sha256s: [sha256]
  }), error => error === syncFailure);
  assert.equal(await f.cache.hasRetainedOutcome({ ownerId: 'job-pre-publication-add', sha256 }), false);
});

test('pre-publication retention removal failure preserves the prior in-memory hold', async (t) => {
  // This fails if a failed removal lets same-process prune disagree with still-durable metadata.
  const syncFailure = Object.assign(new Error('injected retention removal sync failure'), { code: 'EIO' });
  let failTemporarySync = false;
  const fsApi = {
    ...fs,
    async open(candidate, flags, ...args) {
      const handle = await fs.open(candidate, flags, ...args);
      if (!failTemporarySync || flags !== 'r+' || !path.basename(candidate).endsWith('.tmp')) return handle;
      return new Proxy(handle, {
        get(value, key) {
          if (key === 'sync') return async () => { throw syncFailure; };
          const member = Reflect.get(value, key, value);
          return typeof member === 'function' ? member.bind(value) : member;
        }
      });
    }
  };
  const f = await fixture({ fsApi }); t.after(f.cleanup);
  const sha256 = await seedCacheEntry(f.cache, Buffer.from('pre-publication remove'));
  await f.cache.retainForOutcome({ ownerId: 'job-pre-publication-remove', sha256s: [sha256] });
  failTemporarySync = true;

  await assert.rejects(f.cache.removeRetainedIfUnreferenced({
    ownerId: 'job-pre-publication-remove',
    sha256
  }), error => error === syncFailure);
  assert.equal(await f.cache.hasRetainedOutcome({ ownerId: 'job-pre-publication-remove', sha256 }), true);
});

test('production retention publication delegates replacement to the durable write authority', async (t) => {
  // This fails if sync-folder replacement uses raw rename without write-through reconciliation.
  const authorityFailure = new Error('durable write authority reached');
  const f = await fixture({
    durableFsFactory: () => ({
      async writeFileAtomicAsync() { throw authorityFailure; },
      async flushDirectoriesAsync() {}
    })
  });
  t.after(f.cleanup);
  const sha256 = await seedCacheEntry(f.cache, Buffer.from('native retention write'));

  await assert.rejects(f.cache.retainForOutcome({
    ownerId: 'job-native-retention-write',
    sha256s: [sha256]
  }), error => error === authorityFailure);
});

test('retained outcome expires exactly at seven days and becomes prune-eligible', async (t) => {
  // This fails if a failed/manual download hold can accumulate forever.
  const retainedAt = Date.parse('2026-08-01T00:00:00.000Z');
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const content = Buffer.from('seven-day retained outcome');
  const sha256 = digest(content);
  const f = await fixture(); t.after(f.cleanup);
  f.cache.clock = () => retainedAt;
  await f.cache.commitPart({
    partialPath: await partial(f.root, 'seven-day-retention.part', content),
    sha256,
    measuredSize: String(content.length)
  });
  await f.cache.retainForOutcome({ ownerId: 'job-seven-day-retention', sha256s: [sha256] });

  assert.deepEqual(await f.cache.prune({ now: retainedAt + sevenDays - 1, maxBytes: 0 }), {
    removed: 0,
    reclaimedBytes: 0
  });
  assert.deepEqual(await f.cache.prune({ now: retainedAt + sevenDays, maxBytes: 0 }), {
    removed: 1,
    reclaimedBytes: content.length
  });
  assert.equal(await f.cache.hasRetainedOutcome({ ownerId: 'job-seven-day-retention', sha256 }), false);
});

test('expired outcome hold is removed durably while an active runtime reference preserves the artifact', async (t) => {
  // This fails if automatic outcome expiry ignores the independent live reference authority.
  const retainedAt = Date.parse('2026-08-01T00:00:00.000Z');
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const content = Buffer.from('expired but actively referenced');
  const sha256 = digest(content);
  const f = await fixture(); t.after(f.cleanup);
  f.cache.clock = () => retainedAt;
  await f.cache.commitPart({
    partialPath: await partial(f.root, 'active-expired-retention.part', content),
    sha256,
    measuredSize: String(content.length)
  });
  await f.cache.retainForOutcome({ ownerId: 'job-active-expired-retention', sha256s: [sha256] });
  f.cache.retain(sha256);

  assert.deepEqual(await f.cache.prune({ now: retainedAt + sevenDays, maxBytes: 0 }), {
    removed: 0,
    reclaimedBytes: 0
  });
  assert.equal(await f.cache.hasRetainedOutcome({ ownerId: 'job-active-expired-retention', sha256 }), false);
  await fs.lstat(f.cache.pathForSha256(sha256));
  f.cache.release(sha256);
  assert.deepEqual(await f.cache.prune({ now: retainedAt + sevenDays, maxBytes: 0 }), {
    removed: 1,
    reclaimedBytes: content.length
  });
});

test('legacy retained outcomes use their metadata age and migrate through seven-day expiry', async (t) => {
  // This fails if version-one holds become immortal after the timestamped schema is introduced.
  const retainedAt = Date.parse('2026-08-01T00:00:00.000Z');
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const content = Buffer.from('legacy retained outcome');
  const sha256 = digest(content);
  const f = await fixture(); t.after(f.cleanup);
  await f.cache.commitPart({
    partialPath: await partial(f.root, 'legacy-retention.part', content),
    sha256,
    measuredSize: String(content.length)
  });
  const retentionPath = path.join(f.root, '.retained-artifacts.json');
  await fs.writeFile(retentionPath, JSON.stringify({
    schemaVersion: 1,
    entries: [{ ownerId: 'job-legacy-retention', sha256s: [sha256] }]
  }));
  await fs.utimes(retentionPath, new Date(retainedAt), new Date(retainedAt));
  const restarted = new ArtifactCache({ root: f.root, workspaceRoot: f.workspaceRoot, clock: () => retainedAt + sevenDays });

  assert.deepEqual(await restarted.prune({ maxBytes: 0 }), {
    removed: 1,
    reclaimedBytes: content.length
  });
  assert.equal(await restarted.hasRetainedOutcome({ ownerId: 'job-legacy-retention', sha256 }), false);
});

test('reports a retained outcome as expired when its artifact vanished before the action ran', async (t) => {
  // This fails if a stale outcome action is treated as a successful no-op after the archive is gone.
  const f = await fixture(); t.after(f.cleanup);
  const content = Buffer.from('expired retained download');
  const sha256 = digest(content);
  await f.cache.commitPart({ partialPath: await partial(f.root, 'expired.part', content), sha256, measuredSize: String(content.length) });
  await f.cache.retainForOutcome({ ownerId: 'job-expired', sha256s: [sha256] });
  await fs.unlink(f.cache.pathForSha256(sha256));

  assert.deepEqual(await f.cache.removeRetainedIfUnreferenced({ ownerId: 'job-expired', sha256 }), {
    status: 'expired', removed: false
  });
});

test('reclaims only stale owned download partials left by interrupted transfers', async (t) => {
  // This fails if crash-orphaned downloads accumulate indefinitely or pruning touches a recent transfer.
  const now = Date.parse('2026-08-31T12:00:00.000Z');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-cache-partial-prune-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = new ArtifactCache({ root, workspaceRoot: path.join(root, 'workspaces'), clock: () => now });
  const partialRoot = path.join(root, 'partial');
  await fs.mkdir(partialRoot, { recursive: true });
  const stale = path.join(partialRoot, 'download-orphan.partial');
  const active = path.join(partialRoot, 'download-active.partial');
  await fs.writeFile(stale, 'stale');
  await fs.writeFile(active, 'active');
  await fs.utimes(stale, new Date(now - (8 * 24 * 60 * 60 * 1000)), new Date(now - (8 * 24 * 60 * 60 * 1000)));

  assert.deepEqual(await cache.prune(), { removed: 1, reclaimedBytes: 5 });
  await assert.rejects(fs.lstat(stale), error => error.code === 'ENOENT');
  await fs.lstat(active);
});

test('reclaims only stale owned cache publication remnants left by an interrupted commit', async (t) => {
  // This fails if a process crash between copy-and-verify and atomic publish leaves cache bytes forever,
  // or if pruning broadens past the exact temporary name contract.
  const now = Date.parse('2026-08-31T12:00:00.000Z');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-cache-publication-prune-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = new ArtifactCache({ root, workspaceRoot: path.join(root, 'workspaces'), clock: () => now });
  const staleDigest = 'a'.repeat(64);
  const recentDigest = 'b'.repeat(64);
  const stale = path.join(root, 'sha256', 'aa', `${staleDigest}.11111111-1111-4111-8111-111111111111.partial`);
  const recent = path.join(root, 'sha256', 'bb', `${recentDigest}.22222222-2222-4222-8222-222222222222.partial`);
  const malformed = path.join(root, 'sha256', 'cc', `${'c'.repeat(64)}.not-a-uuid.partial`);
  const misplaced = path.join(root, 'sha256', 'cc', `${'d'.repeat(64)}.33333333-3333-4333-8333-333333333333.partial`);
  await Promise.all([stale, recent, malformed, misplaced].map(file => fs.mkdir(path.dirname(file), { recursive: true })));
  await fs.writeFile(stale, 'orphaned');
  await fs.writeFile(recent, 'recent');
  await fs.writeFile(malformed, 'keep');
  await fs.writeFile(misplaced, 'keep');
  await fs.utimes(stale, new Date(now - (8 * 24 * 60 * 60 * 1000)), new Date(now - (8 * 24 * 60 * 60 * 1000)));
  await fs.utimes(malformed, new Date(now - (8 * 24 * 60 * 60 * 1000)), new Date(now - (8 * 24 * 60 * 60 * 1000)));
  await fs.utimes(misplaced, new Date(now - (8 * 24 * 60 * 60 * 1000)), new Date(now - (8 * 24 * 60 * 60 * 1000)));

  assert.deepEqual(await cache.prune(), { removed: 1, reclaimedBytes: 8 });
  await assert.rejects(fs.lstat(stale), error => error.code === 'ENOENT');
  await fs.lstat(recent);
  await fs.lstat(malformed);
  await fs.lstat(misplaced);
});
