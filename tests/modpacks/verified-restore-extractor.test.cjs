const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const AdmZip = require('adm-zip');
const archiver = require('archiver');

const {
  createVerifiedZip,
  enumerateArchiveScope,
  verifyZipScopeStreaming
} = require('../../electron/utils/backup-util.cjs');
const {
  createVerifiedRestoreExtractor
} = require('../../electron/services/modpack-lifecycle/verified-restore-extractor.cjs');

const noReparse = Object.freeze({
  async isReparsePoint() { return false; }
});

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-restore-extractor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function scope(entries) {
  const ordered = [...entries].sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
  return {
    schemaVersion: 1,
    entries: ordered,
    totalBytes: ordered.reduce((total, entry) => total + entry.size, 0),
    fileCount: ordered.filter(entry => entry.type === 'file').length,
    scopeSha256: crypto.createHash('sha256').update(JSON.stringify(ordered), 'utf8').digest('hex')
  };
}

function archiveIdentity(archivePath) {
  const stat = fs.lstatSync(archivePath, { bigint: true });
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    birthtimeNs: String(stat.birthtimeNs),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs)
  };
}

function archiveEvidence(archivePath) {
  const bytes = fs.readFileSync(archivePath);
  return {
    expectedArchiveSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    expectedArchiveSize: bytes.length,
    expectedArchiveIdentity: archiveIdentity(archivePath)
  };
}

async function verifiedFixture(t) {
  const root = temporaryRoot(t);
  const source = path.join(root, 'source');
  const world = path.join(source, 'world');
  fs.mkdirSync(world, { recursive: true });
  fs.writeFileSync(path.join(source, 'server.properties'), 'server-port=25565\n');
  fs.writeFileSync(path.join(world, 'level.dat'), 'world-data');
  const expectedScope = enumerateArchiveScope([
    path.join(source, 'server.properties'),
    world
  ]);
  const archivePath = path.join(root, 'restore.zip');
  const partPath = `${archivePath}.part`;
  await createVerifiedZip({
    items: [path.join(source, 'server.properties'), world],
    partPath,
    expectedScope
  });
  fs.renameSync(partPath, archivePath);
  const evidence = await verifyZipScopeStreaming(archivePath, expectedScope);
  return {
    archivePath,
    expectedScope,
    root,
    request(stagingName = 'staging') {
      return {
        archivePath,
        stagingPath: path.join(root, stagingName),
        expectedArchiveSha256: evidence.archiveSha256,
        expectedArchiveSize: evidence.archiveSize,
        expectedArchiveIdentity: evidence.archiveIdentity,
        expectedScope,
        operationId: 'restore-operation-1'
      };
    }
  };
}

function createExtractor(options = {}) {
  return createVerifiedRestoreExtractor({
    fsApi: fs,
    reparseInspector: noReparse,
    durableFs: { flushDirectory() {} },
    ...options
  });
}

async function writeSymlinkZip(archivePath, entryName, target) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(archivePath, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level: 0 } });
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
    archive.pipe(output);
    archive.symlink(entryName, target);
    archive.finalize();
  });
}

test('verified restore extraction binds archive identity, digest, scope, and post-extraction fingerprint', async t => {
  const fixture = await verifiedFixture(t);
  const request = fixture.request();
  const result = await createExtractor()(request);

  assert.equal(result.ok, true);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.scopeSha256, fixture.expectedScope.scopeSha256);
  assert.equal(fs.readFileSync(path.join(request.stagingPath, 'world', 'level.dat'), 'utf8'), 'world-data');
  assert.equal(fs.readFileSync(path.join(request.stagingPath, 'server.properties'), 'utf8'), 'server-port=25565\n');
});

test('archive substitution after review fails before the owned staging directory is created', async t => {
  const fixture = await verifiedFixture(t);
  const request = fixture.request('tampered-staging');
  fs.appendFileSync(fixture.archivePath, Buffer.from('tamper'));

  await assert.rejects(createExtractor()(request), error => error?.code === 'BACKUP_FAILED');
  assert.equal(fs.existsSync(request.stagingPath), false);
});

test('a traversal entry is rejected even when the caller supplies a different safe scope', async t => {
  const root = temporaryRoot(t);
  const archivePath = path.join(root, 'traversal.zip');
  const zip = new AdmZip();
  zip.addFile('../escaped.txt', Buffer.from('escaped'));
  zip.writeZip(archivePath);
  const expectedScope = scope([{
    path: 'safe.txt', type: 'file', size: 7,
    sha256: crypto.createHash('sha256').update('escaped').digest('hex')
  }]);
  const request = {
    archivePath,
    stagingPath: path.join(root, 'staging'),
    ...archiveEvidence(archivePath),
    expectedScope,
    operationId: 'restore-operation-2'
  };

  await assert.rejects(createExtractor()(request), error => error?.code === 'BACKUP_FAILED');
  assert.equal(fs.existsSync(path.join(root, 'escaped.txt')), false);
  assert.equal(fs.existsSync(request.stagingPath), false);
});

test('ZIP link entries are rejected even when their bytes match the declared file scope', async t => {
  const root = temporaryRoot(t);
  const archivePath = path.join(root, 'link.zip');
  await writeSymlinkZip(archivePath, 'linked.txt', 'server.properties');
  const payload = Buffer.from('server.properties');
  const expectedScope = scope([{
    path: 'linked.txt', type: 'file', size: payload.length,
    sha256: crypto.createHash('sha256').update(payload).digest('hex')
  }]);
  const request = {
    archivePath,
    stagingPath: path.join(root, 'staging'),
    ...archiveEvidence(archivePath),
    expectedScope,
    operationId: 'restore-operation-3'
  };

  await assert.rejects(createExtractor()(request), error => error?.code === 'BACKUP_FAILED');
  assert.equal(fs.existsSync(request.stagingPath), false);
});

test('declared extraction limits are enforced before any destination is created', async t => {
  const fixture = await verifiedFixture(t);
  const request = fixture.request('limited-staging');
  const extract = createExtractor({ limits: { maxEntries: 100, maxTotalBytes: 4, maxFileBytes: 4, maxPathDepth: 16 } });

  await assert.rejects(extract(request), error => error?.code === 'BACKUP_FAILED');
  assert.equal(fs.existsSync(request.stagingPath), false);
});

test('interrupted extraction closes files and removes only its identity-bound staging tree', async t => {
  const fixture = await verifiedFixture(t);
  const request = fixture.request('interrupted-staging');
  let interrupted = false;
  const extract = createExtractor({
    async faultInjector(boundary) {
      if (!interrupted && boundary === 'after-file-flush') {
        interrupted = true;
        throw new Error('interrupted');
      }
    }
  });

  await assert.rejects(extract(request), error => error?.code === 'BACKUP_FAILED');
  assert.equal(interrupted, true);
  assert.equal(fs.existsSync(request.stagingPath), false);
  assert.equal(fs.existsSync(path.join(fixture.root, 'server.properties')), false);
});
