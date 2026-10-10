const test = require('node:test');
const assert = require('node:assert/strict');
const { selectClientArchiveFormat, parseMultiMCManifest, buildMultiMCClientPlan } = require('../../electron/services/client-modpacks/multimc-client-plan.cjs');
const { normalizeRuntimeConstraints, assertRuntimeConstraints } = require('../../electron/services/client-modpacks/client-runtime-constraints.cjs');

const minecraft = { uid: 'net.minecraft', version: '1.20.1' };
const forge = { uid: 'net.minecraftforge', version: '47.4.13' };
const fabric = { uid: 'net.fabricmc.fabric-loader', version: '0.16.10' };
const lwjgl = { uid: 'org.lwjgl3', version: '3.3.1', dependencyOnly: true };
const intermediary = { uid: 'net.fabricmc.intermediary', version: '1.20.1', dependencyOnly: true };
const bytes = (components = [minecraft, forge, lwjgl], extra = {}) => Buffer.from(JSON.stringify({ formatVersion: 1, components, ...extra }));
const runtime = (loaderFamily = 'forge', loaderVersion = '47.4.13') => ({ minecraftVersion: '1.20.1', loaderFamily, loaderVersion, javaMajor: 17, os: 'win32', architecture: 'x64' });
const file = (path, size = 1) => ({ path, type: 'file', size });
const directory = path => ({ path, type: 'directory', size: 0 });
const layout = () => [file('mmc-pack.json'), file('instance.cfg'), file('.minecraft/config/a.toml', 6)];
const inventory = entries => entries.map(({ path, ...entry }) => ({ entryName: path, ...entry, size: String(entry.size) }));
const project = entries => buildMultiMCClientPlan({ manifest: parseMultiMCManifest(bytes()), archiveEntries: entries });

// A lost loader, auxiliary requirement, or Java resolver changes these independently specified tuples.
for (const [name, components, expectedRuntime, constraints] of [
  ['observed Forge', [minecraft, forge, lwjgl], runtime(), { lwjglVersion: '3.3.1' }],
  ['vanilla', [minecraft], runtime('vanilla', '1.20.1'), { lwjglVersion: null }],
  ['Fabric with intermediary', [minecraft, fabric, intermediary], runtime('fabric', '0.16.10'), { lwjglVersion: null }],
  ['Fabric without auxiliary declaration', [minecraft, fabric], runtime('fabric', '0.16.10'), { lwjglVersion: null }]
]) test(`parser retains complete ${name} runtime`, () => {
  const parsed = parseMultiMCManifest(bytes(components));
  assert.deepEqual(parsed, { runtime: expectedRuntime, runtimeConstraints: constraints });
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.runtime) && Object.isFrozen(parsed.runtimeConstraints));
});

for (const [name, components] of [
  ['no Minecraft', [forge]], ['duplicate Minecraft', [minecraft, minecraft]],
  ['duplicate loader', [minecraft, forge, forge]], ['conflicting loaders', [minecraft, forge, fabric]],
  ['unknown component', [minecraft, { uid: 'custom.component', version: '1' }]],
  ['unsupported loader', [minecraft, { uid: 'org.quiltmc.quilt-loader', version: '0.1' }]],
  ['case alias uid', [{ ...minecraft, uid: 'NET.MINECRAFT' }]],
  ['intermediary without Fabric', [minecraft, intermediary]],
  ['wrong intermediary', [minecraft, fabric, { ...intermediary, version: '1.20.2' }]],
  ['nondependency intermediary', [minecraft, fabric, { ...intermediary, dependencyOnly: false }]],
  ['missing intermediary flag', [minecraft, fabric, { uid: intermediary.uid, version: intermediary.version }]],
  ['nondependency LWJGL', [minecraft, { ...lwjgl, dependencyOnly: false }]],
  ['missing LWJGL flag', [minecraft, { uid: lwjgl.uid, version: lwjgl.version }]],
  ['duplicate LWJGL', [minecraft, lwjgl, lwjgl]],
  ['disabled Minecraft', [{ ...minecraft, disabled: true }]],
  ['custom executable field', [{ ...minecraft, preLaunchCommand: 'ignored?' }]],
  ['cached version is not authority', [{ uid: minecraft.uid, cachedVersion: '1.20.1' }]],
  ['33 components', Array.from({ length: 33 }, () => minecraft)],
  ['null component', [null]], ['empty list', []]
]) test(`parser refuses ${name}`, () => assert.throws(() => parseMultiMCManifest(bytes(components)), { code: 'MANIFEST_INVALID' }));

