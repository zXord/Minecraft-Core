const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

for (const location of ['root', 'child', 'parent']) test(`server folder initialization refuses ${location} overlap with a registered client`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-folder-selection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clientPath = path.join(root, 'client'); fs.mkdirSync(clientPath);
  const selected = location === 'root' ? clientPath : location === 'parent' ? root : path.join(clientPath, 'child');
  fs.mkdirSync(selected, { recursive: true });
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
    const handler = require(modulePath).createFileHandlers(null)['select-folder'];
    await assert.rejects(handler(null, {}), { code: 'INVALID_REQUEST' });
    assert.equal(writes, 0); assert.equal(fs.existsSync(path.join(selected, 'mods')), false);
    assert.equal(await handler(null, { instanceType: 'client' }), selected);
    assert.equal(writes, 0);
  } finally { Module._load = originalLoad; delete require.cache[modulePath]; }
});
