const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SSOKOLOW_COMMIT = '16b785c2b1b504e99fc307676e5369a26d3ce060';
const LIBARCHIVE_COMMIT = 'e893064acf884e4f6a8a7314ba744a9ff997a99b';

function fail(message) {
  throw new Error(message);
}

function exactCommit(root, expected) {
  const result = childProcess.spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true
  });
  if (result.status !== 0 || result.stdout.trim() !== expected) fail('Fixture source checkout is not at the reviewed commit');
}

function decodeUu(bytes) {
  const text = bytes.toString('ascii').replaceAll('\r\n', '\n');
  const lines = text.split('\n');
  const begin = lines.findIndex(line => /^begin [0-7]{3} /.test(line));
  if (begin < 0) fail('Malformed uuencoded fixture');
  const output = [];
  let ended = false;
  for (let index = begin + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === 'end') { ended = true; break; }
    if (!line) continue;
    const count = (line.charCodeAt(0) - 32) & 63;
    if (count === 0) continue;
    const decoded = [];
    for (let offset = 1; offset < line.length; offset += 4) {
      const values = [0, 1, 2, 3].map(delta => ((line.charCodeAt(offset + delta) || 32) - 32) & 63);
      decoded.push(
        ((values[0] << 2) | (values[1] >>> 4)) & 0xff,
        ((values[1] << 4) | (values[2] >>> 2)) & 0xff,
        ((values[2] << 6) | values[3]) & 0xff
      );
    }
    output.push(Buffer.from(decoded.slice(0, count)));
  }
  if (!ended) fail('Malformed uuencoded fixture terminator');
  return Buffer.concat(output);
}

function copyReviewed(sourceRoot, sourceRelative, destinationName, { uu = false } = {}) {
  const source = path.join(sourceRoot, ...sourceRelative.split('/'));
  const bytes = fs.readFileSync(source);
  fs.writeFileSync(path.join(__dirname, destinationName), uu ? decodeUu(bytes) : bytes);
}

const [ssokolowRoot, libarchiveRoot] = process.argv.slice(2).map(value => path.resolve(value));
if (!ssokolowRoot || !libarchiveRoot) fail('Usage: node import-rar-fixtures.cjs <rar-test-files checkout> <libarchive checkout>');
exactCommit(ssokolowRoot, SSOKOLOW_COMMIT);
exactCommit(libarchiveRoot, LIBARCHIVE_COMMIT);

copyReviewed(ssokolowRoot, 'build/testfile.rar3.rar', 'rar4.rar');
copyReviewed(ssokolowRoot, 'build/testfile.rar5.rar', 'rar5.rar');

for (let part = 1; part <= 3; part += 1) {
  copyReviewed(
    libarchiveRoot,
    `libarchive/test/test_rar_multivolume_single_file.part${part}.rar.uu`,
    `multipart.part000${part}.rar`,
    { uu: true }
  );
}

for (let part = 1; part <= 4; part += 1) {
  const number = String(part).padStart(2, '0');
  copyReviewed(
    libarchiveRoot,
    `libarchive/test/test_read_format_rar5_multiarchive_solid.part${number}.rar.uu`,
    `rar5-multipart.part${number}.rar`,
    { uu: true }
  );
}