for (const version of ['latest', 'release', 'snapshot', 'LATEST', ' 47.4.13', '47/4', 'a'.repeat(129), '']) {
  test(`parser refuses nonexact version ${JSON.stringify(version).slice(0, 45)}`, () => {
    for (const component of [forge, lwjgl, minecraft]) {
      assert.throws(() => parseMultiMCManifest(bytes(component === minecraft ? [{ ...minecraft, version }] : [minecraft, { ...component, version }])), { code: 'MANIFEST_INVALID' });
    }
  });
}
test('128-character exact auxiliary version and inert cached metadata are bounded without overriding runtime', () => {
  const parsed = parseMultiMCManifest(bytes([minecraft, { ...forge, disabled: false, important: true,
    volatile: false, cachedVolatile: true, cachedName: 'x'.repeat(256), cachedVersion: '',
    cachedRequires: [{ uid: 'net.minecraft', equals: 'latest', suggests: '' }], cachedConflicts: [{ uid: 'other' }] },
  { ...lwjgl, version: 'a'.repeat(128) }]));
  assert.deepEqual(parsed.runtime, runtime());
  assert.equal(parsed.runtimeConstraints.lwjglVersion, 'a'.repeat(128));
});
for (const [key, value] of [
  ['cachedName', 'x'.repeat(257)], ['cachedName', 'bad\nname'], ['cachedName', 1],
  ['cachedVersion', 'x'.repeat(129)], ['dependencyOnly', 1], ['important', null], ['disabled', 'false'],
  ['volatile', {}], ['cachedVolatile', []], ['cachedRequires', {}], ['cachedConflicts', [null]],
  ['cachedRequires', [{ uid: 'x', version: '1' }]], ['cachedRequires', [{ uid: '' }]],
  ['cachedRequires', [{ uid: 'x', equals: 1 }]], ['cachedRequires', [{ uid: 'x', suggests: 'x'.repeat(129) }]],
  ['cachedRequires', [{ uid: 'x\n' }]], ['cachedConflicts', Array.from({ length: 33 }, () => ({ uid: 'x' }))]
]) test(`parser refuses invalid ${key} ${JSON.stringify(value).slice(0, 35)}`, () => {
  assert.throws(() => parseMultiMCManifest(bytes([{ ...minecraft, [key]: value }])), { code: 'MANIFEST_INVALID' });
});
test('cached dependency arrays accept their exact 32-record boundary', () => {
  assert.deepEqual(parseMultiMCManifest(bytes([{ ...minecraft,
    cachedRequires: Array.from({ length: 32 }, () => ({ uid: 'x'.repeat(128), equals: '', suggests: '' })) }])).runtime, runtime('vanilla', '1.20.1'));
});
for (const [name, input] of [
  ['not Buffer', '{}'], ['invalid JSON', Buffer.from('{')], ['non UTF-8', Buffer.from([0xc3, 0x28])],
  ['wrong format', bytes([minecraft], { formatVersion: 2 })], ['extra root key', bytes([minecraft], { name: 'pack' })],
  ['wrong root type', Buffer.from('[]')], ['oversized', Buffer.alloc(256 * 1024 + 1, 32)]
]) test(`parser refuses ${name}`, () => assert.throws(() => parseMultiMCManifest(input), { code: 'MANIFEST_INVALID' }));
test('metadata exactly 256 KiB remains accepted', () => {
  const body = bytes([minecraft]);
  assert.deepEqual(parseMultiMCManifest(Buffer.concat([body, Buffer.alloc(256 * 1024 - body.length, 32)])).runtime, runtime('vanilla', '1.20.1'));
});

