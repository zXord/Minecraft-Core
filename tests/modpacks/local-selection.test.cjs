const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ArtifactCache } = require('../../electron/services/modpacks/artifacts/artifact-cache.cjs');
const { SelectionRegistry } = require('../../electron/services/modpacks/local/selection-registry.cjs');
const { LocalArtifactSource } = require('../../electron/services/modpacks/local/local-artifact-source.cjs');

const ID_A = 'A'.repeat(32);
const ID_B = 'B'.repeat(32);
const TTL_MS = 30 * 60 * 1000;

function digest(content, algorithm) {
  return crypto.createHash(algorithm).update(content).digest('hex');
}

function idSequence(values) {
  let index = 0;
  const source = () => values[index++] ?? `X${String(index).padStart(31, '0')}`;
  Object.defineProperty(source, 'calls', { get: () => index });
  return source;
}

async function fixture({
  files = { 'server.zip': Buffer.from('server archive') },
  selectedNames = Object.keys(files),
  dialogResult,
  fsApi = fs,
  maxSetBytes,
  ids = [ID_A, ID_B],
  now = Date.UTC(2026, 7, 2, 0, 0, 0),
  cacheDecorator,
  groupMultipartCandidates
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-local-selection-'));
  const sourceRoot = path.join(root, 'selected', 'private-parent');
  await fs.mkdir(sourceRoot, { recursive: true });
  const paths = new Map();
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(sourceRoot, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (content && content.directory === true) await fs.mkdir(target, { recursive: true });
    else await fs.writeFile(target, content);
    paths.set(name, target);
  }
  const clockState = { now };
  const randomId = idSequence(ids);
  const calls = [];
  const dialog = {
    async showOpenDialog(options) {
      calls.push(options);
      return dialogResult ?? {
        canceled: false,
        filePaths: selectedNames.map(name => paths.get(name) ?? path.join(sourceRoot, name))
      };
    }
  };
  const cache = new ArtifactCache({ root: path.join(root, 'cache'), workspaceRoot: path.join(root, 'workspaces') });
  if (cacheDecorator) cacheDecorator(cache, { root, sourceRoot, paths });
  const registry = new SelectionRegistry({ clock: () => clockState.now, randomId });
  const source = new LocalArtifactSource({
    dialog,
    registry,
    clock: () => clockState.now,
    fsApi,
    cache,
    partialRoot: path.join(cache.root, 'local-partials'),
    partialIdSource: idSequence(['partial-one', 'partial-two', 'partial-three']),
    ...(maxSetBytes === undefined ? {} : { maxSetBytes }),
    ...(groupMultipartCandidates ? { groupMultipartCandidates } : {})
  });
  return {
    root, sourceRoot, paths, clockState, randomId, calls, dialog, cache, registry, source,
    cleanup: () => fs.rm(root, { recursive: true, force: true })
  };
}

async function partialFiles(root) {
  try {
    return (await fs.readdir(root, { recursive: true })).map(String).filter(name => name.endsWith('.partial'));
  } catch {
    return [];
  }
}

function publicErrorText(error) {
  return JSON.stringify({
    code: error?.code,
    message: error?.message,
    details: error?.details,
    publicResult: error?.toPublicResult?.()
  });
}

function proxyStat(stat, overrides = {}) {
  return new Proxy(stat, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function proxyHandle(handle, overrides = {}) {
  return new Proxy(handle, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

class TrackingSignal {
  constructor() {
    this.aborted = false;
    this.listeners = new Set();
  }

  addEventListener(type, listener) {
    if (type === 'abort') this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === 'abort') this.listeners.delete(listener);
  }

  abort() {
    if (this.aborted) return;
    this.aborted = true;
    for (const listener of [...this.listeners]) listener.call(this, { type: 'abort' });
  }
}

test('SelectionRegistry retries collisions and atomically consumes the first valid claim', () => {
  let now = 100;
  const registry = new SelectionRegistry({ clock: () => now, randomId: idSequence([ID_A, ID_A, ID_B]) });
  const firstInput = ['C:\\private\\one.zip'];
  const first = registry.create({ selectedPaths: firstInput, displayNames: ['one.zip'], expiresAt: 200 });
  firstInput[0] = 'C:\\changed\\elsewhere.zip';
  const second = registry.create({ selectedPaths: ['C:\\private\\two.zip'], displayNames: ['two.zip'], expiresAt: 200 });

  assert.equal(first.selectionId, ID_A);
  assert.equal(second.selectionId, ID_B);
  const claimed = registry.claim(ID_A);
  assert.equal(claimed.selectedPaths[0], 'C:\\private\\one.zip');
  assert.equal(Object.isFrozen(claimed), true);
  assert.equal(Object.isFrozen(claimed.selectedPaths), true);
  assert.throws(() => registry.claim(ID_A), error => error.code === 'PLAN_STALE');
  now = 150;
  assert.equal(registry.claim(ID_B).displayNames[0], 'two.zip');
});

test('SelectionRegistry expires exactly at the boundary and sweep never revives records', () => {
  let now = 1_000;
  const before = new SelectionRegistry({ clock: () => now, randomId: idSequence([ID_A]) });
  before.create({ selectedPaths: ['one'], displayNames: ['one.zip'], expiresAt: 2_000 });
  now = 1_999;
  assert.equal(before.claim(ID_A).displayNames[0], 'one.zip');

  now = 1_000;
  const boundary = new SelectionRegistry({ clock: () => now, randomId: idSequence([ID_A, ID_B]) });
  boundary.create({ selectedPaths: ['one'], displayNames: ['one.zip'], expiresAt: 2_000 });
  boundary.create({ selectedPaths: ['two'], displayNames: ['two.zip'], expiresAt: 1_999 });
  now = 2_000;
  assert.equal(boundary.sweepExpired(), 2);
  for (const selectionId of [ID_A, ID_B, '../unsafe', 'short']) {
    assert.throws(() => boundary.claim(selectionId), error => error.code === 'PLAN_STALE');
  }
  assert.equal(boundary.invalidate(ID_A), false);
  assert.equal(boundary.sweepExpired(), 0);
});

test('native cancellation is immutable, path-free, and creates no selection record', async (t) => {
  const f = await fixture({ dialogResult: { canceled: true, filePaths: [] } });
  t.after(f.cleanup);
  const result = await f.source.selectWithNativeDialog({ allowMultipart: false });
  assert.deepEqual(result, { cancelled: true });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(f.randomId.calls, 0);
  assert.deepEqual(f.calls[0].properties, ['openFile']);
});

test('single selection exposes only safe display metadata and complete native filters', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const result = await f.source.selectWithNativeDialog({ allowMultipart: false });
  const rendered = JSON.stringify(result);

  assert.deepEqual(Object.keys(result).sort(), ['cancelled', 'expiresAt', 'files', 'provisionalGrouping', 'selectionId']);
  assert.equal(result.cancelled, false);
  assert.equal(result.selectionId, ID_A);
  assert.equal(result.expiresAt, new Date(f.clockState.now + TTL_MS).toISOString());
  assert.deepEqual(result.files, [{ displayName: 'server.zip', size: '14' }]);
  assert.equal(result.provisionalGrouping.kind, 'single');
  assert.equal(result.provisionalGrouping.groupingScheme, 'single');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.files), true);
  assert.equal(Object.isFrozen(result.files[0]), true);
  assert.equal(rendered.includes(f.root), false);
  assert.equal(rendered.includes('private-parent'), false);
  assert.equal(rendered.includes('selectedPaths'), false);
  assert.equal(rendered.includes('device'), false);
  assert.equal(rendered.includes('inode'), false);

  const extensions = f.calls[0].filters.flatMap(filter => filter.extensions);
  for (const extension of ['mrpack', 'zip', 'rar', 'r00', '001', '*']) assert.equal(extensions.includes(extension), true);
  assert.equal(f.calls[0].properties.includes('multiSelections'), false);
});

test('multipart selection is enabled only on request and resolves to one reviewed ordered set', async (t) => {
  const files = {
    'server.part02.rar': Buffer.from('part two'),
    'server.part01.rar': Buffer.from('part one')
  };
  const f = await fixture({ files, selectedNames: ['server.part02.rar', 'server.part01.rar'] });
  t.after(f.cleanup);
  const result = await f.source.selectWithNativeDialog({ allowMultipart: true });

  assert.equal(f.calls[0].properties.includes('multiSelections'), true);
  assert.equal(result.provisionalGrouping.kind, 'multipart');
  assert.equal(result.provisionalGrouping.groupingScheme, 'part-number');
  assert.deepEqual(result.provisionalGrouping.parts.map(part => part.displayName), ['server.part01.rar', 'server.part02.rar']);
  assert.deepEqual(result.provisionalGrouping.parts.map(part => part.partId), ['local-0001', 'local-0002']);
  assert.equal(result.provisionalGrouping.primaryPartId, 'local-0001');
  assert.equal(result.provisionalGrouping.tailCompleteness, 'unknown');
});

test('renderer-facing requests are exact closed shapes and never accept a path or picker override', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const invalidRequests = [
    null,
    {},
    { allowMultipart: 'false' },
    { allowMultipart: false, path: f.paths.get('server.zip') },
    { allowMultipart: false, directory: f.sourceRoot },
    { allowMultipart: false, filters: [{ extensions: ['exe'] }] },
    Object.assign(Object.create({ inherited: true }), { allowMultipart: false })
  ];
  for (const request of invalidRequests) {
    await assert.rejects(f.source.selectWithNativeDialog(request), error => error.code === 'INVALID_REQUEST');
  }
  assert.equal(f.calls.length, 0);

  const selected = await f.source.selectWithNativeDialog({ allowMultipart: false });
  for (const options of [
    { path: f.paths.get('server.zip') },
    { onProgress: 'callback' },
    { signal: { aborted: false } }
  ]) {
    await assert.rejects(f.source.ingestSelection(selected.selectionId, options), error => error.code === 'INVALID_REQUEST');
  }
  const verified = await f.source.ingestSelection(selected.selectionId, {});
  assert.equal(verified.type, 'verified-artifact-set');
});

