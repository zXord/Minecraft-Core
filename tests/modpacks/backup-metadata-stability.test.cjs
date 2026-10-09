const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const {
  enumerateArchiveScope,
  enumerateArchiveScopeCooperatively,
  verifyZipScopeStreaming
} = require('../../electron/utils/backup-util.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-backup-metadata-'));
  const directory = path.join(root, 'scope');
  fs.mkdirSync(directory);
  const file = path.join(directory, 'payload.bin');
  fs.writeFileSync(file, 'unchanged payload');
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('minecraft-backup-metadata-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, directory, file };
}

// Keep real stat shape/methods and real I/O; inject exact metadata evidence so
// these races do not depend on clock resolution or host-specific chmod behavior.
function alteredStat(stat, changes) {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, changes);
}

function duringReadFs(onFirstRead, alterStat = stat => stat) {
  let read = false;
  const fsApi = Object.create(fs);
  fsApi.readSync = (...args) => {
    const count = fs.readSync(...args);
    if (count > 0 && !read) {
      read = true;
      onFirstRead();
    }
    return count;
  };
  fsApi.fstatSync = (...args) => alterStat(fs.fstatSync(...args), read);
  fsApi.lstatSync = (...args) => alterStat(fs.lstatSync(...args), read, args[0]);
  return fsApi;
}

for (const [name, scan] of [
  ['synchronous', async (items, options) => enumerateArchiveScope(items, options)],
  ['cooperative', enumerateArchiveScopeCooperatively]
]) {
  test(`${name} scope accepts file ctime-only churn while hashing real bytes`, async t => {
    const { file } = fixture(t);
    const fsApi = duringReadFs(() => {}, (stat, read) =>
      read ? alteredStat(stat, { ctimeNs: stat.ctimeNs + 1n }) : stat);
    const scope = await scan([file], { fsApi });
    assert.equal(scope.fileCount, 1);
    assert.equal(scope.totalBytes, 17);
    assert.equal(scope.entries[0].sha256,
      crypto.createHash('sha256').update('unchanged payload').digest('hex'));
  });

  test(`${name} scope bounds a continually changing ctime to one verification reread`, async t => {
    const { file } = fixture(t);
    const fsApi = Object.create(fs);
    let measured = 0;
    let version = 0n;
    fsApi.readSync = (...args) => {
      const count = fs.readSync(...args);
      measured += count;
      return count;
    };
    fsApi.fstatSync = (...args) => {
      const stat = fs.fstatSync(...args);
      return alteredStat(stat, { ctimeNs: stat.ctimeNs + ++version });
    };
    const scope = await scan([file], { fsApi });
    assert.equal(scope.entries[0].size, 17);
    assert.equal(measured, 34, 'verification must read the real content exactly twice without retries');
  });

  test(`${name} scope accepts directory ctime-only churn during traversal`, async t => {
    const { directory } = fixture(t);
    const expected = enumerateArchiveScope([directory]);
    const fsApi = duringReadFs(() => {}, (stat, read, candidate) =>
      read && candidate === directory ? alteredStat(stat, { ctimeNs: stat.ctimeNs + 1n }) : stat);
    assert.deepEqual(await scan([directory], { fsApi }), expected);
  });

  for (const field of ['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs', 'mode', 'nlink']) {
    test(`${name} scope rejects changed ${field} evidence while hashing`, async t => {
      const { file } = fixture(t);
      const fsApi = duringReadFs(() => {}, (stat, read) =>
        read ? alteredStat(stat, { [field]: stat[field] + 1n }) : stat);
      await assert.rejects(scan([file], { fsApi }), { code: 'BACKUP_FAILED' });
    });
  }

  test(`${name} scope rejects actual content modification during hashing`, async t => {
    const { file } = fixture(t);
    const fsApi = duringReadFs(() => fs.writeFileSync(file, 'different content with a new size'));
    await assert.rejects(scan([file], { fsApi }), { code: 'BACKUP_FAILED' });
  });

  test(`${name} scope rejects same-size content modification hidden behind ctime-only drift`, async t => {
    const { file } = fixture(t);
    const before = fs.lstatSync(file, { bigint: true });
    const fsApi = duringReadFs(() => fs.writeFileSync(file, 'different payload'), (stat, read) =>
      read ? alteredStat(stat, { mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs + 1n }) : stat);
    await assert.rejects(scan([file], { fsApi }), { code: 'BACKUP_FAILED' });
  });

  test(`${name} scope rejects same-byte file replacement during hashing`, async t => {
    const { file } = fixture(t);
    const fsApi = duringReadFs(() => {
      fs.renameSync(file, `${file}.old`);
      fs.writeFileSync(file, 'unchanged payload');
    });
    await assert.rejects(scan([file], { fsApi }), { code: 'BACKUP_FAILED' });
  });

  test(`${name} scope rejects changed directory membership even with unchanged stat times`, async t => {
    const { directory } = fixture(t);
    const before = fs.lstatSync(directory, { bigint: true });
    const fsApi = duringReadFs(() => fs.writeFileSync(path.join(directory, 'new.bin'), 'new'),
      (stat, read, candidate) => candidate === directory ? before : stat);
    await assert.rejects(scan([directory], { fsApi }), { code: 'BACKUP_FAILED' });
  });

  test(`${name} scope rejects a directory junction substituted during traversal`, async t => {
    const { root, directory } = fixture(t);
    const target = path.join(root, 'redirect');
    fs.mkdirSync(target);
    const fsApi = duringReadFs(() => {
      fs.renameSync(directory, `${directory}.old`);
      fs.symlinkSync(target, directory, process.platform === 'win32' ? 'junction' : 'dir');
    });
    await assert.rejects(scan([directory], { fsApi }), { code: 'BACKUP_FAILED' });
  });
}

