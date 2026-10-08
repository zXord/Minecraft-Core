const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { ModpackStateRepository } = require('../../electron/services/modpacks/state/modpack-state-repository.cjs');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function nativeClient() {
  return {
    moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
    replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
    flushDirectory() {},
    async moveWriteThroughAsync(source, destination) { fs.renameSync(source, destination); },
    async replaceFileWriteThroughAsync(source, destination) { fs.renameSync(source, destination); },
    async flushDirectoryAsync() {}
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-state-verify-async-'));
  const serverPath = path.join(root, 'server');
  const modsPath = path.join(serverPath, 'mods');
  fs.mkdirSync(modsPath, { recursive: true });
  fs.writeFileSync(path.join(serverPath, '.minecraft-core.json'), JSON.stringify({ maxRam: 8, contentRevision: 2 }));
  const firstBytes = Buffer.alloc((3 * 64 * 1024) + 17, 0x31);
  const laterBytes = Buffer.from('later managed bytes');
  fs.writeFileSync(path.join(modsPath, 'a-first.jar'), firstBytes);
  fs.writeFileSync(path.join(modsPath, 'z-later.jar'), laterBytes);
  let temporaryId = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: nativeClient(),
    allowedRoots: [root],
    tempNameFactory: () => `verify-${++temporaryId}`
  });
  const repository = new ModpackStateRepository({
    fsApi: fs,
    durableFs,
    clock: () => new Date('2026-09-01T00:00:00.000Z')
  });
  repository.writeCandidate(serverPath, {
    schemaVersion: 1,
    modpackManaged: true,
    source: {
      provider: 'github', repositoryId: '1001', releaseId: '2002', githubOwner: 'FixtureOrg', githubRepo: 'FixturePack',
      version: '1.2.3', title: 'Reviewed Pack'
    },
    runtime: {
      minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14',
      javaMajor: 21, os: 'win32', architecture: 'x64'
    },
    selectedOptionalFiles: [],
    installedAt: '2026-09-01T00:00:00.000Z',
    contentRevision: 3,
    manifest: {
      schemaVersion: 1,
      installationId: 'installation-async-verification',
      entries: [
        {
          path: 'mods/a-first.jar', pathKey: 'mods/a-first.jar', origin: 'pack',
          managementPolicy: 'replaceable-managed', role: 'mod', installedHash: sha256(firstBytes),
          size: String(firstBytes.length), priorBaseline: null
        },
        {
          path: 'mods/z-later.jar', pathKey: 'mods/z-later.jar', origin: 'runtime',
          managementPolicy: 'replaceable-managed', role: 'library', installedHash: sha256(laterBytes),
          size: String(laterBytes.length), priorBaseline: null
        }
      ]
    }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { durableFs, serverPath };
}

test('managed-file verification accepts cancellation during the first file and never opens a later file', async (t) => {
  const context = fixture(t);
  const controller = new AbortController();
  const opened = [];
  let yields = 0;
  const fsApi = {
    ...fs,
    promises: {
      open: async (filePath, flags) => {
        opened.push(path.relative(context.serverPath, filePath).replaceAll('\\', '/'));
        return fs.promises.open(filePath, flags);
      }
    }
  };
  const repository = new ModpackStateRepository({
    fsApi,
    durableFs: context.durableFs,
    clock: () => new Date('2026-09-01T00:00:01.000Z'),
    yieldControl: async () => {
      yields += 1;
      if (yields === 1) controller.abort();
      await new Promise(resolve => setImmediate(resolve));
    }
  });

  const verification = repository.verifyManagedFiles(context.serverPath, { signal: controller.signal });

  assert.equal(typeof verification?.then, 'function');
  await assert.rejects(verification, error => error?.code === 'CANCELLED');
  assert.deepEqual(opened, ['mods/a-first.jar']);
  assert.equal(yields, 1);
});

test('managed-file verification fails closed without asynchronous file access or cooperative yielding', (t) => {
  const context = fixture(t);
  assert.throws(
    () => new ModpackStateRepository({
      fsApi: { ...fs, promises: {} },
      durableFs: context.durableFs,
      clock: () => new Date('2026-09-01T00:00:01.000Z')
    }),
    error => error?.code === 'INVALID_REQUEST'
  );
  assert.throws(
    () => new ModpackStateRepository({
      fsApi: fs,
      durableFs: context.durableFs,
      clock: () => new Date('2026-09-01T00:00:01.000Z'),
      yieldControl: null
    }),
    error => error?.code === 'INVALID_REQUEST'
  );
});

test('managed-file verification treats ctime-only drift as advisory after exact content hashing', async (t) => {
  const context = fixture(t);
  const targetPath = path.join(context.serverPath, 'mods', 'a-first.jar');
  let targetStats = 0;
  const fsApi = {
    ...fs,
    promises: fs.promises,
    lstatSync(filePath, options) {
      const stat = fs.lstatSync(filePath, options);
      if (path.resolve(filePath) !== path.resolve(targetPath)) return stat;
      targetStats += 1;
      if (targetStats % 2 !== 0) return stat;
      return new Proxy(stat, {
        get(value, key) {
          if (key === 'ctimeNs') return value.ctimeNs + 1n;
          const member = Reflect.get(value, key, value);
          return typeof member === 'function' ? member.bind(value) : member;
        }
      });
    }
  };
  const repository = new ModpackStateRepository({
    fsApi,
    fsPromises: fs.promises,
    durableFs: context.durableFs,
    clock: () => new Date('2026-09-01T00:00:01.000Z')
  });

  const result = await repository.verifyManagedFiles(context.serverPath);

  assert.equal(result.healthy, true);
  assert.equal(result.checkedFiles, '2');
  assert.equal(targetStats, 4);
});