test('empty, duplicate, missing, non-file, unsafe-name, unsupported, and excessive picker results fail closed', async (t) => {
  const f = await fixture({
    files: {
      'one.zip': Buffer.from('one'),
      'folder.zip': { directory: true },
      ' unsafe.zip': Buffer.from('unsafe'),
      'installer.exe': Buffer.from('not an archive')
    }
  });
  t.after(f.cleanup);

  const cases = [
    [{ canceled: false, filePaths: [] }, 'INVALID_REQUEST'],
    [{ canceled: false, filePaths: [f.paths.get('one.zip'), f.paths.get('one.zip')] }, 'INVALID_REQUEST'],
    [{ canceled: false, filePaths: [path.join(f.sourceRoot, 'missing.zip')] }, 'INVALID_REQUEST'],
    [{ canceled: false, filePaths: [f.paths.get('folder.zip')] }, 'INVALID_REQUEST'],
    [{ canceled: false, filePaths: [f.paths.get(' unsafe.zip')] }, 'INVALID_REQUEST'],
    [{ canceled: false, filePaths: [f.paths.get('installer.exe')] }, 'UNSUPPORTED_ARCHIVE'],
    [{ canceled: false, filePaths: [f.paths.get('one.zip'), f.paths.get('installer.exe')] }, 'INVALID_REQUEST']
  ];
  for (const [result, code] of cases) {
    f.dialog.showOpenDialog = async () => result;
    await assert.rejects(f.source.selectWithNativeDialog({ allowMultipart: true }), error => {
      assert.equal(error.code, code);
      const rendered = publicErrorText(error);
      return !rendered.includes(f.root) && !rendered.includes('private-parent');
    });
  }

  f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f.paths.get('one.zip'), f.paths.get('installer.exe')] });
  await assert.rejects(f.source.selectWithNativeDialog({ allowMultipart: false }), error => error.code === 'INVALID_REQUEST');
});

