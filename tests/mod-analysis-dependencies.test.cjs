const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const {
  extractDependencyListFromJar
} = require('../electron/ipc/mod-utils/mod-analysis-utils.cjs');

async function writeJar(root, fileName, entries) {
  const filePath = path.join(root, fileName);
  const zip = new AdmZip();
  for (const [entryName, content] of Object.entries(entries)) {
    zip.addFile(entryName, Buffer.from(content));
  }
  await fsp.writeFile(filePath, zip.toBuffer());
  return filePath;
}

test('Fabric JAR dependency fallback returns required dependency entries', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-fabric-deps-'));
  try {
    const jarPath = await writeJar(root, 'fabric-parent.jar', {
      'fabric.mod.json': JSON.stringify({
        schemaVersion: 1,
        id: 'fabric_parent',
        version: '1.0.0',
        name: 'Fabric Parent',
        depends: {
          fabricloader: '>=0.15.0',
          minecraft: '1.20.1',
          fabric_api: '*',
          cloth_config: '>=11.0.0'
        },
        recommends: {
          modmenu: '*'
        }
      })
    });

    const deps = await extractDependencyListFromJar(jarPath);

    assert.deepEqual(deps, [
      {
        id: 'fabric-api',
        dependency_type: 'required',
        version_requirement: '*',
        source: 'fabric.mod.json'
      },
      {
        id: 'cloth_config',
        dependency_type: 'required',
        version_requirement: '>=11.0.0',
        source: 'fabric.mod.json'
      },
      {
        id: 'modmenu',
        dependency_type: 'optional',
        version_requirement: '*',
        source: 'fabric.mod.json'
      }
    ]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('Forge JAR dependency fallback parses mods.toml dependency sections', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-forge-deps-'));
  try {
    const jarPath = await writeJar(root, 'forge-parent.jar', {
      'META-INF/mods.toml': [
        'modLoader="javafml"',
        'loaderVersion="[47,)"',
        'license="MIT"',
        '',
        '[[mods]]',
        'modId="forge_parent"',
        'version="1.0.0"',
        'displayName="Forge Parent"',
        '',
        '[[dependencies.forge_parent]]',
        'modId="forge"',
        'mandatory=true',
        'versionRange="[47,)"',
        'ordering="NONE"',
        'side="BOTH"',
        '',
        '[[dependencies.forge_parent]]',
        'modId="minecraft"',
        'mandatory=true',
        'versionRange="[1.20.1,1.21)"',
        'ordering="NONE"',
        'side="BOTH"',
        '',
        '[[dependencies.forge_parent]]',
        'modId="moonlight"',
        'mandatory=true',
        'versionRange="[2.0.0,)"',
        'ordering="AFTER"',
        'side="BOTH"',
        '',
        '[[dependencies.forge_parent]]',
        'modId="jei"',
        'mandatory=false',
        'versionRange="[15.0.0,)"',
        'ordering="NONE"',
        'side="BOTH"'
      ].join('\n')
    });

    const deps = await extractDependencyListFromJar(jarPath);

    assert.deepEqual(deps, [
      {
        id: 'moonlight',
        dependency_type: 'required',
        version_requirement: '[2.0.0,)',
        source: 'META-INF/mods.toml'
      },
      {
        id: 'jei',
        dependency_type: 'optional',
        version_requirement: '[15.0.0,)',
        source: 'META-INF/mods.toml'
      }
    ]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
