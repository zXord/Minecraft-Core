const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServerMutationPolicy } = require('../../electron/services/server-mutation-policy.cjs');
const { ServerMutationCoordinator } = require('../../electron/services/server-mutation-coordinator.cjs');
const { createClientPackIntegration } = require('../../electron/services/client-modpacks/client-pack-integration.cjs');
const { markCurrentServerMutationDirty } = require('../../electron/services/server-mutation-context.cjs');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
const { HOST_UNREACHABLE_REASON } = require('../../electron/services/management-session-transport.cjs');
const LOCAL_CONTENT_CHANNELS = ['toggle-client-mod', 'delete-client-mod', 'toggle-client-asset', 'delete-client-asset',
  'toggle-manual-mod', 'remove-manual-mods', 'disable-client-mod', 'disable-client-mods', 'clear-client-mod-cache',
  'migrate-client-mod-metadata', 'install-client-mod', 'update-client-mod', 'update-client-mods', 'update-manual-mod',
  'download-client-mod-version-updates'];
function hostUnreachable() {
  const error = new ModpackError('CLIENT_PACK_UNAVAILABLE', 'The matching client requirement could not be read');
  Object.defineProperty(error, 'reason', { value: HOST_UNREACHABLE_REASON });
  return error;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-writer-policy-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = { clientId: 'registered', clientPath: root }; const mod = path.join(root, 'preserve.jar'); fs.writeFileSync(mod, 'original pack');
  const coordinator = new ServerMutationCoordinator({ readContentRevision: () => 0, bumpContentRevision: () => 1 }); coordinator.completeStartupRecovery([]);
  const state = { calls: 0, guards: 0, requirement: { status: 'unpaired' } };
  const integration = createClientPackIntegration({ resolveClient: async () => target, resolveClientByPath: async () => target,
    processGuard: { withMutation: async (_target, work) => { state.guards++; return work(); } },
    transaction: { status: async () => null }, stateStore: { read: async () => null },
    managementClient: { readRequirement: async () => {
      if (state.requirement === 'unreachable') throw hostUnreachable();
      return { descriptor: state.requirement, binding: { generation: 'writer-fixture' } };
    } }, clientPackService: {} });
  const policy = createServerMutationPolicy({ coordinator, getInstances: () => [{ id: 'registered', type: 'client', path: root }],
    getClientPackIntegration: () => integration });
  return { root, mod, state, policy, coordinator, write: async () => { state.calls++; fs.writeFileSync(mod, 'changed'); return true; } };
}
for (const channel of ['minecraft-check-mods', 'minecraft-check-client', 'minecraft-check-client-sync', 'minecraft-download-mods',
  'minecraft-download-assets', 'minecraft-download-client', 'minecraft-clear-client', 'minecraft-clear-client-full', 'minecraft-clear-assets',
  'minecraft-remove-unmanaged-mods', 'minecraft-remove-server-managed-mods', 'minecraft-acknowledge-dependency', 'clear-expected-mod-state',
  'install-client-mod', 'update-client-mod', 'disable-client-mod', 'update-client-mods', 'disable-client-mods',
  'download-client-mod-version-updates', 'clear-client-mod-cache', 'remove-manual-mods', 'toggle-manual-mod', 'update-manual-mod',
  'toggle-client-mod', 'toggle-client-asset', 'delete-client-asset', 'delete-client-mod']) {
  test(`${channel} cannot change managed content using forged empty renderer requirements`, async t => {
    const f = fixture(t);
    await assert.rejects(f.policy.wrapHandler(channel, f.write)(null, { clientPath: f.root, requiredMods: [], serverInfo: null }), { code: 'CLIENT_PACK_UNAVAILABLE' });
    assert.equal(fs.readFileSync(f.mod, 'utf8'), 'original pack'); assert.equal(f.state.calls, 0); assert.equal(f.state.guards, 1);
  });
}
test('with an unreachable host, client-local content edits run once while host-synced mod channels stay refused', async t => {
  for (const channel of LOCAL_CONTENT_CHANNELS) {
    const f = fixture(t); f.state.requirement = 'unreachable';
    const request = channel === 'migrate-client-mod-metadata' ? f.root : { clientPath: f.root };
    assert.equal(await f.policy.wrapHandler(channel, f.write)(null, request), true, channel);
    assert.equal(f.state.calls, 1, channel); assert.equal(f.state.guards, 1, channel);
  }
  for (const channel of ['minecraft-download-mods', 'minecraft-check-mods']) {
    const f = fixture(t); f.state.requirement = 'unreachable';
    await assert.rejects(f.policy.wrapHandler(channel, f.write)(null, { clientPath: f.root }), { code: 'CLIENT_PACK_UNAVAILABLE' });
    assert.equal(f.state.calls, 0, channel); assert.equal(fs.readFileSync(f.mod, 'utf8'), 'original pack');
  }
});
test('unmanaged writer runs under both coordinator and client guard without recursively acquiring either', async t => {
  const f = fixture(t); f.state.requirement = null;
  assert.equal(await f.policy.wrapHandler('minecraft-download-mods', f.write)(null, { clientPath: f.root }), true);
  assert.equal(f.state.guards, 1); assert.equal(f.state.calls, 1);
});
test('server-only path request cannot sidestep managed client guards', async t => {
  const f = fixture(t);
  await assert.rejects(f.policy.wrapHandler('write-eula', f.write)(null, { path: f.root }), { code: 'INVALID_REQUEST' });
  assert.equal(f.state.calls, 0);
});
for (const channel of ['minecraft-save-auth', 'minecraft-check-refresh-auth', 'minecraft-clear-auth']) test(`${channel} remains available without inspecting pack content`, async t => {
  const f = fixture(t);
  assert.equal(await f.policy.wrapHandler(channel, async () => 'saved')(null, { clientPath: f.root }), 'saved');
  assert.equal(f.state.guards, 1);
});
test('connection persistence stays usable but cannot reinitialize a registered client personal server list', async t => {
  const f = fixture(t);
  const result = await f.policy.wrapHandler('save-client-config', async (_event, value) => value.initializeMultiplayer)(null, { path: f.root, initializeMultiplayer: true });
  assert.equal(result, false); assert.equal(f.state.guards, 1);
});