test('symlinks and reparse-like selected entries are rejected before registration', async (t) => {
  await t.test('file symlink', async (t) => {
    const f = await fixture({ files: { 'real.zip': Buffer.from('real') } });
    t.after(f.cleanup);
    const linked = path.join(f.sourceRoot, 'linked.zip');
    try {
      await fs.symlink(f.paths.get('real.zip'), linked, 'file');
    } catch (error) {
      if (error.code === 'EPERM') {
        t.skip('file symlinks require Windows privilege');
        return;
      }
      throw error;
    }
    f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [linked] });
    await assert.rejects(f.source.selectWithNativeDialog({ allowMultipart: false }), error => error.code === 'INVALID_REQUEST');
  });

  await t.test('reported reparse point', async (t) => {
    const f = await fixture({ files: { 'real.zip': Buffer.from('real') } });
    t.after(f.cleanup);
    const realFs = fs;
    const reparseFs = {
      ...realFs,
      lstat: async (target, options) => {
        const stat = await realFs.lstat(target, options);
        return target === f.paths.get('real.zip') ? proxyStat(stat, { isReparsePoint: () => true }) : stat;
      }
    };
    const reparseSource = new LocalArtifactSource({
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [f.paths.get('real.zip')] }) },
      registry: new SelectionRegistry({ clock: () => f.clockState.now, randomId: idSequence([ID_B]) }),
      clock: () => f.clockState.now,
      fsApi: reparseFs,
      cache: f.cache,
      partialRoot: path.join(f.cache.root, 'reparse-partials'),
      partialIdSource: idSequence(['reparse-partial'])
    });
    await assert.rejects(reparseSource.selectWithNativeDialog({ allowMultipart: false }), error => error.code === 'INVALID_REQUEST');
  });
});

