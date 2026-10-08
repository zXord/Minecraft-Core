const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProductionCandidatePreparer,
  copyRegularFile,
  scanManifest
} = require('../../electron/services/modpacks/planning/production-candidate-preparer.cjs');

const safeReparseInspector = { async isReparsePoint() { return false; } };

test('direct manifest scans hash exact bytes without blocking main-process heartbeats', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-candidate-scan-heartbeat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'large.jar');
  fs.closeSync(fs.openSync(filePath, 'w'));
  fs.truncateSync(filePath, 128 * 1024 * 1024);
  let ticks = 0;
  const heartbeat = setInterval(() => { ticks += 1; }, 1);

  try {
    const result = await scanManifest(root, 'installation-worker-heartbeat', {
      reparseInspector: safeReparseInspector
    });
    assert.equal(result.totalBytes, String(128 * 1024 * 1024));
    assert.equal(result.manifest.entries.length, 1);
    assert.match(result.manifest.entries[0].installedHash, /^[a-f0-9]{64}$/u);
    assert.ok(ticks >= 2, `expected event-loop heartbeats during manifest hashing, received ${ticks}`);
  } finally {
    clearInterval(heartbeat);
  }
});

test('direct manifest scans return the same globally canonical path order used by prepared manifests', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-candidate-scan-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config', 'betterquesting'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'betterquesting', 'credits.txt'), 'nested');
  fs.writeFileSync(path.join(root, 'config', 'betterquesting.cfg'), 'sibling');
  fs.mkdirSync(path.join(root, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(root, 'mods', 'pack.jar'), 'mod');

  const result = await scanManifest(root, 'installation-canonical-order', {
    reparseInspector: safeReparseInspector
  });

  assert.deepEqual(result.manifest.entries.map(entry => entry.path), [
    'config/betterquesting.cfg',
    'config/betterquesting/credits.txt',
    'mods/pack.jar'
  ]);
});

test('direct manifest scans abort an in-flight worker hash', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-candidate-scan-abort-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'large.jar');
  fs.closeSync(fs.openSync(filePath, 'w'));
  fs.truncateSync(filePath, 512 * 1024 * 1024);
  const controller = new AbortController();
  const pending = scanManifest(root, 'installation-worker-abort', {
    reparseInspector: safeReparseInspector,
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 5);

  await assert.rejects(pending, error => error?.code === 'CANCELLED');
});

test('regular candidate copies are rehashed in the worker and retain exact bytes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-candidate-copy-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.jar');
  const destination = path.join(root, 'output', 'destination.jar');
  const bytes = Buffer.from('worker verified copy');
  fs.writeFileSync(source, bytes);

  const measured = await copyRegularFile(source, destination, {
    reparseInspector: safeReparseInspector
  });

  assert.deepEqual(fs.readFileSync(destination), bytes);
  assert.deepEqual(measured, {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: String(bytes.length)
  });
});

