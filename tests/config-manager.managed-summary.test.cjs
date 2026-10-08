const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const RUNTIME = Object.freeze({
  minecraftVersion: '1.20.1',
  loaderFamily: 'fabric',
  loaderVersion: '0.15.11',
  javaMajor: 17,
  os: 'win32',
  architecture: 'x64'
});

test('managed summaries are returned exactly without synchronous jar or loader inspection', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-managed-summary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'server.jar'), Buffer.from('inspection must not open this jar'));
  fs.writeFileSync(path.join(root, '.minecraft-core.json'), JSON.stringify({
    modpackManaged: true,
    runtime: RUNTIME,
    version: RUNTIME.minecraftVersion,
    loader: RUNTIME.loaderFamily,
    loaderVersion: RUNTIME.loaderVersion,
    javaVersion: RUNTIME.javaMajor,
    port: 25565,
    maxRam: 6
  }));

  const configPath = path.resolve(__dirname, '../electron/utils/config-manager.cjs');
  const originalLoad = Module._load;
  let archiveInspections = 0;
  let loaderInspections = 0;
  Module._load = function mockLoad(request, parent, isMain) {
    if (parent?.filename === configPath && request === 'adm-zip') {
      return class ForbiddenArchiveInspection {
        constructor() {
          archiveInspections += 1;
          throw new Error('managed jar inspection is forbidden');
        }
      };
    }
    if (parent?.filename === configPath && request === './server-loader.cjs') {
      return {
        resolveServerLoader() {
          loaderInspections += 1;
          throw new Error('managed loader inspection is forbidden');
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[configPath];
  t.after(() => {
    delete require.cache[configPath];
    Module._load = originalLoad;
  });

  const { readServerConfig } = require(configPath);
  const config = readServerConfig(root);

  assert.equal(archiveInspections, 0);
  assert.equal(loaderInspections, 0);
  assert.equal(config.modpackManaged, true);
  assert.deepEqual(config.runtime, RUNTIME);
  assert.equal(config.version, RUNTIME.minecraftVersion);
  assert.equal(config.loader, RUNTIME.loaderFamily);
  assert.equal(config.loaderVersion, RUNTIME.loaderVersion);
});