test('selector uses inspected root markers, preserving MRPACK case and exact metadata path', () => {
  assert.deepEqual(selectClientArchiveFormat(inventory([file('MODRINTH.INDEX.JSON')])), { format: 'mrpack', metadataPath: 'MODRINTH.INDEX.JSON' });
  assert.deepEqual(selectClientArchiveFormat(inventory(layout())), { format: 'multimc', metadataPath: 'mmc-pack.json' });
});
test('MRPACK payload marker-like filenames stay ordinary content, but external launcher markers compete', () => {
  const root = file('modrinth.index.json');
  const payload = ['overrides', 'client-overrides', 'server-overrides'].flatMap(prefix =>
    ['manifest.json', 'pack.toml', 'mmc-pack.json', 'instance.cfg'].map(name => file(`${prefix}/config/${name}`)));
  assert.deepEqual(selectClientArchiveFormat(inventory([root, ...payload])), { format: 'mrpack', metadataPath: 'modrinth.index.json' });
  for (const marker of ['mmc-pack.json', 'instance.cfg', 'nested/mmc-pack.json', 'nested/instance.cfg']) {
    assert.throws(() => selectClientArchiveFormat(inventory([root, ...payload, file(marker)])), { code: 'PACK_ROOT_AMBIGUOUS' });
  }
});
for (const prefix of ['.minecraft', 'overrides', 'client-overrides', 'server-overrides']) {
  test(`MRPACK refuses an additional Modrinth index under ${prefix}`, () => {
    assert.throws(() => selectClientArchiveFormat(inventory([file('modrinth.index.json'), file(`${prefix}/config/modrinth.index.json`)])), { code: 'PACK_ROOT_AMBIGUOUS' });
  });
}
test('MultiMC ordinary game-content download-marker basenames do not change format', () => {
  const entries = [...layout(), ...['manifest.json', 'modrinth.index.json', 'pack.toml'].map(name => file(`.minecraft/config/${name}`))];
  assert.deepEqual(selectClientArchiveFormat(inventory(entries)), { format: 'multimc', metadataPath: 'mmc-pack.json' });
  assert.deepEqual(project(entries).finalOverrides.map(e => e.targetPath), ['config/a.toml', 'config/manifest.json', 'config/modrinth.index.json', 'config/pack.toml']);
});
for (const [name, entries] of [
  ['missing cfg', layout().filter(e => e.path !== 'instance.cfg')], ['missing manifest', layout().slice(1)],
  ['no payload', layout().slice(0, 2)], ['empty game directory', [...layout().slice(0, 2), directory('.minecraft')]],
  ['marker directory', [directory('mmc-pack.json'), ...layout().slice(1)]],
  ['wrapped root', layout().map(e => ({ ...e, path: `wrapper/${e.path}` }))],
  ['nested competing root', [...layout(), file('nested/mmc-pack.json')]],
  ['nested cfg', [...layout(), file('nested/instance.cfg')]],
  ['mixed root MRPACK', [...layout(), file('modrinth.index.json')]],
  ['nested MRPACK', [file('wrapped/modrinth.index.json')]],
  ['MRPACK plus launcher marker', [file('modrinth.index.json'), file('instance.cfg')]],
  ['root download manifest', [...layout(), file('manifest.json')]],
  ['flame manifest', [...layout(), file('flame/manifest.json')]],
  ['nested pack.toml', [...layout(), file('meta/pack.toml')]],
  ...['patches', 'libraries', 'jarmods'].map(p => [`custom ${p}`, [...layout(), file(`${p}/runtime.json`)]]),
  ['game root file', [...layout(), file('.minecraft')]]
]) test(`format/projector refuses ${name}`, () => {
  assert.throws(() => selectClientArchiveFormat(inventory(entries)));
  assert.throws(() => project(entries));
});
test('projector strips one prefix, retains exact source spelling, decimal sizes and directories', () => {
  const result = project([...layout().slice(0, 2), file('.minecraft/config/cafe\u0301.toml', '6'),
    file('.minecraft/config/manifest.json', 2), directory('.minecraft/empty/'), file('icon.png', 4)]);
  assert.deepEqual(result, { runtime: runtime(), runtimeConstraints: { lwjglVersion: '3.3.1' }, downloads: [],
    finalOverrides: [
      { archivePath: '.minecraft/config/cafe\u0301.toml', targetPath: 'config/café.toml', size: '6' },
      { archivePath: '.minecraft/config/manifest.json', targetPath: 'config/manifest.json', size: '2' }
    ], finalDirectories: [{ targetPath: 'empty' }] });
  assert.ok(Object.isFrozen(result.finalOverrides[0]));
});
for (const [name, additions] of [
  ['case collision', [file('.minecraft/CONFIG/A.toml')]],
  ['Unicode collision', [file('.minecraft/config/café.toml'), file('.minecraft/config/cafe\u0301.toml')]],
  ['file ancestor first', [file('.minecraft/file'), file('.minecraft/file/child')]],
  ['file ancestor last', [file('.minecraft/file/child'), file('.minecraft/file')]],
  ['directory/file collision', [directory('.minecraft/dir'), file('.minecraft/dir')]]
]) test(`projection rejects ${name}`, () => assert.throws(() => project([...layout(), ...additions]), { code: 'ARCHIVE_ENTRY_COLLISION' }));
for (const target of ['saves/x', 'screenshots/x', 'logs/x', 'crash-reports/x', 'versions/x', 'libraries/x', 'assets/x',
  'runtime/x', 'runtimes/x', 'java/x', 'jre/x', 'jdk/x', 'natives/x', 'auth/x', 'credentials/x', '.minecraft/config/x',
  '.minecraft-core-state/x', 'minecraft-core-data/x', 'config/.minecraft-core-private/x',
  ...['client-config.json', 'xmcl-auth.json', 'auth.json', 'credentials.json', 'accounts.json', 'launcher_accounts.json', 'launcher_profiles.json', 'usercache.json'].map(n => `config/${n}`),
  ...['bat', 'cmd', 'com', 'exe', 'msi', 'ps1', 'psm1', 'psd1', 'sh', 'bash', 'vbs', 'vbe', 'wsf', 'wsh', 'scr', 'dll', 'so', 'dylib', 'lnk', 'url', 'hta', 'cpl', 'reg'].map(ext => `config/script.${ext}`),
  '../escape', 'config/CON.txt', 'config/name.']) {
  test(`projection rejects protected or unsafe ${target}`, () => assert.throws(() => project([...layout(), file(`.minecraft/${target}`)]), { code: 'UNSAFE_ARCHIVE_ENTRY' }));
}
test('protected empty directories are also refused', () => assert.throws(() => project([...layout(), directory('.minecraft/saves')]), { code: 'UNSAFE_ARCHIVE_ENTRY' }));
for (const entry of [file('.minecraft/a', -1), file('.minecraft/a', Number.MAX_SAFE_INTEGER + 1), file('.minecraft/a', '01'),
  { path: '.minecraft/a', type: 'symlink', size: 1 }, { path: '.minecraft/a', type: 'file' },
  { ...file('.minecraft/a'), linkTarget: 'elsewhere' }, { ...file('.minecraft/a'), reparse: true }]) {
  test(`projection rejects malformed entry ${JSON.stringify(entry)}`, () => assert.throws(() => project([...layout(), entry])));
}

