const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ArtifactWorkspaceRegistry } = require('../../electron/services/modpacks/artifacts/artifact-workspace-registry.cjs');
const {
  createArtifactSetPlan,
  finalizeVerifiedArtifactSet
} = require('../../electron/services/modpacks/contracts.cjs');
const { createArchiveExtractor } = require('../../electron/services/modpacks/archive/archive-extractor.cjs');
const { createArchiveInspector } = require('../../electron/services/modpacks/archive/archive-inspector.cjs');
const { ArchiveWorkerClient } = require('../../electron/services/modpacks/archive/archive-worker-client.cjs');
const { WindowsReparseInspector } = require('../../electron/services/modpacks/local/windows-reparse-inspector.cjs');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const workerPath = path.join(repositoryRoot, 'vendor', 'archive-worker', 'x64', 'ArchiveWorker.exe');
const workerManifestPath = path.join(repositoryRoot, 'build-resources', 'archive-runtime', 'archive-worker-x64.json');

function digest(algorithm, bytes) {
  return crypto.createHash(algorithm).update(bytes).digest('hex');
}

function corruptFirstZipPayload(bytes) {
  const result = Buffer.from(bytes);
  assert.equal(result.readUInt32LE(0), 0x04034b50, 'fixture must begin with a ZIP local-file header');
  const compressedSize = result.readUInt32LE(18);
  const fileNameLength = result.readUInt16LE(26);
  const extraLength = result.readUInt16LE(28);
  assert.ok(compressedSize > 0, 'fixture must contain an inline compressed payload');
  const payloadOffset = 30 + fileNameLength + extraLength;
  const corruptOffset = payloadOffset + Math.floor(compressedSize / 2);
  assert.ok(corruptOffset < result.length, 'corruption must remain inside the ZIP payload');
  result[corruptOffset] ^= 0xff;
  return result;
}

function verifiedLocalZip(bytes) {
  const sha256 = digest('sha256', bytes);
  const plan = createArtifactSetPlan({
    provider: 'local',
    artifactSet: {
      kind: 'single',
      primaryPartId: 'archive',
      groupingScheme: 'single',
      parts: [{
        partId: 'archive',
        fileName: 'corrupt.zip',
        size: String(bytes.length),
        providerDigest: { algorithm: 'sha256', value: sha256 }
      }],
      providerImmutable: true,
      attestationStatus: 'verified'
    }
  });
  return finalizeVerifiedArtifactSet(plan, [{
    partId: 'archive',
    measuredSize: String(bytes.length),
    sha256,
    sha512: digest('sha512', bytes)
  }]);
}

test('native extraction rejects a CRC-corrupt deferred archive and removes its quarantined output', {
  skip: process.platform !== 'win32' || process.arch !== 'x64',
  timeout: 120_000
}, async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-deferred-integrity-native-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspaces');
  const appOwnedRoot = path.join(root, 'archive-worker');
  const source = await fsp.readFile(path.join(repositoryRoot, 'tests', 'fixtures', 'archives', 'tiny.zip'));
  const corrupt = corruptFirstZipPayload(source);
  const verifiedArtifactSet = verifiedLocalZip(corrupt);
  const cache = {
    retain() {},
    release() {},
    async materializeSet(set, destination, { onDestinationCreated }) {
      await fsp.mkdir(destination);
      onDestinationCreated();
      const primary = set.artifactSet.parts.find(part => part.partId === set.artifactSet.primaryPartId);
      const archivePath = path.join(destination, primary.fileName);
      await fsp.writeFile(archivePath, corrupt);
      return archivePath;
    }
  };
  const registry = new ArtifactWorkspaceRegistry({ root: workspaceRoot, artifactCache: cache });
  const reparseInspector = new WindowsReparseInspector();
  const workerClient = new ArchiveWorkerClient({
    workerPath,
    workerManifestPath,
    resourcesRoot: repositoryRoot,
    workspaceRoot,
    workspaceRegistry: registry,
    reparseInspector,
    appOwnedRoot
  });
  const inspector = createArchiveInspector({
    workspaceRegistry: registry,
    workspaceRoot,
    workerClient
  });
  const inspectionProgress = [];
  const inspection = await inspector.inspectArchive({
    verifiedArtifactSet,
    onProgress: event => inspectionProgress.push(event.phase)
  });

  assert.equal(inspection.integrity, 'deferred-to-extraction');
  assert.equal(inspection.engineEvidence.tested, false);
  assert.deepEqual(inspectionProgress, ['materialize', 'list', 'validate', 'classify', 'complete']);

  const outputId = registry.createStagingOutput({ ownerId: inspection.inspectionId });
  const outputPath = path.join(workspaceRoot, outputId);
  assert.equal(fs.existsSync(outputPath), true);
  const extractor = createArchiveExtractor({
    workspaceRegistry: registry,
    workspaceRoot,
    workerClient,
    reparseInspector
  });

  await assert.rejects(
    extractor.extractArchive({ inspectionId: inspection.inspectionId, destinationId: outputId }),
    error => error?.code === 'EXTRACTOR_FAILED'
  );
  assert.equal(fs.existsSync(outputPath), false, 'failed native extraction must remove the authorized output');

  await registry.releaseOwner(inspection.inspectionId);
  assert.deepEqual(await fsp.readdir(workspaceRoot), []);
});
