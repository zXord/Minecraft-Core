const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProductionCandidatePreparer
} = require('../../electron/services/modpacks/planning/production-candidate-preparer.cjs');

function archiveEntries(root) {
  const result = [];
  function visit(directory, relative = '') {
    const children = fs.readdirSync(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
    for (const child of children) {
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      const childPath = path.join(directory, child.name);
      const stat = fs.statSync(childPath);
      result.push({ path: childRelative, type: child.isDirectory() ? 'directory' : 'file', size: String(child.isFile() ? stat.size : 0) });
      if (child.isDirectory()) visit(childPath, childRelative);
    }
  }
  visit(root);
  return result;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-guided-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'archive');
  const workspaces = path.join(root, 'workspaces');
  fs.mkdirSync(archive);
  fs.mkdirSync(workspaces);
  let sequence = 0;
  const outputs = new Map();
  const workspaceRegistry = {
    createStagingOutput() {
      const id = `output-${++sequence}`;
      const output = path.join(workspaces, id);
      fs.mkdirSync(output);
      outputs.set(id, output);
      return id;
    },
    resolveOwnedWorkspace({ id }) { return { id, kind: 'output', path: outputs.get(id) }; }
  };
  const preparer = new ProductionCandidatePreparer({
    workspaceRegistry,
    archiveExtractor: {
      async extractArchive({ destinationId }) {
        for (const name of await fsp.readdir(archive)) {
          await fsp.cp(path.join(archive, name), path.join(outputs.get(destinationId), name), {
            recursive: true, force: false, errorOnExist: true
          });
        }
      }
    },
    artifactDownloader: { async downloadPart() { throw new Error('not an MRPACK fixture'); } },
    artifactCache: { pathForSha256() { throw new Error('not an MRPACK fixture'); } },
    reparseInspector: { async isReparsePoint() { return false; } },
    randomUUID: () => `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
  });
  return { archive, outputs, preparer };
}

test('guided review binds one reviewed archive root and exact app-built runtime', async t => {
  const current = fixture(t);
  for (const [rootName, marker] of [['server-a', 'a'], ['server-b', 'b']]) {
    fs.mkdirSync(path.join(current.archive, rootName, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(current.archive, rootName, 'mods', `${marker}.jar`), marker);
    fs.writeFileSync(path.join(current.archive, rootName, 'server.jar'), `untrusted-${marker}`);
  }
  const result = await current.preparer.preparePlanInputs({
    inspection: {
      inspectionId: 'inspection-guided-root',
      result: {
        rootCandidates: ['server-a', 'server-b'], selectedRoot: null,
        entries: archiveEntries(current.archive),
        classification: { kind: 'ambiguous-or-unknown', confidence: 'multiple-roots', blocked: true }
      }
    },
    operationKind: 'install',
    selections: {
      optionalFileIds: [], selectedRoot: 'server-b',
      runtimeChoice: { minecraftVersion: '1.21.1', loaderFamily: 'vanilla', loaderVersion: '1.21.1' }
    }
  });

  const template = current.outputs.get(result.execution.templateOutputId);
  assert.equal(fs.readFileSync(path.join(template, 'mods', 'b.jar'), 'utf8'), 'b');
  assert.equal(fs.existsSync(path.join(template, 'mods', 'a.jar')), false);
  assert.equal(fs.existsSync(path.join(template, 'server.jar')), false);
  assert.deepEqual(result.runtime, {
    minecraftVersion: '1.21.1', loaderFamily: 'vanilla', loaderVersion: '1.21.1',
    javaMajor: 21, os: 'win32', architecture: 'x64'
  });
  assert.equal(result.inspectionResult.selectedRoot, 'server-b');
  assert.equal(result.inspectionResult.classification.kind, 'prepared-server-pack');
  assert.equal(result.inspectionResult.classification.confidence, 'exact');
});

test('guided Fabric installer-bundle review canonicalizes only the legacy profile mappings suffix', async t => {
  const current = fixture(t);
  fs.mkdirSync(path.join(current.archive, 'mods'));
  fs.writeFileSync(path.join(current.archive, 'mods', 'pack.jar'), 'pack');
  const selections = {
    optionalFileIds: [], selectedRoot: null,
    runtimeChoice: {
      minecraftVersion: '1.14.4', loaderFamily: 'fabric',
      loaderVersion: '1.14.4+build.12_yarn-0.6.1+build.165'
    }
  };

  const result = await current.preparer.preparePlanInputs({
    inspection: {
      inspectionId: 'inspection-legacy-fabric-profile',
      result: {
        rootCandidates: [], selectedRoot: null, entries: archiveEntries(current.archive),
        classification: { kind: 'loader-installer-bundle', confidence: 'exact', blocked: false }
      }
    },
    operationKind: 'install',
    selections
  });

  assert.equal(result.runtime.loaderVersion, '0.6.1+build.165');
  assert.equal(result.inspectionResult.classification.runtime.loaderVersion, '0.6.1+build.165');
  assert.deepEqual(result.runtimeChoice, {
    minecraftVersion: '1.14.4', loaderFamily: 'fabric', loaderVersion: '0.6.1+build.165'
  });
  assert.equal(selections.runtimeChoice.loaderVersion, '1.14.4+build.12_yarn-0.6.1+build.165');
});

test('files-only review imports only the non-executable safe payload and requires no runtime', async t => {
  const current = fixture(t);
  fs.mkdirSync(path.join(current.archive, 'config'));
  fs.writeFileSync(path.join(current.archive, 'config', 'pack.toml'), 'enabled=true\n');
  fs.writeFileSync(path.join(current.archive, 'README.txt'), 'read me\n');
  fs.writeFileSync(path.join(current.archive, 'run.bat'), 'never execute\r\n');
  fs.writeFileSync(path.join(current.archive, 'server.jar'), 'never adopt');

  const result = await current.preparer.preparePlanInputs({
    inspection: {
      inspectionId: 'inspection-files-only',
      result: {
        rootCandidates: [], selectedRoot: null,
        entries: archiveEntries(current.archive),
        classification: { kind: 'ambiguous-or-unknown', confidence: 'insufficient', blocked: true }
      }
    },
    operationKind: 'files-only',
    selections: { optionalFileIds: [], selectedRoot: null, runtimeChoice: null }
  });

  const template = current.outputs.get(result.execution.templateOutputId);
  assert.equal(fs.readFileSync(path.join(template, 'config', 'pack.toml'), 'utf8'), 'enabled=true\n');
  for (const forbidden of ['README.txt', 'run.bat', 'server.jar']) assert.equal(fs.existsSync(path.join(template, forbidden)), false);
  assert.equal(result.runtime, null);
  assert.equal(result.inspectionResult.classification.kind, 'files-only');
  assert.deepEqual(result.incomingManifest.entries.map(entry => entry.path), ['config/pack.toml']);
});

test('files-only root review reclassifies the archive inspector public entry shape', async t => {
  const current = fixture(t);
  fs.mkdirSync(path.join(current.archive, 'unusual-layout', 'config'), { recursive: true });
  fs.writeFileSync(path.join(current.archive, 'unusual-layout', 'config', 'pack.toml'), 'enabled=true\n');
  fs.writeFileSync(path.join(current.archive, 'unusual-layout', 'run.cmd'), 'never execute\r\n');
  const publicEntries = archiveEntries(current.archive).map(entry => ({
    entryName: entry.path,
    canonicalName: entry.path.toLocaleLowerCase('en-US'),
    type: entry.type,
    size: entry.size,
    packedSize: entry.size,
    depth: entry.path.split('/').length,
    nameLength: entry.path.length
  }));

  const result = await current.preparer.preparePlanInputs({
    inspection: {
      inspectionId: 'inspection-files-only-public-entries',
      result: {
        rootCandidates: ['unusual-layout'], selectedRoot: 'unusual-layout',
        entries: publicEntries,
        classification: {
          kind: 'unsupported-runtime-layout', confidence: 'exact', blocked: true,
          reasonCode: 'custom-bootstrap-required'
        }
      }
    },
    operationKind: 'files-only',
    selections: { optionalFileIds: [], selectedRoot: 'unusual-layout', runtimeChoice: null }
  });

  const template = current.outputs.get(result.execution.templateOutputId);
  assert.equal(fs.readFileSync(path.join(template, 'config', 'pack.toml'), 'utf8'), 'enabled=true\n');
  assert.equal(fs.existsSync(path.join(template, 'run.cmd')), false);
  assert.equal(result.runtime, null);
  assert.equal(result.inspectionResult.classification.kind, 'files-only');
});

test('guided runtime choices never override client-only, backup, or custom-bootstrap classifications', async t => {
  const blockedKinds = ['mrpack-client-only', 'multimc-client-only', 'backup-archive', 'unsupported-runtime-layout'];
  for (const [index, kind] of blockedKinds.entries()) {
    await t.test(kind, async () => {
      const current = fixture(t);
      fs.mkdirSync(path.join(current.archive, `blocked-${index}`, 'mods'), { recursive: true });
      fs.writeFileSync(path.join(current.archive, `blocked-${index}`, 'mods', 'pack.jar'), 'pack');
      await assert.rejects(current.preparer.preparePlanInputs({
        inspection: {
          inspectionId: `inspection-${kind}`,
          result: {
            rootCandidates: [], selectedRoot: null,
            entries: archiveEntries(current.archive),
            classification: { kind, confidence: 'exact', blocked: true }
          }
        },
        operationKind: 'install',
        selections: {
          optionalFileIds: [], selectedRoot: null,
          runtimeChoice: { minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14' }
        }
      }), error => error?.code === (kind.endsWith('client-only') ? 'CLIENT_ONLY_PACK' : 'UNSUPPORTED_ARCHIVE'));
    });
  }
});

test('client-only and Minecraft Core backup archives remain blocked even for files-only imports', async t => {
  const blockedKinds = ['mrpack-client-only', 'multimc-client-only', 'backup-archive'];
  for (const [index, kind] of blockedKinds.entries()) {
    await t.test(kind, async () => {
      const current = fixture(t);
      fs.mkdirSync(path.join(current.archive, `blocked-files-only-${index}`, 'mods'), { recursive: true });
      fs.writeFileSync(path.join(current.archive, `blocked-files-only-${index}`, 'mods', 'pack.jar'), 'pack');
      await assert.rejects(current.preparer.preparePlanInputs({
        inspection: {
          inspectionId: `inspection-files-only-${kind}`,
          result: {
            rootCandidates: [], selectedRoot: null,
            entries: archiveEntries(current.archive),
            classification: { kind, confidence: 'exact', blocked: true }
          }
        },
        operationKind: 'files-only',
        selections: { optionalFileIds: [], selectedRoot: null, runtimeChoice: null }
      }), error => error?.code === (kind.endsWith('client-only') ? 'CLIENT_ONLY_PACK' : 'UNSUPPORTED_ARCHIVE'));
    });
  }
});

test('selecting the .minecraft subtree cannot turn a recognized MultiMC client export into a server pack', async t => {
  const current = fixture(t);
  fs.mkdirSync(path.join(current.archive, '.minecraft', 'mods'), { recursive: true });
  fs.mkdirSync(path.join(current.archive, 'flame'), { recursive: true });
  fs.writeFileSync(path.join(current.archive, '.minecraft', 'mods', 'client.jar'), 'client');
  fs.writeFileSync(path.join(current.archive, 'instance.cfg'), 'InstanceType=OneSix\n');
  fs.writeFileSync(path.join(current.archive, 'mmc-pack.json'), '{"formatVersion":1}\n');

  await assert.rejects(current.preparer.preparePlanInputs({
    inspection: {
      inspectionId: 'inspection-multimc-selected-root',
      result: {
        rootCandidates: ['.minecraft', 'flame'], selectedRoot: null,
        entries: archiveEntries(current.archive),
        classification: {
          kind: 'multimc-client-only', confidence: 'exact', blocked: true,
          reasonCode: 'client-launcher-instance'
        }
      }
    },
    operationKind: 'install',
    selections: {
      optionalFileIds: [], selectedRoot: '.minecraft',
      runtimeChoice: { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.4.10' }
    }
  }), error => error?.code === 'CLIENT_ONLY_PACK');
});
