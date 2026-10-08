const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMrpackClientPlan, listOptionalClientFileChoices, resolveOptionalClientFileChoiceIds,
  listOptionalFileChoices
} = require('../../electron/services/modpacks/mrpack/mrpack-file-plan.cjs');

function file(path, client = 'required', server = 'unsupported') {
  return { path, env: { client, server }, hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
    downloads: ['https://cdn.modrinth.com/example.jar'], fileSize: 7 };
}
function manifest(files = [file('mods/client.jar')]) {
  return { formatVersion: 1, game: 'minecraft', versionId: 'v1', name: 'Client pack', files,
    dependencies: { minecraft: '1.20.1', forge: '47.3.12' } };
}
const entry = (path, type = 'file') => ({ path, type, size: 7 });

// A server-environment branch accidentally reused for clients loses the required client-only JAR.
test('client projection includes client-required downloads and excludes server-only downloads', () => {
  const plan = buildMrpackClientPlan({ manifest: manifest([
    file('mods/client.jar'), file('mods/server.jar', 'unsupported', 'required')
  ]) });
  assert.equal(plan.type, 'mrpack-client-plan');
  assert.deepEqual(plan.downloads.map(item => item.targetPath), ['mods/client.jar']);
  assert.equal(plan.downloads[0].selected, true);
  assert.deepEqual(plan.downloads[0].requiredProviderDigests, { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) });
  assert.deepEqual(plan.runtime, { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12' });
});

// Selecting by server optionality either exposes a server-only ID or rejects the client choice.
test('client optional choices and selection are independent of the server environment', () => {
  const pack = manifest([file('mods/required.jar'), file('mods/client-optional.jar', 'optional'),
    file('mods/server-optional.jar', 'unsupported', 'optional')]);
  const choices = listOptionalClientFileChoices(pack);
  assert.deepEqual(choices.map(({ label, defaultSelected }) => ({ label, defaultSelected })), [
    { label: 'mods/client-optional.jar', defaultSelected: true }
  ]);
  assert.deepEqual(resolveOptionalClientFileChoiceIds(pack, [choices[0].id]), ['mods/client-optional.jar']);
  assert.throws(() => resolveOptionalClientFileChoiceIds(pack, [listOptionalFileChoices(pack)[0].id]), { code: 'INVALID_REQUEST' });
  assert.throws(() => resolveOptionalClientFileChoiceIds(pack, [choices[0].id, choices[0].id]), { code: 'INVALID_REQUEST' });
  assert.equal(buildMrpackClientPlan({ manifest: pack }).downloads[1].selected, true);
  assert.equal(buildMrpackClientPlan({ manifest: pack, selectedOptionalFiles: [] }).downloads[1].selected, false);
  assert.equal(buildMrpackClientPlan({ manifest: pack, selectedOptionalFiles: ['MODS\\CLIENT-OPTIONAL.JAR'] }).downloads[1].selected, true);
});

// Reversing layer order or applying server overrides changes the actual client configuration.
test('client overrides replace common overrides and server overrides never project', () => {
  const plan = buildMrpackClientPlan({ manifest: manifest(), archiveEntries: [
    entry('overrides/config/common.toml'), entry('client-overrides/config/common.toml'),
    entry('server-overrides/config/server.toml'), entry('client-overrides/options.txt')
  ] });
  assert.deepEqual(plan.layers, [{ name: 'downloads', order: 0 }, { name: 'overrides', order: 1 }, { name: 'client-overrides', order: 2 }]);
  assert.deepEqual(plan.finalOverrides.map(item => [item.layer, item.targetPath]), [
    ['client-overrides', 'config/common.toml'], ['client-overrides', 'options.txt']
  ]);
  assert.deepEqual(plan.overrideOperations.map(item => item.order), [1, 2, 2]);
});

// Losing alias/ancestor checks permits different archive entries to control the same Windows target.
test('client projection retains Windows alias and cross-layer file-directory collision checks', () => {
  for (const archiveEntries of [
    [entry('client-overrides/config/A.toml'), entry('CLIENT-OVERRIDES\\config\\a.toml')],
    [entry('overrides/config', 'directory'), entry('client-overrides/config')],
    [entry('overrides/config'), entry('client-overrides/config/a.toml')]
  ]) assert.throws(() => buildMrpackClientPlan({ manifest: manifest(), archiveEntries }), { code: 'ARCHIVE_ENTRY_COLLISION' });
});

// Policy omission at either input boundary would let pack content replace application/user/runtime state.
test('client policy rejects protected content from downloads and both override layers', () => {
  const paths = ['.minecraft-core/state.json', 'config/.Minecraft-Core-secret', 'minecraft-core-launch.json',
    'client-config.json', 'XMCL-AUTH.JSON', 'auth/session.json', 'credentials/token.json',
    'saves/world/level.dat', 'SCREENSHOTS\\shot.png', 'logs/latest.log', 'crash-reports/report.txt',
    'versions/custom/custom.jar', 'libraries/lib.jar', 'assets/indexes/a.json', 'runtime/java/bin/java.exe',
    'natives/library.bin', 'java/bin/java', 'mods/evil.EXE', 'scripts/start.ps1', 'run.bat'];
  for (const target of paths) {
    assert.throws(() => buildMrpackClientPlan({ manifest: manifest([file(target)]) }), error => ['UNSAFE_ARCHIVE_ENTRY', 'MANIFEST_INVALID'].includes(error.code), target);
    for (const layer of ['overrides', 'client-overrides']) {
      assert.throws(() => buildMrpackClientPlan({ manifest: manifest(), archiveEntries: [entry(`${layer}/${target}`)] }), error => ['UNSAFE_ARCHIVE_ENTRY', 'MANIFEST_INVALID'].includes(error.code), `${layer}/${target}`);
    }
  }
});

test('client settings seed while ordinary pack data remains managed', () => {
  const { clientPathPolicy } = require('../../electron/services/client-modpacks/client-content-policy.cjs');
  for (const target of ['options.txt', 'OPTIONSOF.TXT', 'servers.dat']) assert.equal(clientPathPolicy(target), 'preserve-after-seed');
  for (const target of ['mods/a.jar', 'config/options.txt', 'defaultconfigs/a.toml', 'kubejs/server_scripts/a.js', 'scripts/a.zs', 'resources/custom/data.json']) {
    assert.equal(clientPathPolicy(target), 'managed');
  }
  for (const target of ['../escape.txt', 'C:\\escape.txt', 'config/NUL.txt', 'config/a.']) assert.throws(() => clientPathPolicy(target));
});