test('multipart gaps, duplicate volumes, secondary-only families, and unrelated extras cannot be registered', async (t) => {
  const f = await fixture({
    files: {
      'server.part1.rar': Buffer.from('one'),
      'server.part01.rar': Buffer.from('duplicate one'),
      'server.part3.rar': Buffer.from('three'),
      'server.r00': Buffer.from('secondary'),
      'alpha.part1.rar': Buffer.from('alpha'),
      'beta.part1.rar': Buffer.from('beta')
    }
  });
  t.after(f.cleanup);
  for (const names of [
    ['server.part1.rar', 'server.part3.rar'],
    ['server.part1.rar', 'server.part01.rar'],
    ['server.r00'],
    ['alpha.part1.rar', 'beta.part1.rar']
  ]) {
    f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: names.map(name => f.paths.get(name)) });
    await assert.rejects(f.source.selectWithNativeDialog({ allowMultipart: true }), error =>
      error.code === 'MULTIPART_VOLUME_MISSING' || error.code === 'INVALID_REQUEST');
  }
});

test('hard-link aliases are duplicate source identities and cannot form a selection', async (t) => {
  const f = await fixture({ files: { 'server.part1.rar': Buffer.from('same source') } });
  t.after(f.cleanup);
  const alias = path.join(f.sourceRoot, 'server.part2.rar');
  await fs.link(f.paths.get('server.part1.rar'), alias);
  f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f.paths.get('server.part1.rar'), alias] });
  await assert.rejects(f.source.selectWithNativeDialog({ allowMultipart: true }), error => error.code === 'INVALID_REQUEST');
});

test('declared aggregate bytes are bounded before registration and streamed bytes are bounded while copying', async (t) => {
  await t.test('declared aggregate', async (t) => {
    const f = await fixture({ files: { 'server.part1.rar': Buffer.from('123'), 'server.part2.rar': Buffer.from('456') }, maxSetBytes: 5n });
    t.after(f.cleanup);
    await assert.rejects(f.source.selectWithNativeDialog({ allowMultipart: true }), error =>
      error.code === 'ARCHIVE_LIMIT_EXCEEDED' && error.details.limit === 'maxArtifactSetBytes' && error.details.actual === '6');
    assert.equal(f.randomId.calls, 0);
  });

  await t.test('actual stream', async (t) => {
    let selectedPath;
    const maskingFs = {
      ...fs,
      lstat: async (target, options) => {
        const stat = await fs.lstat(target, options);
        return target === selectedPath ? proxyStat(stat, { size: 4n }) : stat;
      },
      open: async (target, flags, ...rest) => {
        const handle = await fs.open(target, flags, ...rest);
        if (target !== selectedPath || flags !== 'r') return handle;
        return proxyHandle(handle, { stat: async options => proxyStat(await handle.stat(options), { size: 4n }) });
      }
    };
    const f = await fixture({ files: { 'server.zip': Buffer.from('12345') }, fsApi: maskingFs, maxSetBytes: 4n });
    t.after(f.cleanup);
    selectedPath = f.paths.get('server.zip');
    const selected = await f.source.selectWithNativeDialog({ allowMultipart: false });
    await assert.rejects(f.source.ingestSelection(selected.selectionId, {}), error =>
      error.code === 'ARCHIVE_LIMIT_EXCEEDED' && error.details.actual === '5');
    assert.deepEqual(await partialFiles(f.cache.root), []);
  });
});

