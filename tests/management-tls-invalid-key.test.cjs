const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

async function withTlsTest(fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-tls-'));
  const tlsUtilsPath = path.resolve(__dirname, '../electron/utils/tls-utils.cjs');
  const secureStorePath = path.resolve(__dirname, '../electron/utils/secure-store.cjs');
  const configManagerPath = path.resolve(__dirname, '../electron/utils/config-manager.cjs');
  const durableFsPath = path.resolve(__dirname, '../electron/utils/durable-fs.cjs');
  const originalLoad = Module._load;
  const tlsStore = {};

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (value) => Buffer.from(value, 'utf8'),
          decryptString: (buffer) => {
            const value = buffer.toString('utf8');
            if (!value.includes('PRIVATE KEY')) {
              throw new Error('cannot decrypt test key');
            }
            return value;
          }
        }
      };
    }

    if (request === './app-store.cjs' || request.endsWith('/utils/app-store.cjs')) {
      return {
        get: (key) => tlsStore[key],
        set: (key, value) => {
          tlsStore[key] = value;
          return true;
        }
      };
    }

    if (request === 'selfsigned') {
      return {
        generate: async () => ({
          cert: [
            '-----BEGIN CERTIFICATE-----',
            Buffer.from('generated-cert').toString('base64'),
            '-----END CERTIFICATE-----'
          ].join('\n'),
          private: [
            '-----BEGIN PRIVATE KEY-----',
            Buffer.from('generated-key').toString('base64'),
            '-----END PRIVATE KEY-----'
          ].join('\n')
        })
      };
    }

    if (request === '@peculiar/x509') {
      return {
        cryptoProvider: {
          set() {}
        }
      };
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[tlsUtilsPath];
  delete require.cache[secureStorePath];
  delete require.cache[configManagerPath];

  try {
    require(durableFsPath).configureDurableFs({
      allowedRoots: [root],
      durableClient: {
        moveWriteThrough: fs.renameSync,
        replaceFileWriteThrough: fs.renameSync,
        flushDirectory() {}
      }
    });
    return await fn({ root, tlsUtilsPath });
  } finally {
    delete require.cache[tlsUtilsPath];
    delete require.cache[secureStorePath];
    delete require.cache[configManagerPath];
    Module._load = originalLoad;
    await fsp.rm(root, { recursive: true, force: true });
  }
}

test('management TLS regenerates when stored encrypted private key cannot be decrypted to PEM', async () => {
  await withTlsTest(async ({ root, tlsUtilsPath }) => {
    const serverPath = path.join(root, 'server');
    const configPath = path.join(serverPath, '.minecraft-core.json');
    await fsp.mkdir(serverPath, { recursive: true });
    await fsp.writeFile(configPath, JSON.stringify({
      managementTls: {
        cert: [
          '-----BEGIN CERTIFICATE-----',
          Buffer.from('stale-cert').toString('base64'),
          '-----END CERTIFICATE-----'
        ].join('\n'),
        key: 'enc:not-a-decryptable-private-key',
        fingerprint: 'stale',
        createdAt: '2026-05-28T00:00:00.000Z',
        keyEncrypted: true
      }
    }, null, 2));

    const { getManagementTlsConfig } = require(tlsUtilsPath);
    const tlsConfig = await getManagementTlsConfig(serverPath);
    const updatedConfig = JSON.parse(await fsp.readFile(configPath, 'utf8'));

    assert.match(tlsConfig.key, /-----BEGIN PRIVATE KEY-----/);
    assert.doesNotMatch(tlsConfig.key, /^enc:/);
    assert.equal(updatedConfig.managementTls.keyEncrypted, true);
    assert.match(updatedConfig.managementTls.key, /^enc:/);
    assert.notEqual(updatedConfig.managementTls.key, 'enc:not-a-decryptable-private-key');
  });
});

test('reading absent management TLS does not generate or persist certificate material', async () => {
  await withTlsTest(async ({ root, tlsUtilsPath }) => {
    const serverPath = path.join(root, 'server');
    const configPath = path.join(serverPath, '.minecraft-core.json');
    await fsp.mkdir(serverPath, { recursive: true });
    const original = `${JSON.stringify({ contentRevision: 4, managementTls: null }, null, 2)}\n`;
    await fsp.writeFile(configPath, original);
    const oldTime = new Date('2020-01-02T03:04:05.000Z');
    await fsp.utimes(configPath, oldTime, oldTime);

    const { getExistingManagementTlsConfig } = require(tlsUtilsPath);
    const existing = getExistingManagementTlsConfig(serverPath);

    assert.equal(existing, null);
    assert.equal(await fsp.readFile(configPath, 'utf8'), original);
    assert.equal((await fsp.stat(configPath)).mtimeMs, oldTime.getTime());
  });
});
