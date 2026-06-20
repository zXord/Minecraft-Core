const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const electronRoot = path.join(repoRoot, 'electron');

function walkRuntimeFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkRuntimeFiles(entryPath, files);
      continue;
    }

    if (entry.isFile() && /\.(?:cjs|js)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

test('Electron runtime avoids direct node-fetch imports', () => {
  const matches = walkRuntimeFiles(electronRoot)
    .filter((filePath) => fs.readFileSync(filePath, 'utf8').includes('node-fetch'))
    .map((filePath) => path.relative(repoRoot, filePath));

  assert.deepEqual(matches, []);
});

test('fetchCompat preserves node-style stream and buffer helpers', async () => {
  const { fetchCompat } = require('../electron/utils/fetch.cjs');
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url) => {
      const payload = String(url).includes('buffer') ? 'buffer-payload' : 'stream-payload';
      return new Response(payload, { status: 200 });
    };

    const streamResponse = await fetchCompat('https://example.test/stream');
    assert.equal(typeof streamResponse.body.pipe, 'function');

    const chunks = [];
    for await (const chunk of streamResponse.body) {
      chunks.push(Buffer.from(chunk));
    }
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'stream-payload');

    const bufferResponse = await fetchCompat('https://example.test/buffer');
    const buffer = await bufferResponse.buffer();
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer.toString('utf8'), 'buffer-payload');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
