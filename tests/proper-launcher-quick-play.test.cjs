const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  ProperMinecraftLauncher,
  appendServerLaunchFallback,
  createServerLaunchTarget
} = require('../electron/services/minecraft-launcher/proper-launcher.cjs');

const MINECRAFT_VERSION = '1.20.1';

function createLiveChild(pid = 8451) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unref = () => {};
  child.kill = () => true;
  return child;
}

async function createQuickPlayClientFixture(t) {
  const clientPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-quick-play-'));
  t.after(() => fsp.rm(clientPath, { recursive: true, force: true }));

  const versionPath = path.join(clientPath, 'versions', MINECRAFT_VERSION);
  await fsp.mkdir(versionPath, { recursive: true });
  await fsp.writeFile(path.join(versionPath, `${MINECRAFT_VERSION}.jar`), 'minecraft-client');
  await fsp.writeFile(path.join(versionPath, `${MINECRAFT_VERSION}.json`), JSON.stringify({
    id: MINECRAFT_VERSION,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assetIndex: { id: '5' },
    libraries: [],
    arguments: {
      jvm: [],
      game: [
        '--username',
        '${auth_player_name}',
        {
          rules: [{ action: 'allow', features: { has_quick_plays_support: true } }],
          value: ['--quickPlayPath', '${quickPlayPath}']
        },
        {
          rules: [{ action: 'allow', features: { is_quick_play_multiplayer: true } }],
          value: ['--quickPlayMultiplayer', '${quickPlayMultiplayer}']
        }
      ]
    }
  }));

  return clientPath;
}

test('proper launcher uses the resolved 1.20.1 quick-play argument to autojoin', async t => {
  const clientPath = await createQuickPlayClientFixture(t);
  const child = createLiveChild();
  let spawnArgs = null;
  const launcher = new ProperMinecraftLauncher({
    spawn: (_command, args) => {
      spawnArgs = args;
      return child;
    }
  });
  launcher.ensureMinecraftClient = async () => ({ success: true });
  launcher.setAuthData({ name: 'QuickJoiner', uuid: 'uuid', access_token: 'token' });

  const result = await launcher.launchMinecraft({
    clientPath,
    minecraftVersion: MINECRAFT_VERSION,
    serverIp: '127.0.0.1',
    serverPort: 25566,
    javaPath: 'javaw.exe'
  });

  assert.equal(result.success, true);
  const quickPlayIndex = spawnArgs.indexOf('--quickPlayMultiplayer');
  assert.notEqual(quickPlayIndex, -1);
  assert.equal(spawnArgs[quickPlayIndex + 1], '127.0.0.1:25566');
  assert.equal(spawnArgs.includes('--quickPlayPath'), false);
  assert.equal(spawnArgs.includes('--server'), false);
  assert.equal(spawnArgs.includes('--port'), false);

  child.exitCode = 0;
  child.emit('close');
});

test('quick-play targets bracket IPv6 literals exactly once', () => {
  assert.deepEqual(createServerLaunchTarget('::1', 25566), {
    host: '::1',
    port: '25566',
    quickPlayMultiplayer: '[::1]:25566'
  });
  assert.deepEqual(createServerLaunchTarget('[2001:db8::1]', '25567'), {
    host: '2001:db8::1',
    port: '25567',
    quickPlayMultiplayer: '[2001:db8::1]:25567'
  });
});

test('server launch fallback preserves legacy arguments only when quick play was not expanded', () => {
  const target = createServerLaunchTarget('play.example.test', 25565);
  assert.deepEqual(appendServerLaunchFallback(['--username', 'QuickJoiner'], target), [
    '--username', 'QuickJoiner',
    '--server', 'play.example.test',
    '--port', '25565'
  ]);
  assert.deepEqual(appendServerLaunchFallback([
    '--username', 'QuickJoiner',
    '--quickPlayMultiplayer', 'play.example.test:25565'
  ], target), [
    '--username', 'QuickJoiner',
    '--quickPlayMultiplayer', 'play.example.test:25565'
  ]);
});

test('missing server fields do not change game arguments', () => {
  assert.equal(createServerLaunchTarget('', 25565), null);
  assert.equal(createServerLaunchTarget('127.0.0.1', ''), null);
  assert.equal(createServerLaunchTarget('127.0.0.1', Number.NaN), null);
  assert.equal(createServerLaunchTarget('127.0.0.1', 0), null);
  assert.equal(createServerLaunchTarget('127.0.0.1', 65536), null);
  assert.equal(createServerLaunchTarget('[]', 25565), null);
  const gameArgs = ['--username', 'QuickJoiner'];
  assert.equal(appendServerLaunchFallback(gameArgs, null), gameArgs);
  assert.deepEqual(gameArgs, ['--username', 'QuickJoiner']);
});
