const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServerMutationPolicy } = require('../electron/services/server-mutation-policy.cjs');
const { ServerMutationCoordinator } = require('../electron/services/server-mutation-coordinator.cjs');
const { createServerMutationContext } = require('../electron/services/server-mutation-context.cjs');
const { ModpackStateRepository, createModpackStateObserver } = require('../electron/services/modpacks/state/modpack-state-repository.cjs');
const { createDurableFs } = require('../electron/utils/durable-fs.cjs');

const MANAGED_MESSAGE = 'Individual mod changes are disabled while this server is managed. Use Modpack to change or repair the pack, or review Detach to keep all files and manage mods individually.';
const UNCHECKED_MESSAGE = "Mod changes are paused because this server's modpack ownership could not be checked. Open Modpack to review it, then retry.";

const serverChannels = ['direct-add-mod', 'add-mod', 'install-mod', 'install-mod-with-fallback',
  'download-mod-with-fallback', 'delete-mod', 'update-mod', 'move-mod-file', 'enable-and-update-mod',
  'save-disabled-mods', 'auto-redownload-corrupted-file'];
const aliases = ['install-client-mod', 'update-client-mod', 'disable-client-mod', 'update-client-mods',
  'disable-client-mods', 'download-client-mod-version-updates', 'remove-manual-mods', 'toggle-manual-mod',
  'update-manual-mod', 'toggle-client-mod', 'delete-client-mod', 'minecraft-download-mods',
  'minecraft-check-mods', 'minecraft-remove-unmanaged-mods', 'minecraft-remove-server-managed-mods'];