function zipFixture(t, contents = 'unchanged payload') {
  const base = fixture(t);
  const scope = enumerateArchiveScope([base.file]);
  const archive = path.join(base.root, 'backup.zip');
  const zip = new AdmZip();
  zip.addFile('payload.bin', Buffer.from(contents));
  zip.addZipComment('original');
  zip.writeZip(archive);
  return { ...base, scope, archive };
}

function streamingEvidenceFs(archive, alterStat) {
  const fsApi = Object.create(fs);
  fsApi.lstatSync = (...args) => alterStat(fs.lstatSync(...args));
  const asyncFsApi = {
    async open(...args) {
      assert.equal(args[0], archive);
      const handle = await fs.promises.open(...args);
      return {
        fd: handle.fd,
        read: (...readArgs) => handle.read(...readArgs),
        stat: async (...statArgs) => alterStat(await handle.stat(...statArgs)),
        close: () => handle.close()
      };
    }
  };
  return { fsApi, asyncFsApi };
}

test('streaming ZIP verification accepts ctime-only churn and preserves archive evidence schema', async t => {
  const { archive, scope } = zipFixture(t);
  const expectedHash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  let changed = false;
  const options = streamingEvidenceFs(archive, stat =>
    changed ? alteredStat(stat, { ctimeNs: stat.ctimeNs + 1n }) : stat);
  const result = await verifyZipScopeStreaming(archive, scope, {
    ...options,
    onChunk() { changed = true; }
  });
  assert.equal(result.archiveSha256, expectedHash);
  assert.deepEqual(Object.keys(result.archiveIdentity), ['dev', 'ino', 'size', 'birthtimeNs', 'mtimeNs', 'ctimeNs']);
  assert.equal(result.archiveIdentity.ctimeNs, String(fs.lstatSync(archive, { bigint: true }).ctimeNs + 1n));
});

for (const field of ['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs', 'mode', 'nlink']) {
  test(`streaming ZIP verification rejects changed ${field} evidence`, async t => {
    const { archive, scope } = zipFixture(t);
    let changed = false;
    const options = streamingEvidenceFs(archive, stat =>
      changed ? alteredStat(stat, { [field]: stat[field] + 1n }) : stat);
    await assert.rejects(verifyZipScopeStreaming(archive, scope, {
      ...options,
      onChunk() { changed = true; }
    }), { code: 'BACKUP_FAILED' });
  });
}

test('streaming ZIP verification rejects archive-byte changes even when entries and write time match', async t => {
  const { archive, scope } = zipFixture(t);
  const before = fs.lstatSync(archive, { bigint: true });
  const options = streamingEvidenceFs(archive, stat => alteredStat(stat, {
    mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs + 1n
  }));
  let changed = false;
  await assert.rejects(verifyZipScopeStreaming(archive, scope, {
    ...options,
    onChunk() {
      if (changed) return;
      changed = true;
      const fd = fs.openSync(archive, 'r+');
      try { fs.writeSync(fd, Buffer.from('modified'), 0, 8, Number(before.size) - 8); }
      finally { fs.closeSync(fd); }
    }
  }), { code: 'BACKUP_FAILED' });
});

test('streaming ZIP verification rejects a content hash mismatch with matching entry size', async t => {
  const { archive, scope } = zipFixture(t, 'different payload');
  await assert.rejects(verifyZipScopeStreaming(archive, scope), { code: 'BACKUP_FAILED' });
});

test('streaming ZIP verification rejects a corrupt archive', async t => {
  const { archive, scope } = zipFixture(t);
  fs.writeFileSync(archive, 'not a ZIP');
  await assert.rejects(verifyZipScopeStreaming(archive, scope), { code: 'BACKUP_FAILED' });
});

test('cooperative source verification reread remains cancellable and closes its pinned descriptor', async t => {
  const { file } = fixture(t);
  fs.writeFileSync(file, Buffer.alloc((4 * 1024 * 1024) + 17, 0x5a));
  const size = fs.statSync(file).size;
  const controller = new AbortController();
  const fsApi = Object.create(fs);
  let measured = 0;
  let pinned;
  fsApi.openSync = (...args) => { pinned = fs.openSync(...args); return pinned; };
  fsApi.readSync = (...args) => {
    const count = fs.readSync(...args);
    measured += count;
    if (measured > size) controller.abort();
    return count;
  };
  fsApi.fstatSync = (...args) => {
    const stat = fs.fstatSync(...args);
    return measured > 0 ? alteredStat(stat, { ctimeNs: stat.ctimeNs + 1n }) : stat;
  };
  await assert.rejects(enumerateArchiveScopeCooperatively([file], { fsApi, signal: controller.signal }),
    { code: 'CANCELLED' });
  assert.ok(measured > size && measured < size * 2);
  assert.throws(() => fs.fstatSync(pinned), { code: 'EBADF' });
});

test('final pinned ZIP hash remains cancellable and reports actual bounded bytes', async t => {
  const { archive, scope } = zipFixture(t);
  const controller = new AbortController();
  let entriesVerified = false;
  const progress = [];
  await assert.rejects(verifyZipScopeStreaming(archive, scope, {
    signal: controller.signal,
    onChunk() { entriesVerified = true; },
    onProgress(value) {
      progress.push(value);
      if (entriesVerified && value.phase === 'archive-hash' && value.kind === 'progress') controller.abort();
    }
  }), { code: 'CANCELLED' });
  const last = progress.at(-1);
  assert.equal(last.phase, 'archive-hash');
  assert.equal(last.hashPass, 'final');
  assert.equal(last.processedBytes, fs.statSync(archive).size);
  assert.equal(last.totalBytes, fs.statSync(archive).size);
});
