const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  ARCHIVE_RUNTIME_MANIFEST,
  verifyArchiveRuntime
} = require('../../scripts/verify-archive-runtime.cjs');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const runtimeFileNames = ['7z.exe', '7z.dll', 'License.txt'];

async function makeRuntimeCopy() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-archive-runtime-test-'));
  await fs.mkdir(path.join(root, 'build-resources', 'archive-runtime'), { recursive: true });
  await fs.mkdir(path.join(root, 'vendor', '7zip', 'x64'), { recursive: true });
  await fs.mkdir(path.join(root, 'third-party', '7zip'), { recursive: true });
  await fs.copyFile(
    path.join(repositoryRoot, 'build-resources', 'archive-runtime', '7zip-26.02.json'),
    path.join(root, 'build-resources', 'archive-runtime', '7zip-26.02.json')
  );
  for (const name of runtimeFileNames) {
    await fs.copyFile(path.join(repositoryRoot, 'vendor', '7zip', 'x64', name), path.join(root, 'vendor', '7zip', 'x64', name));
  }
  for (const name of ['LGPL-2.1-or-later.txt', 'BSD-notice.txt', 'unRAR-restriction.txt', 'NOTICE.md']) {
    await fs.copyFile(path.join(repositoryRoot, 'third-party', '7zip', name), path.join(root, 'third-party', '7zip', name));
  }
  return root;
}

