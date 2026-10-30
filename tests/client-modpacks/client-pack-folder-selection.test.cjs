const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { createClientPackIntegration } = require('../../electron/services/client-modpacks/client-pack-integration.cjs');
const { CLIENT_PACK_MANIFEST } = require('../../electron/services/modpacks/instance-ownership.cjs');

// A plain client folder may share or nest with a new server folder, as in
// v26.6.1. A client that uses a matching modpack still refuses it.
for (const location of ['root', 'child', 'parent']) for (const matchingPack of [false, true]) test(`server folder initialization with ${location} overlap and ${matchingPack ? 'a matching-pack' : 'a plain'} registered client`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-folder-selection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clientPath = path.join(root, 'client'); fs.mkdirSync(clientPath);
  if (matchingPack) fs.writeFileSync(path.join(clientPath, CLIENT_PACK_MANIFEST), '{}');
  const selected = location === 'root' ? clientPath : location === 'parent' ? root : path.join(clientPath, 'child');
  fs.mkdirSync(selected, { recursive: true });
  const integration = createClientPackIntegration({ resolveClient: async () => null, resolveClientByPath: async () => null,
    transaction: { status: async () => null, assertNoUnsettledAtPath: async () => {} } });
  let writes = 0;
  const originalLoad = Module._load;
  const modulePath = require.resolve('../../electron/ipc/file-handlers.cjs');
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) }, shell: {} };
    if (request.endsWith('utils/app-store.cjs')) return { get: key => key === 'instances' ? [{ id: 'client', type: 'client', path: clientPath }] : null, set() { writes++; } };
    if (request.endsWith('utils/config-manager.cjs')) return { ensureConfigFile() { writes++; } };
    if (request.endsWith('utils/backup-util.cjs')) return {};
    if (request.endsWith('logger-handlers.cjs')) return { getLoggerHandlers: () => ({ info() {}, debug() {}, warn() {}, error() {} }) };
    if (request.endsWith('server-mutation-context.cjs')) return { getServerMutationCoordinator: () => ({ runMutation: async (_target, _options, work) => work({ markDirty() {} }) }) };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[modulePath];
    const handler = require(modulePath).createFileHandlers(null, { assertServerDestination: value => integration.assertServerDestination(value) })['select-folder'];
    if (matchingPack) {
      await assert.rejects(handler(null, {}), { code: 'INVALID_REQUEST' });
      assert.equal(writes, 0); assert.equal(fs.existsSync(path.join(selected, 'mods')), false);
    } else {
      assert.equal(await handler(null, {}), selected);
      assert.equal(writes, 2); assert.equal(fs.existsSync(path.join(selected, 'mods')), true);
    }
    writes = 0;
    assert.equal(await handler(null, { instanceType: 'client' }), selected);
    assert.equal(writes, 0);
  } finally { Module._load = originalLoad; delete require.cache[modulePath]; }
});
