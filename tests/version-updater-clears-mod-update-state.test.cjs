const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.resolve(__dirname, '../src/components/settings/VersionUpdater.svelte');

test('VersionUpdater clears global mod update indicators after a successful version update', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';

  assert.match(
    script,
    /import\s+\{\s*clearModUpdateIndicators\s*\}\s+from\s+['"]\.\.\/\.\.\/utils\/mods\/modAPI\.js['"]/,
    'VersionUpdater should import the global mod update-state clearing helper'
  );

  const successBlock = script.match(/updateVersions\(selectedMC,\s*selectedFabric,\s*selectedLoader\);[\s\S]*?updateSummary\s*=/)?.[0] || '';
  assert.match(
    successBlock,
    /clearModUpdateIndicators\(\)/,
    'successful version updates should clear stale Mods-tab update badges and buttons before showing the summary'
  );
});

test('clearModUpdateIndicators clears enabled and disabled update stores', async () => {
  const [{ get }, modApi, modStore] = await Promise.all([
    import('svelte/store'),
    import('../src/utils/mods/modAPI.js'),
    import('../src/stores/modStore.js')
  ]);

  modStore.modsWithUpdates.set(new Map([
    ['stale-mod.jar', { versionNumber: '2.0.0' }],
    ['project:stale-project', { versionNumber: '2.0.0' }]
  ]));
  modStore.disabledModUpdates.set(new Map([
    ['stale-disabled.jar', { latestVersion: '3.0.0' }]
  ]));
  modStore.updateCheckProgress.set({ active: true, current: 1, total: 2, phase: 'Checking installed content' });

  modApi.clearModUpdateIndicators();

  assert.equal(get(modStore.modsWithUpdates).size, 0);
  assert.equal(get(modStore.disabledModUpdates).size, 0);
  assert.deepEqual(get(modStore.updateCheckProgress), { active: false, current: 0, total: 0, phase: '' });
});