for (const channel of ['disable-client-mod', 'update-client-mod', 'auto-redownload-corrupted-file']) {
  test(`${channel} rejects a second write destination outside the coordinated instance`, async t => {
    const f = fixture(t); f.state.requirement = null;
    const outside = path.join(path.dirname(f.root), 'other-managed-client', 'mods', 'preserve.jar');
    const instances = [{ id: 'registered', type: channel.startsWith('auto-') ? 'server' : 'client', path: f.root }];
    const policy = createServerMutationPolicy({ coordinator: f.coordinator, getInstances: () => instances,
      getClientPackIntegration: () => ({ runLegacyMutation: async (_target, work) => work() }) });
    const payload = { clientPath: f.root, serverPath: f.root, modFilePath: outside, filePath: outside,
      modInfo: { currentFilePath: outside } };
    await assert.rejects(policy.wrapHandler(channel, f.write)(null, payload), { code: 'INVALID_REQUEST' });
    assert.equal(f.state.calls, 0); assert.equal(fs.readFileSync(f.mod, 'utf8'), 'original pack');
  });
}

test('connection persistence never seeds content in an unregistered client folder', async t => {
  const f = fixture(t);
  const policy = createServerMutationPolicy({ coordinator: f.coordinator, getInstances: () => [] });
  const value = await policy.wrapHandler('save-client-config', async (_event, payload) => payload)(null,
    { path: f.root, initializeMultiplayer: true, serverIp: 'saved.example' });
  assert.equal(value.initializeMultiplayer, false); assert.equal(value.serverIp, 'saved.example');
});

test('registry replacement cannot retype a current client as a server before metadata writes', async t => {
  const f = fixture(t);
  await assert.rejects(f.policy.wrapHandler('save-instances', f.write)(null,
    [{ id: 'registered', type: 'server', path: f.root, managementInviteHost: 'example.test' }]), { code: 'INVALID_REQUEST' });
  assert.equal(f.state.calls, 0);
});

for (const channel of ['save-instances', 'write-eula']) test(`${channel} checks independent client ownership even after unregister`, async t => {
  const f = fixture(t); let checked = 0;
  // save-instances inspects the registration it adds; write-eula the registered server it writes.
  const policy = createServerMutationPolicy({ coordinator: f.coordinator,
    getInstances: () => (channel === 'save-instances' ? [] : [{ id: 'server', type: 'server', path: f.root }]),
    getClientPackIntegration: () => ({ async assertServerDestination(value) { assert.equal(value, f.root); checked++; throw Object.assign(new Error('owned'), { code: 'RECOVERY_REQUIRED' }); } }) });
  await assert.rejects(policy.wrapHandler(channel, f.write)(null, channel === 'save-instances'
    ? [{ id: 'server', type: 'server', path: f.root }] : { path: f.root }), { code: 'RECOVERY_REQUIRED' });
  assert.equal(checked, 1); assert.equal(f.state.calls, 0);
});

test('save-instances neither inspects nor reserves a registration it re-lists unchanged', async t => {
  const f = fixture(t); let checked = 0; let reserved = null;
  const registration = { id: 'server', type: 'server', path: f.root };
  const policy = createServerMutationPolicy({ coordinator: f.coordinator, getInstances: () => [registration],
    getClientPackIntegration: () => ({ async assertServerDestination() { checked++; throw Object.assign(new Error('owned'), { code: 'RECOVERY_REQUIRED' }); } }) });
  const result = await policy.wrapHandler('save-instances', async () => {
    reserved = markCurrentServerMutationDirty(f.root);
    return { success: true };
  })(null, [registration]);
  assert.deepEqual(result, { success: true }); assert.equal(checked, 0); assert.equal(reserved, false);
});