test('ingestion streams without whole-file reads, calculates dual hashes, commits cache bytes, and leaves originals untouched', async (t) => {
  const content = Buffer.from('archive bytes'.repeat(10_000));
  const noWholeFileFs = { ...fs, readFile: async () => { throw new Error('whole-file reads are forbidden'); } };
  const f = await fixture({ files: { 'server.mrpack': content }, fsApi: noWholeFileFs });
  t.after(f.cleanup);
  const selected = await f.source.selectWithNativeDialog({ allowMultipart: false });
  const events = [];
  const result = await f.source.ingestSelection(selected.selectionId, { onProgress: event => events.push(event) });
  const part = result.artifactSet.parts[0];

  assert.equal(result.type, 'verified-artifact-set');
  assert.equal(result.provider, 'local');
  assert.equal(result.artifactSet.providerImmutable, false);
  assert.equal(result.artifactSet.attestationStatus, 'unavailable');
  assert.equal(Object.hasOwn(part, 'providerDigest'), false);
  assert.equal(part.measuredSize, String(content.length));
  assert.equal(part.calculatedDigests.sha256, digest(content, 'sha256'));
  assert.equal(part.calculatedDigests.sha512, digest(content, 'sha512'));
  assert.equal(await f.cache.verifyEntry({ sha256: part.calculatedDigests.sha256, size: part.measuredSize }), true);
  assert.deepEqual(await fs.readFile(f.paths.get('server.mrpack')), content);
  assert.deepEqual(await partialFiles(f.cache.root), []);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.artifactSet.parts[0]), true);
  assert.ok(events.length >= 2);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ['measuredBytes', 'partId', 'totalBytes']);
    assert.equal(Object.isFrozen(event), true);
    assert.match(event.partId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    assert.match(event.measuredBytes, /^(0|[1-9][0-9]*)$/);
    assert.equal(event.totalBytes, String(content.length));
    assert.equal(JSON.stringify(event).includes(f.root), false);
  }
  assert.equal(JSON.stringify(result).includes(f.root), false);
  assert.equal(JSON.stringify(result).includes('cache'), false);
});

test('a claimed local selection cannot be replayed', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const selected = await f.source.selectWithNativeDialog({ allowMultipart: false });
  await f.source.ingestSelection(selected.selectionId, {});
  await assert.rejects(f.source.ingestSelection(selected.selectionId, {}), error => error.code === 'PLAN_STALE');
});

test('a local selection expires at the exact 30-minute boundary', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const selected = await f.source.selectWithNativeDialog({ allowMultipart: false });
  f.clockState.now += TTL_MS;
  await assert.rejects(f.source.ingestSelection(selected.selectionId, {}), error => error.code === 'PLAN_STALE');
  assert.deepEqual(await partialFiles(f.cache.root), []);
});