async function withRuntimeCopy(action) {
  const root = await makeRuntimeCopy();
  try {
    return await action(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function readManifest(root) {
  return JSON.parse(await fs.readFile(path.join(root, 'build-resources', 'archive-runtime', '7zip-26.02.json'), 'utf8'));
}

async function writeManifest(root, manifest) {
  await fs.writeFile(
    path.join(root, 'build-resources', 'archive-runtime', '7zip-26.02.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
}

function unavailable(error) {
  return error?.code === 'EXTRACTOR_UNAVAILABLE' && !/[A-Z]:\\|https?:|7-Zip \[|Igor Pavlov/i.test(error.message);
}

test('the checked-in archive runtime verifies its pinned identity and handlers', async () => {
  const result = await verifyArchiveRuntime(repositoryRoot);

  assert.deepEqual(result.files.map(file => file.name), runtimeFileNames);
  assert.equal(result.version, '26.02');
  assert.equal(result.architecture, 'x64');
  assert.equal(result.handlers.zip, true);
  assert.equal(result.handlers.rar, true);
});

test('a one-byte change to each vendored file invalidates the archive runtime', async () => {
  for (const fileName of runtimeFileNames) {
    await withRuntimeCopy(async root => {
      const target = path.join(root, 'vendor', '7zip', 'x64', fileName);
      const bytes = await fs.readFile(target);
      bytes[Math.floor(bytes.length / 2)] ^= 1;
      await fs.writeFile(target, bytes);

      await assert.rejects(verifyArchiveRuntime(root), unavailable, fileName);
    });
  }
});

test('missing, empty, truncated, and additional runtime files fail closed', async () => {
  const mutations = [
    root => fs.rm(path.join(root, 'vendor', '7zip', 'x64', '7z.dll')),
    root => fs.writeFile(path.join(root, 'vendor', '7zip', 'x64', 'License.txt'), Buffer.alloc(0)),
    async root => {
      const target = path.join(root, 'vendor', '7zip', 'x64', '7z.exe');
      const bytes = await fs.readFile(target);
      await fs.writeFile(target, bytes.subarray(0, bytes.length - 1));
    },
    root => fs.writeFile(path.join(root, 'vendor', '7zip', 'x64', 'unexpected.dll'), 'x')
  ];
  for (const mutate of mutations) {
    await withRuntimeCopy(async root => {
      await mutate(root);
      await assert.rejects(verifyArchiveRuntime(root), unavailable);
    });
  }
});

test('manifest parsing rejects malformed UTF-8, duplicate keys, extra keys, and changed pinned identities', async () => {
  const mutations = [
    async root => fs.writeFile(path.join(root, 'build-resources', 'archive-runtime', '7zip-26.02.json'), Buffer.from([0xff, 0xfe, 0xfd])),
    async root => fs.writeFile(path.join(root, 'build-resources', 'archive-runtime', '7zip-26.02.json'), Buffer.alloc(64 * 1024 + 1, 0x20)),
    async root => {
      const manifest = await readManifest(root);
      const raw = JSON.stringify(manifest).replace('{', '{"schemaVersion":1,');
      await fs.writeFile(path.join(root, 'build-resources', 'archive-runtime', '7zip-26.02.json'), raw);
    },
    async root => writeManifest(root, { ...(await readManifest(root)), unexpected: true }),
    async root => writeManifest(root, { ...(await readManifest(root)), msi: { ...(await readManifest(root)).msi, size: 1 } }),
    async root => writeManifest(root, { ...(await readManifest(root)), source: { ...(await readManifest(root)).source, sha256: '0'.repeat(64) } }),
    async root => writeManifest(root, { ...(await readManifest(root)), version: '26.01' }),
    async root => writeManifest(root, { ...(await readManifest(root)), architecture: 'arm64' }),
    async root => writeManifest(root, { ...(await readManifest(root)), authenticode: { status: 'Valid' } }),
    async root => writeManifest(root, { ...(await readManifest(root)), authenticode: { status: 'NotSigned', signer: null } }),
    async root => writeManifest(root, { ...(await readManifest(root)), pe: { ...(await readManifest(root)).pe, machine: 'I386' } }),
    async root => writeManifest(root, { ...(await readManifest(root)), handlers: { ...(await readManifest(root)).handlers, rar: false } })
  ];
  for (const mutate of mutations) {
    await withRuntimeCopy(async root => {
      await mutate(root);
      await assert.rejects(verifyArchiveRuntime(root), unavailable);
    });
  }
});

test('manifest file records have an exact closed safe schema', async () => {
  const mutations = [
    async root => {
      const manifest = await readManifest(root);
      delete manifest.files['7z.dll'];
      await writeManifest(root, manifest);
    },
    async root => {
      const manifest = await readManifest(root);
      manifest.files.extra = manifest.files['7z.dll'];
      await writeManifest(root, manifest);
    },
    async root => {
      const manifest = await readManifest(root);
      manifest.files['7z.exe'].size = 0;
      await writeManifest(root, manifest);
    },
    async root => {
      const manifest = await readManifest(root);
      manifest.files['7z.exe'].size = Number.MAX_SAFE_INTEGER + 1;
      await writeManifest(root, manifest);
    },
    async root => {
      const manifest = await readManifest(root);
      manifest.files['7z.exe'].path = 'elsewhere.exe';
      await writeManifest(root, manifest);
    }
  ];
  for (const mutate of mutations) {
    await withRuntimeCopy(async root => {
      await mutate(root);
      await assert.rejects(verifyArchiveRuntime(root), unavailable);
    });
  }
});

test('altered or missing substantive legal notices fail closed', async () => {
  for (const name of ['License.txt', 'LGPL-2.1-or-later.txt', 'BSD-notice.txt', 'unRAR-restriction.txt', 'NOTICE.md']) {
    await withRuntimeCopy(async root => {
      const target = name === 'License.txt'
        ? path.join(root, 'vendor', '7zip', 'x64', name)
        : path.join(root, 'third-party', '7zip', name);
      await fs.writeFile(target, 'placeholder');
      await assert.rejects(verifyArchiveRuntime(root), unavailable, name);
    });
  }
  await withRuntimeCopy(async root => {
    await fs.rm(path.join(root, 'third-party', '7zip', 'NOTICE.md'));
    await assert.rejects(verifyArchiveRuntime(root), unavailable);
  });
  await withRuntimeCopy(async root => {
    await fs.writeFile(path.join(root, 'third-party', '7zip', 'unexpected.txt'), 'extra');
    await assert.rejects(verifyArchiveRuntime(root), unavailable);
  });
});

test('unsupported platform and architecture return EXTRACTOR_UNAVAILABLE instead of skipping', async () => {
  await assert.rejects(verifyArchiveRuntime(repositoryRoot, { platform: 'linux', architecture: 'x64' }), unavailable);
  await assert.rejects(verifyArchiveRuntime(repositoryRoot, { platform: 'win32', architecture: 'arm64' }), unavailable);
});

test('wrong PE version, missing handlers, failures, timeouts, and excessive output fail closed', async () => {
  await withRuntimeCopy(async root => {
    const correct = { fileVersion: '26.02', productVersion: '26.02', authenticodeStatus: 'NotSigned' };
    await assert.rejects(verifyArchiveRuntime(root, {
      inspectVersion: async () => ({ fileVersion: '26.01', productVersion: '26.02' })
    }), unavailable);
    await assert.rejects(verifyArchiveRuntime(root, {
      inspectVersion: async () => correct,
      runEngine: async () => ({ code: 0, stdout: '7-Zip 26.02\nFormats:\n  C Zip\n', stderr: '' })
    }), unavailable);
    await assert.rejects(verifyArchiveRuntime(root, {
      inspectVersion: async () => correct,
      runEngine: async () => ({ code: 2, stdout: '', stderr: 'secret diagnostics' })
    }), unavailable);
    await assert.rejects(verifyArchiveRuntime(root, {
      inspectVersion: async () => correct,
      runEngine: async () => ({ code: 0, stdout: '7-Zip 26.02 (x64)\nFormats:\n 0 Zip zip\n 0 Rar rar\n', stderr: 'warning' })
    }), unavailable);
    await assert.rejects(verifyArchiveRuntime(root, {
      inspectVersion: async () => correct,
      runEngine: async () => { const error = new Error('deadline'); error.code = 'ETIMEDOUT'; throw error; }
    }), unavailable);
    await assert.rejects(verifyArchiveRuntime(root, {
      inspectVersion: async () => correct,
      runEngine: async () => ({ code: 0, stdout: 'x'.repeat(1024 * 1024 + 1), stderr: '' })
    }), unavailable);
    await assert.rejects(verifyArchiveRuntime(root, {
      inspectVersion: async () => correct,
      runEngine: async () => ({ code: 0, stdout: Buffer.from([0xff]), stderr: '' })
    }), unavailable);
  });
});

test('directory junctions cannot substitute the pinned runtime directory', async () => {
  await withRuntimeCopy(async root => {
    const target = path.join(root, 'vendor', '7zip', 'x64');
    const moved = path.join(root, 'vendor', '7zip', 'x64-real');
    await fs.rename(target, moved);
    await fs.symlink(moved, target, 'junction');
    await assert.rejects(verifyArchiveRuntime(root), unavailable);
  });
});

test('links and reparse-like runtime objects are rejected when creation is supported', async t => {
  await withRuntimeCopy(async root => {
    const target = path.join(root, 'vendor', '7zip', 'x64', '7z.dll');
    const moved = `${target}.real`;
    await fs.rename(target, moved);
    try {
      await fs.symlink(moved, target, 'file');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        await fs.rename(moved, target);
        t.skip('Creating file symlinks requires an elevated Windows privilege');
        return;
      }
      throw error;
    }
    await assert.rejects(verifyArchiveRuntime(root), unavailable);
  });
});

test('the exported manifest constants remain the only accepted upstream identities', () => {
  assert.equal(ARCHIVE_RUNTIME_MANIFEST.schemaVersion, 1);
  assert.equal(ARCHIVE_RUNTIME_MANIFEST.version, '26.02');
  assert.equal(ARCHIVE_RUNTIME_MANIFEST.architecture, 'x64');
  assert.equal(ARCHIVE_RUNTIME_MANIFEST.msi.sha256, 'db407a4f6d4999e5c7bc00ce8a882be94717b56e7fa68140fe3f12605d91643e');
  assert.equal(ARCHIVE_RUNTIME_MANIFEST.source.sha256, 'c7502dd4557481f52ccf1b3e680329f1fdd207e79a25544afeb3106325474944');
});
