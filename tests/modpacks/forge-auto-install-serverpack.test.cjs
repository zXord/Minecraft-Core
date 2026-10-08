const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  classifyArchive
} = require('../../electron/services/modpacks/archive/archive-classifier.cjs');
const {
  ProductionCandidatePreparer
} = require('../../electron/services/modpacks/planning/production-candidate-preparer.cjs');

const WINDOWS_START = Buffer.from(
  '@echo off\njava -Xmx6024M -Xms1024M -jar minecraft_server.jar nogui\npause\n',
  'utf8'
);
const SHELL_START = Buffer.from(
  '#!/bin/bash\njava -Xmx6024M -Xms1024M -jar minecraft_server.jar nogui',
  'utf8'
);

function config({
  minecraftVersion = '1.20.1',
  loaderType = 'forge',
  loaderVersion = '47.4.13'
} = {}) {
  return Buffer.from([
    '# Forge Auto-Install Configuration',
    '',
    `minecraftVersion=${minecraftVersion}`,
    `loaderType=${loaderType}`,
    `loaderVersion=${loaderVersion}`
  ].join('\n'), 'utf8');
}

function fileEntry(entryPath, bytesOrSize = 1) {
  const size = Buffer.isBuffer(bytesOrSize) ? bytesOrSize.length : bytesOrSize;
  return {
    path: entryPath,
    canonicalPath: entryPath.normalize('NFC').toLocaleLowerCase('en-US'),
    type: 'file',
    size: String(size),
    packedSize: String(size),
    encrypted: false
  };
}

function autoInstallEvidence(configBytes, {
  windowsStart = WINDOWS_START,
  shellStart = SHELL_START
} = {}) {
  const reads = new Map([
    ['forge-auto-install.txt', configBytes],
    ['start_server.bat', windowsStart],
    ['start_server.sh', shellStart]
  ]);
  return {
    entries: [
      fileEntry('forge-auto-install.txt', configBytes),
      fileEntry('minecraft_server.jar', 117785),
      fileEntry('server_starter.conf', 924),
      fileEntry('start_server.bat', windowsStart),
      fileEntry('start_server.sh', shellStart),
      fileEntry('mods/pack.jar', 16)
    ],
    async readEntry(entryName, { maxBytes }) {
      const bytes = reads.get(entryName);
      assert.ok(bytes, `classifier must not read untrusted ${entryName}`);
      assert.ok(bytes.length <= maxBytes);
      return bytes;
    }
  };
}

test('strict Forge Auto-Install evidence selects an exact managed Forge runtime without trusting its bootstrap', async () => {
  const result = await classifyArchive(autoInstallEvidence(config()));

  assert.deepEqual(result, {
    kind: 'prepared-server-pack',
    confidence: 'exact',
    blocked: false,
    runtime: {
      minecraftVersion: '1.20.1',
      loaderFamily: 'forge',
      loaderVersion: '47.4.13'
    },
    suppliedBootstrapExecuted: false,
    evidence: [
      { kind: 'forge-auto-install-config', entryName: 'forge-auto-install.txt' },
      { kind: 'ignored-publisher-bootstrap', entryName: 'minecraft_server.jar' },
      { kind: 'convenience-script', entryName: 'start_server.bat' },
      { kind: 'convenience-script', entryName: 'start_server.sh' }
    ]
  });
  assert.equal(Object.isFrozen(result), true);
});

test('strict Forge Auto-Install evidence also accepts one exact NeoForge runtime', async () => {
  const result = await classifyArchive(autoInstallEvidence(config({
    minecraftVersion: '1.20.4',
    loaderType: 'NeoForge',
    loaderVersion: '20.4.164-beta'
  })));

  assert.deepEqual(result.runtime, {
    minecraftVersion: '1.20.4',
    loaderFamily: 'neoforge',
    loaderVersion: '20.4.164-beta'
  });
  assert.equal(result.kind, 'prepared-server-pack');
  assert.equal(result.suppliedBootstrapExecuted, false);
});

test('malformed, duplicate, open-ended, and unsupported Forge Auto-Install values stay blocked', async t => {
  const cases = [
    ['missing field', 'minecraftVersion=1.20.1\nloaderType=forge\n'],
    ['duplicate field', 'minecraftVersion=1.20.1\nloaderType=forge\nloaderVersion=47.4.13\nloaderVersion=47.4.14\n'],
    ['unknown field', 'minecraftVersion=1.20.1\nloaderType=forge\nloaderVersion=47.4.13\njavaArgs=-Xmx8G\n'],
    ['unsupported loader', 'minecraftVersion=1.20.1\nloaderType=fabric\nloaderVersion=0.16.10\n'],
    ['moving Minecraft target', 'minecraftVersion=latest\nloaderType=forge\nloaderVersion=47.4.13\n'],
    ['moving loader target', 'minecraftVersion=1.20.1\nloaderType=forge\nloaderVersion=recommended\n'],
    ['non-version loader target', 'minecraftVersion=1.20.1\nloaderType=forge\nloaderVersion=47.4.13;calc.exe\n']
  ];

  for (const [name, text] of cases) {
    await t.test(name, async () => {
      const result = await classifyArchive(autoInstallEvidence(Buffer.from(text, 'utf8')));
      assert.equal(result.kind, 'unsupported-runtime-layout');
      assert.equal(result.blocked, true);
      assert.equal(result.reasonCode, 'invalid-forge-auto-install-config');
      assert.equal(result.runtime, undefined);
    });
  }
});