test('replacement or mutation before, during, and after streaming invalidates the claimed selection', async (t) => {
  await t.test('before ingestion', async (t) => {
    const f = await fixture({ files: { 'server.zip': Buffer.alloc(10, 1) } });
    t.after(f.cleanup);
    const selected = await f.source.selectWithNativeDialog({ allowMultipart: false });
    await fs.appendFile(f.paths.get('server.zip'), Buffer.from([2]));
    await assert.rejects(f.source.ingestSelection(selected.selectionId, {}), error => error.code === 'PLAN_STALE');
    await assert.rejects(f.source.ingestSelection(selected.selectionId, {}), error => error.code === 'PLAN_STALE');
  });

  await t.test('between lstat and handle validation', async (t) => {
    let selectedPath;
    let replaced = false;
    const replacingFs = {
      ...fs,
      open: async (target, flags, ...rest) => {
        if (target === selectedPath && flags === 'r' && !replaced) {
          replaced = true;
          await fs.rename(target, `${target}.original`);
          await fs.writeFile(target, Buffer.from('replacement'));
        }
        return fs.open(target, flags, ...rest);
      }
    };
    const f = await fixture({ files: { 'server.zip': Buffer.from('original') }, fsApi: replacingFs });
    t.after(f.cleanup);
    selectedPath = f.paths.get('server.zip');
    const selected = await f.source.selectWithNativeDialog({ allowMultipart: false });
    await assert.rejects(f.source.ingestSelection(selected.selectionId, {}), error => error.code === 'PLAN_STALE');
    assert.deepEqual(await partialFiles(f.cache.root), []);
  });

  await t.test('during streaming', async (t) => {
    let selectedPath;
    let mutated = false;
    const mutatingFs = {
      ...fs,
      open: async (target, flags, ...rest) => {
        const handle = await fs.open(target, flags, ...rest);
        if (target !== selectedPath || flags !== 'r') return handle;
        return proxyHandle(handle, {
          read: async (...args) => {
            const result = await handle.read(...args);
            if (!mutated && result.bytesRead > 0) {
              mutated = true;
              await fs.appendFile(target, Buffer.from('changed'));
            }
            return result;
          }
        });
      }
    };
    const f = await fixture({ files: { 'server.zip': Buffer.alloc(150_000, 7) }, fsApi: mutatingFs });
    t.after(f.cleanup);
    selectedPath = f.paths.get('server.zip');
    const selected = await f.source.selectWithNativeDialog({ allowMultipart: false });
    await assert.rejects(f.source.ingestSelection(selected.selectionId, {}), error =>
      error.code === 'PLAN_STALE' || error.code === 'HASH_MISMATCH');
    assert.deepEqual(await partialFiles(f.cache.root), []);
  });

  await t.test('during cache publication', async (t) => {
    let sourcePath;
    const f = await fixture({
      files: { 'server.zip': Buffer.from('stable until commit') },
      cacheDecorator(cache, context) {
        sourcePath = context.paths.get('server.zip');
        const commit = cache.commitPart.bind(cache);
        cache.commitPart = async request => {
          const result = await commit(request);
          await fs.appendFile(sourcePath, Buffer.from('late mutation'));
          return result;
        };
      }
    });
    t.after(f.cleanup);
    const selected = await f.source.selectWithNativeDialog({ allowMultipart: false });
    await assert.rejects(f.source.ingestSelection(selected.selectionId, {}), error => error.code === 'PLAN_STALE');
    assert.deepEqual(await partialFiles(f.cache.root), []);
  });
});

test('a later multipart failure returns no verified set, cleans live partials, and leaves originals untouched', async (t) => {
  const originals = {
    'server.part1.rar': Buffer.from('one unchanged'),
    'server.part2.rar': Buffer.from('two unchanged')
  };
  let commits = 0;
  const f = await fixture({
    files: originals,
    cacheDecorator(cache) {
      const commit = cache.commitPart.bind(cache);
      cache.commitPart = async request => {
        commits += 1;
        if (commits === 2) throw new Error('private cache failure C:\\private\\secret');
        return commit(request);
      };
    }
  });
  t.after(f.cleanup);
  const selected = await f.source.selectWithNativeDialog({ allowMultipart: true });
  await assert.rejects(f.source.ingestSelection(selected.selectionId, {}), error => {
    assert.equal(error.code, 'INVALID_REQUEST');
    return !publicErrorText(error).includes('private cache failure') && !publicErrorText(error).includes('C:\\private');
  });
  assert.equal(commits, 2);
  assert.deepEqual(await partialFiles(f.cache.root), []);
  for (const [name, bytes] of Object.entries(originals)) assert.deepEqual(await fs.readFile(f.paths.get(name)), bytes);
  await assert.rejects(f.source.ingestSelection(selected.selectionId, {}), error => error.code === 'PLAN_STALE');
});

