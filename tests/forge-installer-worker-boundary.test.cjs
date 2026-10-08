const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

test('the Forge server boundary never resolves the leaking installForge API in the main process', async () => {
  const servicePath = require.resolve('../electron/services/loader-install-service.cjs');
  const realInstaller = require('@xmcl/installer');
  const originalLoad = Module._load;
  const calls = [];
  Module._load = function isolatedForgeLoad(request, parent, isMain) {
    if (request === '@xmcl/installer' && parent?.filename === servicePath) {
      return new Proxy(realInstaller, {
        get(target, property, receiver) {
          if (property === 'installForge') {
            throw new Error('main process attempted to resolve the leaking installForge API');
          }
          return Reflect.get(target, property, receiver);
        }
      });
    }
    if (request === './forge-installer-worker-client.cjs' && parent?.filename === servicePath) {
      return {
        runForgeInstallerWorker: async request => {
          calls.push(request);
          return { profileId: '1.12.2-forge-14.23.5.2860' };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[servicePath];

  try {
    const service = require(servicePath);
    const targetPath = path.resolve('worker-boundary', 'server');
    const javaPath = path.resolve('worker-boundary', 'java', 'bin', 'java.exe');
    const signal = new AbortController().signal;
    const result = await service.__testUtils.runForgeInstallerWorkerBoundary({
      targetPath,
      minecraftVersion: '1.12.2',
      loaderVersion: '14.23.5.2860',
      javaPath,
      signal,
      installTimeoutMs: 12345
    });

    assert.deepEqual(result, { profileId: '1.12.2-forge-14.23.5.2860' });
    assert.deepEqual(calls, [{
      targetPath,
      minecraftVersion: '1.12.2',
      loaderVersion: '14.23.5.2860',
      javaPath,
      signal,
      timeoutMs: 12345
    }]);
  } finally {
    delete require.cache[servicePath];
    Module._load = originalLoad;
  }
});