test('runtime evidence normalization is frozen, exact, and does not invoke getters', () => {
  assert.deepEqual(normalizeRuntimeConstraints({ lwjglVersion: null }), { lwjglVersion: null });
  assert.ok(Object.isFrozen(normalizeRuntimeConstraints({ lwjglVersion: '3.3.1' })));
  let reads = 0;
  const accessor = { get lwjglVersion() { reads++; return null; } };
  for (const evidence of [undefined, null, {}, { lwjglVersion: 'latest' }, { lwjglVersion: '3.3.1', other: 1 },
    { lwjglVersion: '' }, { lwjglVersion: 'x'.repeat(129) }, { lwjglVersion: null, [Symbol('x')]: 1 },
    Object.create({ lwjglVersion: null }), Object.defineProperty({}, 'lwjglVersion', { value: null }), accessor]) {
    assert.throws(() => normalizeRuntimeConstraints(evidence), { code: 'RUNTIME_INCOMPLETE' });
  }
  assert.equal(reads, 0);
});
test('malformed supplied evidence always reports RUNTIME_INCOMPLETE, including hostile reflection', () => {
  const revoked = Proxy.revocable({ lwjglVersion: null }, {}); revoked.revoke();
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('reflection refused'); } });
  for (const evidence of [revoked.proxy, hostile]) {
    assert.throws(() => normalizeRuntimeConstraints(evidence), { code: 'RUNTIME_INCOMPLETE' });
    assert.throws(() => assertRuntimeConstraints([], runtime(), evidence), { code: 'RUNTIME_INCOMPLETE' });
  }
});
const libs = (...names) => names.map(name => ({ name }));
for (const [label, coordinate, tuple, constraints] of [
  ['LWJGL core', 'org.lwjgl:lwjgl:3.3.1', runtime(), { lwjglVersion: '3.3.1' }],
  ['Fabric intermediary', 'net.fabricmc:intermediary:1.20.1', runtime('fabric', '0.16.10'), { lwjglVersion: null }]
]) {
  for (const suffix of [':non-runtime', ':natives-windows', ':natives-windows@jar', '@pom', '@zip']) {
    test(`${label} cannot be satisfied by only ${suffix}`, () => {
      assert.throws(() => assertRuntimeConstraints(libs(`${coordinate}${suffix}`), tuple, constraints), { code: 'RUNTIME_INCOMPLETE' });
    });
  }
  test(`${label} accepts ordinary implicit JAR or explicit @jar alongside classifiers`, () => {
    for (const suffix of ['', '@jar']) {
      assert.doesNotThrow(() => assertRuntimeConstraints(libs(`${coordinate}${suffix}`, `${coordinate}:natives-windows@jar`, `${coordinate}@pom`), tuple, constraints));
    }
  });
  test(`${label} native metadata cannot satisfy ordinary artifact presence`, () => {
    const { LibraryInfo, ResolvedLibrary, Version } = require('@xmcl/core');
    const platform = { name: 'windows', arch: 'x64', version: '' };
    const ordinary = Version.resolveLibrary({ name: `${coordinate}@jar` }, platform);
    const legacyNative = Version.resolveLibrary({ name: coordinate, natives: { windows: 'natives-windows' } }, platform);
    assert.throws(() => assertRuntimeConstraints([legacyNative], tuple, constraints), { code: 'RUNTIME_INCOMPLETE' });
    assert.doesNotThrow(() => assertRuntimeConstraints([ordinary, legacyNative], tuple, constraints));
    const flaggedNative = new ResolvedLibrary(coordinate, LibraryInfo.resolve(coordinate), ordinary.download, true);
    assert.throws(() => assertRuntimeConstraints([flaggedNative], tuple, constraints), { code: 'RUNTIME_INCOMPLETE' });
    assert.doesNotThrow(() => assertRuntimeConstraints([ordinary, flaggedNative], tuple, constraints));
  });
}
test('effective LWJGL core, modules, classifiers and extensions must use the declared version', () => {
  assert.doesNotThrow(() => assertRuntimeConstraints(libs('org.lwjgl:lwjgl:3.3.1', 'org.lwjgl:lwjgl-glfw:3.3.1:natives-windows@jar'), runtime(), { lwjglVersion: '3.3.1' }));
  for (const libraries of [[], libs('org.lwjgl:lwjgl-glfw:3.3.1'), libs('org.lwjgl:lwjgl:3.3.2'),
    libs('org.lwjgl:lwjgl:3.3.1', 'org.lwjgl:lwjgl-glfw:3.3.2'), libs('org.lwjgl:lwjgl:3.3.1', 'org.lwjgl:lwjgl:3.3.2'),
    libs('org.lwjgl:lwjgl:3.3.1', 'org.lwjgl:lwjgl:3.3.2:natives-windows'),
    libs('org.lwjgl:lwjgl:3.3.1', 'org.lwjgl:lwjgl-glfw:3.3.2@pom')]) {
    assert.throws(() => assertRuntimeConstraints(libraries, runtime(), { lwjglVersion: '3.3.1' }), { code: 'RUNTIME_INCOMPLETE' });
  }
});
test('supplied null constraints impose Fabric intermediary but no LWJGL restriction; undefined remains legacy', () => {
  assert.doesNotThrow(() => assertRuntimeConstraints([], runtime('fabric', '0.16.10'), undefined));
  assert.doesNotThrow(() => assertRuntimeConstraints([], runtime(), { lwjglVersion: null }));
  assert.doesNotThrow(() => assertRuntimeConstraints([], runtime('vanilla', '1.20.1'), { lwjglVersion: null }));
  assert.doesNotThrow(() => assertRuntimeConstraints(libs('net.fabricmc:intermediary:1.20.1'), runtime('fabric', '0.16.10'), { lwjglVersion: null }));
  for (const libraries of [[], libs('net.fabricmc:intermediary:1.20.2'), libs('net.fabricmc:intermediary:1.20.1', 'net.fabricmc:intermediary:1.20.2'),
    libs('net.fabricmc:intermediary:1.20.1', 'net.fabricmc:intermediary:1.20.2:non-runtime'),
    libs('net.fabricmc:intermediary:1.20.1', 'net.fabricmc:intermediary:1.20.2@pom')]) {
    assert.throws(() => assertRuntimeConstraints(libraries, runtime('fabric', '0.16.10'), { lwjglVersion: null }), { code: 'RUNTIME_INCOMPLETE' });
  }
  assert.throws(() => assertRuntimeConstraints([], runtime(), {}), { code: 'RUNTIME_INCOMPLETE' });
});
