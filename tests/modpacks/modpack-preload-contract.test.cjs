const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

const INVOKES = [
  'client-packs:get-companion', 'client-packs:list-companion-assets', 'client-packs:inspect-companion',
  'client-packs:accept-companion', 'client-packs:get-state', 'client-packs:preview', 'client-packs:install',
  'client-packs:cancel', 'client-packs:verify', 'client-packs:recover',
  'modpacks:search-catalog', 'modpacks:get-project', 'modpacks:list-versions', 'modpacks:list-github-releases',
  'modpacks:list-github-assets', 'modpacks:select-local-archive', 'modpacks:reserve-server-destination',
  'modpacks:release-server-destination', 'modpacks:inspect', 'modpacks:cancel-inspection', 'modpacks:preflight',
  'modpacks:preflight-management', 'modpacks:start-operation', 'modpacks:cancel-job', 'modpacks:get-job', 'modpacks:get-active-jobs', 'modpacks:get-state',
  'modpacks:list-history', 'modpacks:list-rollback-options', 'modpacks:list-recovery', 'modpacks:recover', 'modpacks:list-notifications',
  'modpacks:ack-notification', 'modpacks:check-updates', 'modpacks:update-tracking', 'modpacks:verify',
  'modpacks:perform-safe-action'
];
const EVENTS = ['client-packs:progress', 'modpacks:job-progress', 'modpacks:job-log', 'modpacks:state-changed', 'modpacks:notification', 'modpacks:inspection-progress'];

function loadPreload() {
  const modulePath = path.resolve(__dirname, '../../electron/preload.cjs');
  const originalLoad = Module._load;
  const exposed = {};
  const calls = [];
  const listeners = new Map();
  const ipcRenderer = {
    invoke(channel, ...args) { calls.push(['invoke', channel, args]); return Promise.resolve(channel); },
    on(channel, listener) { calls.push(['on', channel]); listeners.set(channel, listener); },
    removeListener(channel, listener) { calls.push(['removeListener', channel, listener]); },
    removeAllListeners(channel) { calls.push(['removeAllListeners', channel]); }
  };
  Module._load = function loadFixture(request, parent, isMain) {
    if (request === 'electron') return {
      ipcRenderer,
      contextBridge: { exposeInMainWorld(name, value) { exposed[name] = value; } }
    };
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[modulePath];
  try { require(modulePath); }
  finally { delete require.cache[modulePath]; Module._load = originalLoad; }
  return { calls, electron: exposed.electron };
}

test('all lifecycle invoke and event channels are symmetrically allowlisted', async () => {
  const fixture = loadPreload();
  for (const channel of INVOKES) assert.equal(await fixture.electron.invoke(channel, {}), channel);
  for (const channel of EVENTS) {
    const listener = () => {};
    fixture.electron.on(channel, listener);
    fixture.electron.removeListener(channel, listener);
    fixture.electron.removeAllListeners(channel);
  }
  for (const channel of INVOKES) assert.equal(fixture.calls.some(call => call[0] === 'invoke' && call[1] === channel), true, channel);
  for (const channel of EVENTS) {
    assert.equal(fixture.calls.some(call => call[0] === 'on' && call[1] === channel), true, `${channel}:on`);
    assert.equal(fixture.calls.some(call => call[0] === 'removeListener' && call[1] === channel), true, `${channel}:removeListener`);
    assert.equal(fixture.calls.some(call => call[0] === 'removeAllListeners' && call[1] === channel), true, `${channel}:removeAllListeners`);
  }
});