test('Forge Auto-Install metadata is rejected when either launcher script targets another jar', async () => {
  const result = await classifyArchive(autoInstallEvidence(config(), {
    windowsStart: Buffer.from('@echo off\njava -Xmx6024M -Xms1024M -jar custom.jar nogui\npause\n', 'utf8')
  }));

  assert.equal(result.kind, 'unsupported-runtime-layout');
  assert.equal(result.blocked, true);
  assert.equal(result.reasonCode, 'forge-auto-install-evidence-mismatch');
  assert.equal(result.runtime, undefined);
});

test('Forge Auto-Install candidates preserve pack payload but omit every publisher bootstrap input', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-forge-auto-candidate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'archive');
  const workspaces = path.join(root, 'workspaces');
  const writes = new Map([
    ['forge-auto-install.txt', config()],
    ['minecraft_server.jar', Buffer.from('untrusted publisher bootstrap')],
    ['server_starter.conf', Buffer.from('java_path=java\n')],
    ['start_server.bat', WINDOWS_START],
    ['start_server.sh', SHELL_START],
    ['README.md', Buffer.from('publisher instructions')],
    ['mods/pack.jar', Buffer.from('pack mod')],
    ['config/pack.toml', Buffer.from('enabled=true\n')],
    ['defaultconfigs/tfc-server.toml', Buffer.from('torchTicks=24000\n')],
    ['tacz/gunpack.zip', Buffer.from('trusted-as-reviewed-data-not-executed')],
    ['DiscordIntegration-Data/Messages.toml', Buffer.from('message=hello\n')],
    ['server.properties', Buffer.from('motd=TFG\n')],
    ['libraries/net/minecraftforge/untrusted.jar', Buffer.from('untrusted supplied runtime')]
  ]);
  for (const [relative, bytes] of writes) {
    const target = path.join(archive, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }

  let sequence = 0;
  const outputPaths = new Map();
  const workspaceRegistry = {
    createStagingOutput() {
      const id = `output-${++sequence}`;
      const outputPath = path.join(workspaces, id);
      fs.mkdirSync(outputPath, { recursive: true });
      outputPaths.set(id, outputPath);
      return id;
    },
    resolveOwnedWorkspace({ id }) {
      return { id, kind: 'output', path: outputPaths.get(id) };
    }
  };
  const preparer = new ProductionCandidatePreparer({
    workspaceRegistry,
    archiveExtractor: {
      async extractArchive({ destinationId }) {
        for (const name of await fsp.readdir(archive)) {
          await fsp.cp(path.join(archive, name), path.join(outputPaths.get(destinationId), name), {
            recursive: true,
            force: false,
            errorOnExist: true
          });
        }
      }
    },
    artifactDownloader: { async downloadPart() { throw new Error('not an MRPACK'); } },
    artifactCache: { pathForSha256() { throw new Error('not an MRPACK'); } },
    reparseInspector: { async isReparsePoint() { return false; } },
    randomUUID: () => '00000000-0000-4000-8000-000000000004'
  });
  t.after(() => preparer.dispose());

  const result = await preparer.preparePlanInputs({
    inspection: {
      inspectionId: 'inspection-forge-auto',
      result: {
        selectedRoot: null,
        entries: [],
        classification: {
          kind: 'prepared-server-pack',
          confidence: 'exact',
          blocked: false,
          runtime: {
            minecraftVersion: '1.20.1',
            loaderFamily: 'forge',
            loaderVersion: '47.4.13'
          },
          suppliedBootstrapExecuted: false,
          evidence: []
        }
      }
    },
    selections: { optionalFileIds: [] }
  });
  const template = outputPaths.get(result.execution.templateOutputId);

  assert.deepEqual(result.runtime, {
    minecraftVersion: '1.20.1',
    loaderFamily: 'forge',
    loaderVersion: '47.4.13',
    javaMajor: 17,
    os: 'win32',
    architecture: 'x64'
  });
  for (const relative of [
    'forge-auto-install.txt', 'minecraft_server.jar', 'server_starter.conf',
    'start_server.bat', 'start_server.sh', 'README.md', 'libraries'
  ]) {
    assert.equal(fs.existsSync(path.join(template, ...relative.split('/'))), false, `${relative} must be omitted`);
  }
  for (const relative of [
    'mods/pack.jar', 'config/pack.toml', 'defaultconfigs/tfc-server.toml',
    'tacz/gunpack.zip', 'DiscordIntegration-Data/Messages.toml', 'server.properties'
  ]) {
    assert.deepEqual(fs.readFileSync(path.join(template, ...relative.split('/'))), writes.get(relative));
  }
  assert.deepEqual(result.incomingManifest.entries.map(entry => entry.path), [
    'config/pack.toml',
    'defaultconfigs/tfc-server.toml',
    'DiscordIntegration-Data/Messages.toml',
    'mods/pack.jar',
    'server.properties',
    'tacz/gunpack.zip'
  ]);
});
