const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProductionCandidatePreparer
} = require('../../electron/services/modpacks/planning/production-candidate-preparer.cjs');

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
        entries: [{ path: 'modrinth.index.json', type: 'file', size: String(fs.statSync(path.join(rawArchive, 'modrinth.index.json')).size) }],
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
