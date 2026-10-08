const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const AdmZip = require('adm-zip');

let workerModule = null;
let protocol = null;
try {
  workerModule = require('../electron/services/java-archive-worker.cjs');
  protocol = require('../electron/services/java-archive-worker-protocol.cjs');
} catch {
  // The first TDD run intentionally reaches the assertions without the modules.
}

const token = 'e'.repeat(64);
const requestId = 'f'.repeat(32);

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.env = { MINECRAFT_CORE_JAVA_ARCHIVE_WORKER_TOKEN: token };
    this.connected = true;
    this.responses = [];
    this.exitCodes = [];
  }
  send(value, callback) {
    this.responses.push(value);
    queueMicrotask(() => callback?.(null));
    return true;
  }
  disconnect() { this.connected = false; }
  exit(code) { this.exitCodes.push(code); }
}

function fixture(t, entryName = 'jdk/bin/java.exe') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-java-archive-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const temp = path.join(root, 'temp');
  fs.mkdirSync(temp);
  const archivePath = path.join(temp, 'runtime.zip');
  const zip = new AdmZip();
  zip.addFile('fixture.bin', Buffer.from('java'));
  zip.getEntries()[0].entryName = entryName;
  zip.writeZip(archivePath);
  const archiveBytes = fs.readFileSync(archivePath);
  return {
    rootPath: fs.realpathSync.native(root),
    archivePath: fs.realpathSync.native(archivePath),
    destinationPath: path.join(root, 'java-17'),
    maxArchiveBytes: 268435456,
    expectedArchiveSize: archiveBytes.length,
    expectedSha256: require('node:crypto').createHash('sha256').update(archiveBytes).digest('hex')
  };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

test('worker extracts one reviewed ZIP beneath the exact root and returns bounded evidence', async t => {
  assert.equal(typeof workerModule?.startJavaArchiveWorker, 'function');
  const payload = fixture(t);
  const processRef = new FakeProcess();
  workerModule.startJavaArchiveWorker({ processRef, requestTimeoutMs: 1000 });
  processRef.emit('message', protocol.createJavaArchiveRequest({ token, requestId, payload }));
  await flush();

  assert.equal(Object.hasOwn(processRef.env, 'MINECRAFT_CORE_JAVA_ARCHIVE_WORKER_TOKEN'), false);
  const stagingPath = protocol.javaArchiveStagingPath(payload.destinationPath, requestId);
  assert.equal(fs.existsSync(payload.destinationPath), false);
  assert.equal(fs.readFileSync(path.join(stagingPath, 'jdk', 'bin', 'java.exe'), 'utf8'), 'java');
  assert.deepEqual(protocol.verifyJavaArchiveResponse(
    processRef.responses[0], token, requestId
  ), {
    ok: true,
    code: null,
    result: {
      entryCount: 1,
      expandedBytes: '4',
      javaExecutableRelativePath: 'jdk/bin/java.exe'
    }
  });
  assert.deepEqual(processRef.exitCodes, [0]);
  assert.deepEqual(fs.readdirSync(payload.rootPath).filter(name => name.includes('-extract-')), [
    path.basename(stagingPath)
  ]);
});

test('worker rejects traversal before publication and returns no private path detail', async t => {
  assert.equal(typeof workerModule?.startJavaArchiveWorker, 'function');
  const payload = fixture(t, '../escape.exe');
  const processRef = new FakeProcess();
  workerModule.startJavaArchiveWorker({ processRef, requestTimeoutMs: 1000 });
  processRef.emit('message', protocol.createJavaArchiveRequest({ token, requestId, payload }));
  await flush();

  assert.equal(fs.existsSync(payload.destinationPath), false);
  assert.deepEqual(protocol.verifyJavaArchiveResponse(
    processRef.responses[0], token, requestId
  ), { ok: false, code: 'JAVA_ARCHIVE_UNSAFE', result: null });
  assert.equal(JSON.stringify(processRef.responses[0]).includes(payload.archivePath), false);
  assert.deepEqual(processRef.exitCodes, [1]);
});