test('prepared GitHub or local archives copy only server payload and never execute or adopt supplied runtime', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-candidate-preparer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'archive');
  const workspaces = path.join(root, 'workspaces');
  fs.mkdirSync(path.join(archive, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(archive, 'config'), { recursive: true });
  fs.mkdirSync(path.join(archive, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.3.12'), { recursive: true });
  fs.writeFileSync(path.join(archive, 'mods', 'pack.jar'), 'pack-mod');
  fs.writeFileSync(path.join(archive, 'config', 'pack.toml'), 'enabled=true\n');
  fs.writeFileSync(path.join(archive, 'server.properties'), 'motd=Pack\n');
  fs.writeFileSync(path.join(archive, 'server.jar'), 'untrusted-runtime');
  fs.writeFileSync(path.join(archive, 'run.bat'), 'malicious bootstrap');
  fs.writeFileSync(path.join(archive, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.3.12', 'win_args.txt'), 'untrusted args');

  let outputSequence = 0;
  const outputPaths = new Map();
  const workspaceRegistry = {
    createStagingOutput() {
      const id = `output-${++outputSequence}`;
      const outputPath = path.join(workspaces, id);
      fs.mkdirSync(outputPath, { recursive: true });
      outputPaths.set(id, outputPath);
      return id;
    },
    resolveOwnedWorkspace({ id }) { return { id, kind: 'output', path: outputPaths.get(id) }; }
  };
  const reparseInspector = { async isReparsePoint() { return false; } };
  const preparer = new ProductionCandidatePreparer({
    workspaceRegistry,
    archiveExtractor: {
      async extractArchive({ destinationId }) {
        for (const name of await fsp.readdir(archive)) {
          await fsp.cp(path.join(archive, name), path.join(outputPaths.get(destinationId), name), {
            recursive: true, force: false, errorOnExist: true
          });
        }
      }
    },
    artifactDownloader: { async downloadPart() { throw new Error('prepared archives must not download MRPACK parts'); } },
    artifactCache: { pathForSha256() { throw new Error('prepared archives must not use MRPACK cache parts'); } },
    reparseInspector,
    randomUUID: () => '00000000-0000-4000-8000-000000000001'
  });

  const result = await preparer.preparePlanInputs({
    inspection: {
      inspectionId: 'inspection-one',
      result: {
        selectedRoot: null,
        entries: [],
        classification: {
          kind: 'prepared-server-pack', confidence: 'exact', blocked: false,
          runtime: { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12' }
        }
      }
    },
    selections: { optionalFileIds: [] }
  });
  const template = outputPaths.get(result.execution.templateOutputId);
  assert.equal(fs.readFileSync(path.join(template, 'mods', 'pack.jar'), 'utf8'), 'pack-mod');
  assert.equal(fs.readFileSync(path.join(template, 'config', 'pack.toml'), 'utf8'), 'enabled=true\n');
  assert.equal(fs.readFileSync(path.join(template, 'server.properties'), 'utf8'), 'motd=Pack\n');
  assert.equal(fs.existsSync(path.join(template, 'server.jar')), false);
  assert.equal(fs.existsSync(path.join(template, 'libraries')), false);
  assert.equal(fs.existsSync(path.join(template, 'run.bat')), false);
  assert.equal(result.runtime.loaderFamily, 'forge');
  assert.equal(result.runtime.javaMajor, 17);
  assert.deepEqual(result.incomingManifest.entries.map(entry => entry.path), [
    'config/pack.toml', 'mods/pack.jar', 'server.properties'
  ]);
});

test('candidate preparation maps an exhausted filesystem inspection to one retryable public failure', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-candidate-inspection-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'archive');
  const workspaces = path.join(root, 'workspaces');
  fs.mkdirSync(path.join(archive, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(archive, 'mods', 'pack.jar'), 'pack-mod');
  let outputSequence = 0;
  const outputPaths = new Map();
  const workspaceRegistry = {
    createStagingOutput() {
      const id = `output-${++outputSequence}`;
      const outputPath = path.join(workspaces, id);
      fs.mkdirSync(outputPath, { recursive: true });
      outputPaths.set(id, outputPath);
      return id;
    },
    resolveOwnedWorkspace({ id }) { return { id, kind: 'output', path: outputPaths.get(id) }; }
  };
  const preparer = new ProductionCandidatePreparer({
    workspaceRegistry,
    archiveExtractor: {
      async extractArchive({ destinationId }) {
        await fsp.cp(archive, outputPaths.get(destinationId), { recursive: true, force: false, errorOnExist: false });
      }
    },
    artifactDownloader: { async downloadPart() { throw new Error('prepared archives do not download parts'); } },
    artifactCache: { pathForSha256() { throw new Error('prepared archives do not use cached parts'); } },
    reparseInspector: {
      async isReparsePoint() {
        throw Object.assign(new Error('private path must not escape'), { code: 'REPARSE_INSPECTION_FAILED' });
      }
    },
    randomUUID: () => '00000000-0000-4000-8000-000000000006'
  });

  await assert.rejects(preparer.preparePlanInputs({
    inspection: {
      inspectionId: 'inspection-filesystem-failure',
      result: {
        selectedRoot: null,
        entries: [],
        classification: {
          kind: 'prepared-server-pack', confidence: 'exact', blocked: false,
          runtime: { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12' }
        }
      }
    },
    selections: { optionalFileIds: [] }
  }), error => error?.code === 'COMMIT_FAILED' && error.safeMessage === 'File integrity check could not be completed' &&
    error.retryable === true && !String(error).includes(root));
});

test('candidate preparation reports ordered activity boundaries and ignores progress callback failures', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-candidate-progress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'archive');
  const workspaces = path.join(root, 'workspaces');
  fs.mkdirSync(path.join(archive, 'config'), { recursive: true });
  fs.writeFileSync(path.join(archive, 'config', 'pack.toml'), 'enabled=true\n');
  let outputSequence = 0;
  const outputPaths = new Map();
  let hashCalls = 0;
  const candidateHashService = {
    async dispose() {},
    async hashFile(filePath, { expectedIdentity }) {
      hashCalls += 1;
      const bytes = fs.readFileSync(filePath);
      return {
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        size: String(bytes.length),
        identity: expectedIdentity
      };
    }
  };
  const workspaceRegistry = {
    createStagingOutput() {
      const id = `output-${++outputSequence}`;
      const outputPath = path.join(workspaces, id);
      fs.mkdirSync(outputPath, { recursive: true });
      outputPaths.set(id, outputPath);
      return id;
    },
    resolveOwnedWorkspace({ id }) { return { id, kind: 'output', path: outputPaths.get(id) }; }
  };
  const preparer = new ProductionCandidatePreparer({
    workspaceRegistry,
    archiveExtractor: {
      async extractArchive({ destinationId }) {
        await fsp.cp(archive, outputPaths.get(destinationId), { recursive: true, force: false, errorOnExist: false });
      }
    },
    artifactDownloader: { async downloadPart() { throw new Error('prepared archives do not download parts'); } },
    artifactCache: { pathForSha256() { throw new Error('prepared archives do not use cached parts'); } },
    candidateHashService,
    reparseInspector: safeReparseInspector,
    randomUUID: () => '00000000-0000-4000-8000-000000000005'
  });
  const progressEvents = [];

  const result = await preparer.preparePlanInputs({
    inspection: {
      inspectionId: 'inspection-progress',
      result: {
        selectedRoot: null,
        entries: [
          { entryName: 'config', type: 'directory', size: '0' },
          { entryName: 'config/pack.toml', type: 'file', size: '13' }
        ],
        classification: {
          kind: 'prepared-server-pack', confidence: 'exact', blocked: false,
          runtime: { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12' }
        }
      }
    },
    selections: { optionalFileIds: [] },
    onProgress(event) {
      progressEvents.push(event);
      if (event.activity === 'verifying-archive') throw new Error('renderer disconnected');
    }
  });

  assert.deepEqual([...new Set(progressEvents.map(event => event.activity))], [
    'extracting', 'verifying-archive', 'assembling-files'
  ]);
  assert.deepEqual(progressEvents.filter(event => event.activity === 'assembling-files'), [
    { activity: 'assembling-files', completedItems: 0, totalItems: 1, processedBytes: 0, totalBytes: 13 },
    { activity: 'assembling-files', completedItems: 1, totalItems: 1, processedBytes: 13, totalBytes: 13 }
  ]);
  assert.equal(result.incomingManifest.entries.length, 1);
  assert.equal(hashCalls, 2);
});

test('files-only preparation keeps a safe custom-bootstrap archive unmanaged without running its publisher script', async t => {
  // This fails if unsupported runtime layouts are rejected before the files-only fallback can normalize them.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-files-only-custom-bootstrap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'archive');
  const workspaces = path.join(root, 'workspaces');
  fs.mkdirSync(path.join(archive, 'config'), { recursive: true });
  fs.writeFileSync(path.join(archive, 'config', 'pack.toml'), 'enabled=true\n');
  fs.writeFileSync(path.join(archive, 'run.bat'), 'echo publisher-script-ran> publisher-script-ran.txt\r\n');

  let outputSequence = 0;
  const outputPaths = new Map();
  const workspaceRegistry = {
    createStagingOutput() {
      const id = `output-${++outputSequence}`;
      const outputPath = path.join(workspaces, id);
      fs.mkdirSync(outputPath, { recursive: true });
      outputPaths.set(id, outputPath);
      return id;
    },
    resolveOwnedWorkspace({ id }) { return { id, kind: 'output', path: outputPaths.get(id) }; }
  };
  const preparer = new ProductionCandidatePreparer({
    workspaceRegistry,
    archiveExtractor: {
      async extractArchive({ destinationId }) {
        for (const name of await fsp.readdir(archive)) {
          await fsp.cp(path.join(archive, name), path.join(outputPaths.get(destinationId), name), {
            recursive: true, force: false, errorOnExist: true
          });
        }
      }
    },
    artifactDownloader: { async downloadPart() { throw new Error('files-only imports do not download pack parts'); } },
    artifactCache: { pathForSha256() { throw new Error('files-only imports do not use pack cache parts'); } },
    reparseInspector: safeReparseInspector,
    randomUUID: () => '00000000-0000-4000-8000-000000000004'
  });

  const result = await preparer.preparePlanInputs({
    inspection: {
      inspectionId: 'inspection-files-only-custom-bootstrap',
      result: {
        selectedRoot: null,
        entries: [],
        classification: { kind: 'unsupported-runtime-layout', confidence: 'exact', blocked: true }
      }
    },
    operationKind: 'files-only',
    selections: { optionalFileIds: [], selectedRoot: null, runtimeChoice: null }
  });

  const template = outputPaths.get(result.execution.templateOutputId);
  assert.equal(fs.readFileSync(path.join(template, 'config', 'pack.toml'), 'utf8'), 'enabled=true\n');
  assert.equal(fs.existsSync(path.join(template, 'run.bat')), false);
  assert.equal(fs.existsSync(path.join(archive, 'publisher-script-ran.txt')), false);
  assert.equal(result.runtime, null);
  assert.equal(result.inspectionResult.classification.kind, 'files-only');
  assert.equal(result.execution.classificationKind, 'files-only');
});

test('Modrinth MRPACK candidate preparation preserves its exact Fabric runtime independently of legacy bundles', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-mrpack-public-entries-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'archive');
  const workspaces = path.join(root, 'workspaces');
  const cache = path.join(root, 'cache');
  const modBytes = Buffer.from('MRPACK payload');
  const sha256 = crypto.createHash('sha256').update(modBytes).digest('hex');
  const sha1 = crypto.createHash('sha1').update(modBytes).digest('hex');
  const sha512 = crypto.createHash('sha512').update(modBytes).digest('hex');
  fs.mkdirSync(archive, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, sha256), modBytes);
  fs.writeFileSync(path.join(archive, 'modrinth.index.json'), JSON.stringify({
    formatVersion: 1,
    game: 'minecraft',
    versionId: 'public-entry-fixture',
    name: 'Public entry fixture',
    files: [{
      path: 'mods/example.jar',
      hashes: { sha1, sha512 },
      env: { client: 'required', server: 'required' },
      downloads: ['https://cdn.modrinth.com/data/fixture/version/example.jar'],
      fileSize: modBytes.length
    }],
    dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.10' }
  }));

  let outputSequence = 0;
  const outputPaths = new Map();
  const workspaceRegistry = {
    createStagingOutput() {
      const id = `output-${++outputSequence}`;
      const outputPath = path.join(workspaces, id);
      fs.mkdirSync(outputPath, { recursive: true });
      outputPaths.set(id, outputPath);
      return id;
    },
    resolveOwnedWorkspace({ id }) { return { id, kind: 'output', path: outputPaths.get(id) }; }
  };
  const progress = [];
  const preparer = new ProductionCandidatePreparer({
    workspaceRegistry,
    archiveExtractor: {
      async extractArchive({ destinationId }) {
        await fsp.copyFile(path.join(archive, 'modrinth.index.json'), path.join(outputPaths.get(destinationId), 'modrinth.index.json'));
      }
    },
    artifactDownloader: {
      async downloadPart(part, { onProgress }) {
        onProgress?.({ partBytes: '5', totalBytes: String(part.size) });
        onProgress?.({ partBytes: String(part.size), totalBytes: String(part.size) });
        return { sha256 };
      }
    },
    artifactCache: { pathForSha256() { return path.join(cache, sha256); } },
    reparseInspector: { async isReparsePoint() { return false; } },
    randomUUID: () => '00000000-0000-4000-8000-000000000003'
  });

  const result = await preparer.preparePlanInputs({
    inspection: {
      inspectionId: 'inspection-public-entry',
      result: {
        selectedRoot: null,
        entries: [{
          entryName: 'modrinth.index.json', canonicalName: 'modrinth.index.json', type: 'file',
          size: String(fs.statSync(path.join(archive, 'modrinth.index.json')).size), packedSize: '1', depth: 1, nameLength: 19
        }],
        classification: {
          kind: 'mrpack-server', confidence: 'exact', blocked: false,
          runtime: { minecraftVersion: '1.20.1', loaderFamily: 'fabric', loaderVersion: '0.16.10' }
        }
      }
    },
    selections: { optionalFileIds: [] },
    onProgress: event => progress.push(event)
  });

  const template = outputPaths.get(result.execution.templateOutputId);
  assert.equal(fs.readFileSync(path.join(template, 'mods', 'example.jar'), 'utf8'), modBytes.toString());
  assert.deepEqual(result.runtime, {
    minecraftVersion: '1.20.1', loaderFamily: 'fabric', loaderVersion: '0.16.10',
    javaMajor: 17, os: 'win32', architecture: 'x64'
  });
  assert.deepEqual(progress.filter(event => event.activity === 'downloading-pack-files'), [
    { activity: 'downloading-pack-files', completedItems: 0, totalItems: 1, processedBytes: 0, totalBytes: modBytes.length },
    { activity: 'downloading-pack-files', completedItems: 0, totalItems: 1, processedBytes: 5, totalBytes: modBytes.length },
    { activity: 'downloading-pack-files', completedItems: 0, totalItems: 1, processedBytes: modBytes.length, totalBytes: modBytes.length },
    { activity: 'downloading-pack-files', completedItems: 1, totalItems: 1, processedBytes: modBytes.length, totalBytes: modBytes.length }
  ]);
  assert.deepEqual(progress.filter(event => event.activity === 'assembling-files'), [
    { activity: 'assembling-files', completedItems: 0, totalItems: 1, processedBytes: 0, totalBytes: modBytes.length },
    {
      activity: 'assembling-files', completedItems: 1, totalItems: 1,
      processedBytes: modBytes.length, totalBytes: modBytes.length
    }
  ]);
});