function fixture(t, managed = true, type = 'server') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-server-edits-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'addon.jar'); fs.writeFileSync(file, 'preserve addon');
  let revision = 0; let calls = 0; let reads = 0;
  const context = createServerMutationContext();
  const coordinator = new ServerMutationCoordinator({ context, readContentRevision: () => revision, bumpContentRevision: () => ++revision });
  coordinator.completeStartupRecovery([]);
  const repository = { read(value) {
    assert.equal(value, root); assert.ok(context.getCurrentMutationLease());
    reads++; if (managed instanceof Error) throw managed;
    return managed === null ? null : { state: { modpackManaged: managed } };
  } };
  const policy = createServerMutationPolicy({ coordinator, getInstances: () => [{ id: 'server-a', type, path: root }],
    getModpackStateRepository: () => repository });
  const write = async () => { calls++; fs.writeFileSync(file, 'changed'); return true; };
  return { root, file, policy, coordinator, write, stats: () => ({ revision, calls, reads }) };
}
function args(channel, root) {
  if (['add-mod', 'install-mod', 'install-mod-with-fallback', 'delete-mod', 'save-disabled-mods'].includes(channel)) return [root, []];
  return [{ serverPath: root, clientPath: root, instanceId: 'server-a', requiredMods: [], serverInfo: null }];
}
for (const paired of [false, true]) for (const channel of [...serverChannels, ...aliases]) {
  test(`${paired ? 'paired' : 'unpaired'} managed server refuses ${channel} without writes or revision changes`, async t => {
    const f = fixture(t);
    const payload = args(channel, f.root);
    if (typeof payload[0] === 'object') payload[0].serverInfo = paired ? { paired: true } : null;
    await assert.rejects(f.policy.wrapHandler(channel, f.write)(null, ...payload), { code: 'MANAGED_MOD_EDIT_BLOCKED', message: MANAGED_MESSAGE });
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'preserve addon');
    assert.deepEqual(f.stats(), { revision: 0, calls: 0, reads: 1 });
  });
}
for (const state of [false, null]) for (const channel of serverChannels) {
  test(`${state === null ? 'absent' : 'detached or files-only'} state permits ${channel}`, async t => {
    const f = fixture(t, state);
    assert.equal(await f.policy.wrapHandler(channel, f.write)(null, ...args(channel, f.root)), true);
    assert.deepEqual(f.stats(), { revision: 1, calls: 1, reads: 1 });
  });
}
test('corrupt ownership refuses writes without claiming the server is managed and does not dirty revision', async t => {
  const f = fixture(t, new Error('unreadable state'));
  await assert.rejects(f.policy.wrapHandler('delete-mod', f.write)(null, f.root, 'addon.jar'), { code: 'MANAGED_MOD_EDIT_BLOCKED', message: UNCHECKED_MESSAGE });
  assert.deepEqual(f.stats(), { revision: 0, calls: 0, reads: 1 });
});
test('expected missing state service fails closed', async t => {
  const f = fixture(t);
  const policy = createServerMutationPolicy({ coordinator: f.coordinator,
    getInstances: () => [{ id: 'server-a', type: 'server', path: f.root }], getModpackStateRepository: () => null });
  await assert.rejects(policy.wrapHandler('delete-mod', f.write)(null, f.root, 'addon.jar'), { code: 'MANAGED_MOD_EDIT_BLOCKED', message: UNCHECKED_MESSAGE });
  assert.equal(f.stats().calls, 0);
});
test('an unmanaged server reached through a junction edits mods through the state observer', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-server-junction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'disk'); fs.mkdirSync(path.join(target, 'Server', 'mods'), { recursive: true });
  fs.writeFileSync(path.join(target, 'Server', 'mods', 'addon.jar'), 'addon');
  const link = path.join(root, 'link'); fs.symlinkSync(target, link, 'junction');
  const serverPath = path.join(link, 'Server');
  const strict = new ModpackStateRepository({ durableFs: createDurableFs({ allowedRoots: [root], durableClient: {
    moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {}
  } }) });
  let revision = 0; let calls = 0;
  const coordinator = new ServerMutationCoordinator({ readContentRevision: () => revision, bumpContentRevision: () => ++revision });
  coordinator.completeStartupRecovery([]);
  const policyFor = repository => createServerMutationPolicy({ coordinator,
    getInstances: () => [{ id: 'server-j', type: 'server', path: serverPath }], getModpackStateRepository: () => repository });
  const write = async () => { calls++; return true; };

  // The strict repository cannot read a folder reached through an alias: refused, honestly.
  await assert.rejects(policyFor(strict).wrapHandler('delete-mod', write)(null, serverPath, 'addon.jar'),
    error => error.code === 'MANAGED_MOD_EDIT_BLOCKED' && error.message === UNCHECKED_MESSAGE && !/is managed/u.test(error.message));
  assert.equal(calls, 0);
  // The observer proves the server has no modpack state.
  const observer = createModpackStateObserver({ repository: strict, fsApi: fs });
  assert.equal(await policyFor(observer).wrapHandler('delete-mod', write)(null, serverPath, 'addon.jar'), true);
  assert.equal(calls, 1);
});
test('mismatched selector rejects before state reads', async t => {
  const f = fixture(t);
  await assert.rejects(f.policy.wrapHandler('update-mod', f.write)(null,
    { serverPath: path.join(f.root, 'other'), instanceId: 'server-a' }), { code: 'INVALID_REQUEST' });
  assert.deepEqual(f.stats(), { revision: 0, calls: 0, reads: 0 });
});
test('genuine client does not read server ownership', async t => {
  const f = fixture(t, true, 'client');
  assert.equal(await f.policy.wrapHandler('toggle-client-mod', f.write)(null, { clientPath: f.root }), true);
  assert.equal(f.stats().reads, 0);
});
for (const channel of ['save-ignored-mod-updates', 'store-file-checksum', 'migrate-server-mod-metadata',
  'delete-shader', 'delete-resourcepack', 'install-shader-with-fallback', 'install-resourcepack-with-fallback',
  'mod-watch:add', 'write-config', 'update-settings']) {
  test(`${channel} is not blocked by server pack management`, async t => {
    const f = fixture(t);
    const positional = ['save-ignored-mod-updates', 'delete-shader', 'delete-resourcepack', 'install-shader-with-fallback', 'install-resourcepack-with-fallback', 'migrate-server-mod-metadata'];
    const payload = positional.includes(channel) ? f.root : { serverPath: f.root, filePath: path.join(f.root, 'mods', 'addon.jar') };
    assert.equal(await f.policy.wrapHandler(channel, async () => true)(null, payload), true);
    assert.equal(f.stats().reads, 0);
  });
}