test('worker rejects archive substitution against the parent-verified size and digest', async t => {
  assert.equal(typeof workerModule?.startJavaArchiveWorker, 'function');
  const payload = fixture(t);
  payload.expectedSha256 = '0'.repeat(64);
  const processRef = new FakeProcess();
  workerModule.startJavaArchiveWorker({ processRef, requestTimeoutMs: 1000 });
  processRef.emit('message', protocol.createJavaArchiveRequest({ token, requestId, payload }));
  await flush();

  assert.equal(fs.existsSync(payload.destinationPath), false);
  assert.deepEqual(protocol.verifyJavaArchiveResponse(
    processRef.responses[0], token, requestId
  ), { ok: false, code: 'JAVA_ARCHIVE_UNSAFE', result: null });
  assert.deepEqual(fs.readdirSync(payload.rootPath).filter(name => name.includes('-extract-')), []);
});

test('worker keeps an existing Java runtime intact when staged extraction fails', t => {
  assert.equal(typeof workerModule?.extractJavaZip, 'function');
  const payload = fixture(t);
  fs.mkdirSync(path.join(payload.destinationPath, 'bin'), { recursive: true });
  const priorJava = path.join(payload.destinationPath, 'bin', 'java.exe');
  fs.writeFileSync(priorJava, 'prior runtime');

  class FailingZip {
    constructor(bytes) { this.zip = new AdmZip(bytes); }
    getEntries() { return this.zip.getEntries(); }
    extractAllTo(destination) {
      fs.writeFileSync(path.join(destination, 'partial.bin'), 'partial');
      throw new Error('private extraction failure');
    }
  }

  assert.throws(() => workerModule.extractJavaZip(payload, {
    AdmZipImpl: FailingZip,
    requestId
  }), error => error?.code === 'JAVA_EXTRACTION_FAILED' &&
    !error.message.includes('private extraction failure'));
  assert.equal(fs.readFileSync(priorJava, 'utf8'), 'prior runtime');
  assert.deepEqual(fs.readdirSync(payload.rootPath).filter(name => name.includes('-extract-')), []);
});

test('worker preserves a single nested runtime root without rename-sensitive flattening', t => {
  assert.equal(typeof workerModule?.extractJavaZip, 'function');
  const payload = fixture(t);
  let renameCalls = 0;
  const fsApi = {
    ...fs,
    renameSync() {
      renameCalls += 1;
      const error = new Error('simulated transient directory rename lock');
      error.code = 'EPERM';
      throw error;
    }
  };

  const result = workerModule.extractJavaZip(payload, { fsApi, requestId });

  const stagingPath = protocol.javaArchiveStagingPath(payload.destinationPath, requestId);
  assert.equal(renameCalls, 0, 'extraction must not flatten a valid nested JRE by renaming its children');
  assert.equal(fs.readFileSync(path.join(stagingPath, 'jdk', 'bin', 'java.exe'), 'utf8'), 'java');
  assert.deepEqual(result, {
    entryCount: 1,
    expandedBytes: '4',
    javaExecutableRelativePath: 'jdk/bin/java.exe'
  });
});

test('worker preserves archive layout when the runtime has additional top-level content', t => {
  assert.equal(typeof workerModule?.extractJavaZip, 'function');
  const payload = fixture(t);
  const zip = new AdmZip();
  zip.addFile('jdk/bin/java.exe', Buffer.from('java'));
  zip.addFile('README.txt', Buffer.from('readme'));
  zip.writeZip(payload.archivePath);
  const archiveBytes = fs.readFileSync(payload.archivePath);
  payload.expectedArchiveSize = archiveBytes.length;
  payload.expectedSha256 = require('node:crypto').createHash('sha256').update(archiveBytes).digest('hex');

  workerModule.extractJavaZip(payload, { requestId });

  const stagingPath = protocol.javaArchiveStagingPath(payload.destinationPath, requestId);
  assert.equal(fs.readFileSync(path.join(stagingPath, 'jdk', 'bin', 'java.exe'), 'utf8'), 'java');
  assert.equal(fs.existsSync(path.join(stagingPath, 'bin', 'java.exe')), false);
  assert.equal(fs.readFileSync(path.join(stagingPath, 'README.txt'), 'utf8'), 'readme');
});