test('MRPACK override casing keeps the physical Windows path in the reviewed manifest', {
  skip: process.platform !== 'win32'
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-mrpack-override-casing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'archive');
  const workspaces = path.join(root, 'workspaces');
  const cache = path.join(root, 'cache');
  const downloadBytes = Buffer.from('download layer');
  const overrideBytes = Buffer.from('server override layer');
  const digest = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest('hex');
  const downloadSha256 = digest('sha256', downloadBytes);
  fs.mkdirSync(path.join(archive, 'server-overrides', 'config'), { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, downloadSha256), downloadBytes);
  fs.writeFileSync(path.join(archive, 'server-overrides', 'config', 'A.toml'), overrideBytes);
  fs.writeFileSync(path.join(archive, 'modrinth.index.json'), JSON.stringify({
    formatVersion: 1,
    game: 'minecraft',
    versionId: 'override-casing-fixture',
    name: 'Override casing fixture',
    files: [{
      path: 'config/a.toml',
      hashes: {
        sha1: digest('sha1', downloadBytes),
        sha512: digest('sha512', downloadBytes)
      },
      env: { client: 'required', server: 'required' },
      downloads: ['https://cdn.modrinth.com/data/fixture/version/a.toml'],
      fileSize: downloadBytes.length
    }],
    dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.10' }
  }));

  let outputSequence = 0;
  const outputPaths = new Map();
  const workspaceRegistry = {
    createStagingOutput() {
      const id = `output-${++outputSequence}`;
      const outputPath = path.join(workspaces, id);
      fs.mkdirSync(outputPath, { recursive: true });
      outputPaths.set(id, outputPath);
      return id;
    },
    resolveOwnedWorkspace({ id }) { return { id, kind: 'output', path: outputPaths.get(id) }; }
  };
  const preparer = new ProductionCandidatePreparer({
    workspaceRegistry,
    archiveExtractor: {
      async extractArchive({ destinationId }) {
        await fsp.cp(archive, outputPaths.get(destinationId), {
          recursive: true, force: false, errorOnExist: false
        });
      }
    },
    artifactDownloader: { async downloadPart() { return { sha256: downloadSha256 }; } },
    artifactCache: { pathForSha256() { return path.join(cache, downloadSha256); } },
    reparseInspector: safeReparseInspector,
    randomUUID: () => '00000000-0000-4000-8000-000000000007'
  });

  const result = await preparer.preparePlanInputs({
    inspection: {
      inspectionId: 'inspection-override-casing',
      result: {
        selectedRoot: null,
        entries: [
          { entryName: 'modrinth.index.json', type: 'file', size: '1' },
          { entryName: 'server-overrides/config/A.toml', type: 'file', size: String(overrideBytes.length) }
        ],
        classification: {
          kind: 'mrpack-server', confidence: 'exact', blocked: false,
          runtime: { minecraftVersion: '1.20.1', loaderFamily: 'fabric', loaderVersion: '0.16.10' }
        }
      }
    },
    selections: { optionalFileIds: [] }
  });

  const template = outputPaths.get(result.execution.templateOutputId);
  assert.deepEqual(fs.readdirSync(path.join(template, 'config')), ['a.toml']);
  assert.equal(fs.readFileSync(path.join(template, 'config', 'a.toml'), 'utf8'), overrideBytes.toString());
  assert.deepEqual(result.incomingManifest.entries.map(entry => entry.path), ['config/a.toml']);
  assert.equal(result.incomingManifest.entries[0].installedHash, digest('sha256', overrideBytes));
});

