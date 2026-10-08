const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { clientDurableRouter } = require('../../electron/bootstrap/create-client-pack-composition.cjs');
test('late registered clients receive scoped durability while unrelated paths remain refused', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-durable-routing-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'app'); const clientParent = path.join(temp, 'instances'); const client = path.join(clientParent, 'client');
  fs.mkdirSync(root); fs.mkdirSync(client, { recursive: true });
  let instances = []; const scopes = [];
  const router = clientDurableRouter({ root, getInstances: () => instances, durableFsFactory: roots => {
    scopes.push(roots); return createDurableFs({ allowedRoots: roots, durableClient: {
      moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {},
      moveWriteThroughAsync: fs.promises.rename, replaceFileWriteThroughAsync: fs.promises.rename, async flushDirectoryAsync() {} } });
  } });
  assert.throws(() => router.writeJsonAtomicAsync(path.join(client, 'state.json'), {}), { code: 'CLIENT_PACK_UNAVAILABLE' });
  instances = [{ id: 'new', type: 'client', path: client }];
  await router.writeJsonAtomicAsync(path.join(client, 'state.json'), { installed: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(client, 'state.json'))), { installed: true });
  assert.deepEqual(scopes[0], [root, clientParent].sort());
  assert.throws(() => router.readFileBoundedAsync(path.join(temp, 'unrelated.json')), { code: 'CLIENT_PACK_UNAVAILABLE' });
  instances = [];
  assert.throws(() => router.writeJsonAtomicAsync(path.join(client, 'state.json'), {}), { code: 'CLIENT_PACK_UNAVAILABLE' });
});
