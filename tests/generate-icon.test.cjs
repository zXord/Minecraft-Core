const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');
const sharp = require('sharp');

const exec = promisify(execFile);
const repository = path.resolve(__dirname, '..');

async function generatedFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-generated-icon-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.copyFile(path.join(repository, 'icon.png'), path.join(root, 'icon.png'));
  await exec(process.execPath, [path.join(repository, 'scripts/generate-icon.cjs')], { cwd: root, windowsHide: true });
  return { root, iconPath: path.join(root, 'build-resources/icon.ico') };
}

function frames(bytes) {
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1);
  return Array.from({ length: bytes.readUInt16LE(4) }, (_, index) => {
    const entry = 6 + index * 16;
    const size = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    return { width: bytes[entry] || 256, height: bytes[entry + 1] || 256, size, offset, image: bytes.subarray(offset, offset + size) };
  });
}

test('generated application icon preserves all sizes without overflowing the resource editor frame length', async t => {
  // The bundled resource editor truncates frame lengths above UINT16_MAX.
  // Uncompressed 256px/128px BMPs recreate the malformed executable groups.
  const fixture = await generatedFixture(t);
  const bytes = await fs.readFile(fixture.iconPath);
  const images = frames(bytes);
  assert.deepEqual(images.map(image => image.width), [256, 128, 64, 48, 32, 24, 16]);
  let expectedOffset = 6 + images.length * 16;
  for (const frame of images) {
    assert.equal(frame.width, frame.height);
    assert.equal(frame.offset, expectedOffset);
    assert.equal(frame.image.length, frame.size);
    assert.ok(frame.size <= 65535, `${frame.width}px icon exceeds the editor's length field: ${frame.size}`);
    expectedOffset += frame.size;
    if (frame.width >= 128) {
      const metadata = await sharp(frame.image).metadata();
      assert.equal(metadata.format, 'png');
      assert.equal(metadata.width, frame.width);
      assert.equal(metadata.height, frame.height);
    } else {
      assert.equal(frame.image.readUInt32LE(0), 40, 'small frames retain the existing Windows bitmap representation');
    }
  }
  assert.equal(expectedOffset, bytes.length);
});

test('resource editing preserves every generated frame length and bytes in the executable', {
  skip: process.platform !== 'win32', timeout: 30000
}, async t => {
  const fixture = await generatedFixture(t);
  const exePath = path.join(fixture.root, 'icon-fixture.exe');
  await fs.copyFile(path.join(repository, 'node_modules/electron/dist/electron.exe'), exePath);
  await require('rcedit')(exePath, { icon: fixture.iconPath });
  const pe = require('pe-library');
  const resource = pe.NtExecutableResource.from(pe.NtExecutable.from(await fs.readFile(exePath), { ignoreCert: true }));
  const groups = resource.entries.filter(entry => entry.type === 14);
  assert.equal(groups.length, 1);
  const group = Buffer.from(groups[0].bin);
  const expected = frames(await fs.readFile(fixture.iconPath));
  assert.equal(group.readUInt16LE(4), expected.length);
  for (let index = 0; index < expected.length; index++) {
    const offset = 6 + index * 14;
    const id = group.readUInt16LE(offset + 12);
    const entry = resource.entries.find(item => item.type === 3 && item.id === id && item.lang === groups[0].lang);
    assert.ok(entry);
    assert.equal(group.readUInt32LE(offset + 8), entry.bin.byteLength, `frame ${index} declared length must be exact`);
    assert.deepEqual(Buffer.from(entry.bin), expected[index].image);
  }
  await require('../scripts/afterPack.cjs').verifyWindowsExecutableIcon({ exePath, iconPath: fixture.iconPath });
});