test('repair materializes and downloads only mismatched MRPACK payload while retaining the complete managed baseline', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-targeted-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rawArchive = path.join(root, 'raw-archive');
  const workspaces = path.join(root, 'workspaces');
  const cache = path.join(root, 'cache');
  const serverPath = path.join(root, 'server');
  fs.mkdirSync(rawArchive, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(path.join(serverPath, 'mods'), { recursive: true });

  const healthyBytes = Buffer.from('healthy-managed-mod');
  const missingBytes = Buffer.from('missing-managed-mod');
  const runtimeBytes = Buffer.from('healthy-runtime');
  const digest = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest('hex');
  const fileRecord = (targetPath, bytes) => ({
    path: targetPath,
    hashes: { sha1: digest('sha1', bytes), sha512: digest('sha512', bytes) },
    env: { client: 'required', server: 'required' },
    downloads: [`https://cdn.modrinth.com/data/project/version/${path.basename(targetPath)}`],
    fileSize: bytes.length
  });
  const mrpack = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: 'version-one',
    name: 'Targeted Repair Pack',
    files: [fileRecord('mods/healthy.jar', healthyBytes), fileRecord('mods/missing.jar', missingBytes)],
    dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.10' }
  };
  fs.writeFileSync(path.join(rawArchive, 'modrinth.index.json'), JSON.stringify(mrpack));
  fs.writeFileSync(path.join(serverPath, 'mods', 'healthy.jar'), healthyBytes);
  fs.writeFileSync(path.join(serverPath, 'server.jar'), runtimeBytes);

  const managedEntry = (targetPath, bytes, origin, role) => ({
    path: targetPath,
    pathKey: targetPath.toLocaleLowerCase('en-US'),
    origin,
    managementPolicy: 'replaceable-managed',
    role,
    installedHash: digest('sha256', bytes),
    size: String(bytes.length),
    priorBaseline: null
  });
  const currentManifest = {
    schemaVersion: 1,
    installationId: 'installation-current',
    entries: [
      managedEntry('mods/healthy.jar', healthyBytes, 'pack', 'mod'),
      managedEntry('mods/missing.jar', missingBytes, 'pack', 'mod'),
      managedEntry('server.jar', runtimeBytes, 'runtime', 'server')
    ]
  };
  const liveSnapshot = {
    kind: 'existing', worldDirectories: ['world'], protectedPaths: [],
    entries: [
      { path: 'mods/healthy.jar', pathKey: 'mods/healthy.jar', type: 'file', sha256: digest('sha256', healthyBytes), size: String(healthyBytes.length) },
      { path: 'server.jar', pathKey: 'server.jar', type: 'file', sha256: digest('sha256', runtimeBytes), size: String(runtimeBytes.length) }
    ]
  };

  let outputSequence = 0;
  const outputPaths = new Map();
  const workspaceRegistry = {
    createStagingOutput() {
      const id = `output-${++outputSequence}`;
      const outputPath = path.join(workspaces, id);
      fs.mkdirSync(outputPath, { recursive: true });
      outputPaths.set(id, outputPath);
      return id;
    },
    resolveOwnedWorkspace({ id }) { return { id, kind: 'output', path: outputPaths.get(id) }; }
  };
  const cacheByDigest = new Map();
  for (const [name, bytes] of [['healthy.jar', healthyBytes], ['missing.jar', missingBytes]]) {
    const sha256 = digest('sha256', bytes);
    const cachePath = path.join(cache, `${name}-${sha256}`);
    fs.writeFileSync(cachePath, bytes);
    cacheByDigest.set(sha256, cachePath);
  }
  const downloads = [];
  const preparer = new ProductionCandidatePreparer({
    workspaceRegistry,
    archiveExtractor: {
      async extractArchive({ destinationId }) {
        await fsp.copyFile(
          path.join(rawArchive, 'modrinth.index.json'),
          path.join(outputPaths.get(destinationId), 'modrinth.index.json')
        );
      }
    },
    artifactDownloader: {
      async downloadPart(part) {
        downloads.push(part.targetPath);
        const bytes = part.targetPath === 'mods/healthy.jar' ? healthyBytes : missingBytes;
        return { sha256: digest('sha256', bytes) };
      }
    },
    artifactCache: { pathForSha256(sha256) { return cacheByDigest.get(sha256); } },
    reparseInspector: { async isReparsePoint() { return false; } },
    randomUUID: () => '00000000-0000-4000-8000-000000000002'
  });

  const result = await preparer.preparePlanInputs({
    inspection: {
      inspectionId: 'inspection-repair',
      result: {
        selectedRoot: null,
        entries: [{
          entryName: 'modrinth.index.json', canonicalName: 'modrinth.index.json', type: 'file',
          size: String(fs.statSync(path.join(rawArchive, 'modrinth.index.json')).size)
        }],
        classification: {
          kind: 'mrpack-server', confidence: 'exact', blocked: false,
          runtime: { minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10' }
        }
      }
    },
    operationKind: 'repair',
    selections: { optionalFileIds: [] },
    serverPath,
    currentState: {
      state: {
        modpackManaged: true,
        runtime: {
          minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10',
          javaMajor: 21, os: 'win32', architecture: 'x64'
        }
      },
      manifest: currentManifest
    },
    liveSnapshot
  });

  const template = outputPaths.get(result.execution.templateOutputId);
  assert.deepEqual(downloads, ['mods/missing.jar']);
  assert.equal(fs.existsSync(path.join(template, 'mods', 'healthy.jar')), false);
  assert.equal(fs.readFileSync(path.join(template, 'mods', 'missing.jar'), 'utf8'), missingBytes.toString());
  assert.deepEqual(result.execution.repairPayloadManifest.entries.map(entry => entry.path), ['mods/missing.jar']);
  assert.deepEqual(result.incomingManifest.entries.map(entry => entry.path), [
    'mods/healthy.jar', 'mods/missing.jar', 'server.jar'
  ]);
});