test('cancellation aborts promptly, removes listeners and partials, consumes the claim, and preserves the original', async (t) => {
  const content = Buffer.alloc(200_000, 0x5a);
  const f = await fixture({ files: { 'server.zip': content } });
  t.after(f.cleanup);
  const selected = await f.source.selectWithNativeDialog({ allowMultipart: false });
  const signal = new TrackingSignal();
  await assert.rejects(f.source.ingestSelection(selected.selectionId, {
    signal,
    onProgress() { signal.abort(); }
  }), error => error.code === 'CANCELLED');

  assert.equal(signal.listeners.size, 0);
  assert.deepEqual(await partialFiles(f.cache.root), []);
  assert.deepEqual(await fs.readFile(f.paths.get('server.zip')), content);
  await assert.rejects(f.source.ingestSelection(selected.selectionId, {}), error => error.code === 'PLAN_STALE');
});

test('a failing signal listener cleanup cannot strand source handles or controlled partials', async (t) => {
  const content = Buffer.alloc(200_000, 0x5b);
  const f = await fixture({ files: { 'server.zip': content } });
  t.after(f.cleanup);
  const selected = await f.source.selectWithNativeDialog({ allowMultipart: false });
  const signal = new TrackingSignal();
  const remove = signal.removeEventListener.bind(signal);
  signal.removeEventListener = (type, listener) => {
    remove(type, listener);
    throw new Error(`listener cleanup leaked ${f.paths.get('server.zip')}`);
  };
  await assert.rejects(f.source.ingestSelection(selected.selectionId, {
    signal,
    onProgress() { signal.abort(); }
  }), error => error.code === 'CANCELLED' && !publicErrorText(error).includes(f.root));
  assert.equal(signal.listeners.size, 0);
  assert.deepEqual(await partialFiles(f.cache.root), []);
  assert.deepEqual(await fs.readFile(f.paths.get('server.zip')), content);
});

test('progress callback failures cannot leak paths, strand handles, or leave a replayable selection', async (t) => {
  const content = Buffer.alloc(100_000, 0x44);
  const f = await fixture({ files: { 'server.zip': content } });
  t.after(f.cleanup);
  const selected = await f.source.selectWithNativeDialog({ allowMultipart: false });
  await assert.rejects(f.source.ingestSelection(selected.selectionId, {
    onProgress(event) {
      assert.equal(Object.isFrozen(event), true);
      throw new Error(`callback leaked ${f.paths.get('server.zip')}`);
    }
  }), error => error.code === 'INVALID_REQUEST' && !publicErrorText(error).includes(f.root));
  assert.deepEqual(await partialFiles(f.cache.root), []);
  assert.deepEqual(await fs.readFile(f.paths.get('server.zip')), content);
  await assert.rejects(f.source.ingestSelection(selected.selectionId, {}), error => error.code === 'PLAN_STALE');
});

test('asynchronous progress callback rejection is contained and cleans the claimed operation', async (t) => {
  const content = Buffer.alloc(100_000, 0x45);
  const f = await fixture({ files: { 'server.zip': content } });
  t.after(f.cleanup);
  const selected = await f.source.selectWithNativeDialog({ allowMultipart: false });
  await assert.rejects(f.source.ingestSelection(selected.selectionId, {
    async onProgress() {
      throw new Error(`async callback leaked ${f.paths.get('server.zip')}`);
    }
  }), error => error.code === 'INVALID_REQUEST' && !publicErrorText(error).includes(f.root));
  assert.deepEqual(await partialFiles(f.cache.root), []);
  assert.deepEqual(await fs.readFile(f.paths.get('server.zip')), content);
  await assert.rejects(f.source.ingestSelection(selected.selectionId, {}), error => error.code === 'PLAN_STALE');
});

test('filesystem and dialog failures are sanitized without local path disclosure', async (t) => {
  const secretPath = 'C:\\Users\\person\\private\\secret.zip';
  const f = await fixture({ dialogResult: new Error(`dialog failed for ${secretPath}`) });
  t.after(f.cleanup);
  f.dialog.showOpenDialog = async () => { throw new Error(`dialog failed for ${secretPath}`); };
  await assert.rejects(f.source.selectWithNativeDialog({ allowMultipart: false }), error =>
    error.code === 'INVALID_REQUEST' && !publicErrorText(error).includes(secretPath));

  f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(f.sourceRoot, 'vanished.zip')] });
  await assert.rejects(f.source.selectWithNativeDialog({ allowMultipart: false }), error => {
    const rendered = publicErrorText(error);
    return error.code === 'INVALID_REQUEST' && !rendered.includes(f.root) && !rendered.includes('vanished.zip');
  });
});
