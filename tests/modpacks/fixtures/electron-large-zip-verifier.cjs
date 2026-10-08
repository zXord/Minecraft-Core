const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createVerifiedZip,
  enumerateArchiveScope
} = require('../../../electron/utils/backup-util.cjs');

const root = path.resolve(process.argv[2] || '');
const canonicalTemp = path.resolve(os.tmpdir());
if (path.dirname(root) !== canonicalTemp ||
    !path.basename(root).startsWith('minecraft-core-electron-zip-runtime-') ||
    path.resolve(fs.realpathSync.native(root)) !== root) {
  throw new TypeError('The Electron ZIP runtime fixture root is invalid');
}

const sourcePath = path.join(root, 'large.bin');
const partPath = path.join(root, 'large.zip.part');
const payload = Buffer.alloc(4 * 1024 * 1024);
for (let index = 0; index < payload.length; index += 1) {
  payload[index] = (index % 251) ^ ((index >>> 8) & 0xff);
}
fs.writeFileSync(sourcePath, payload);
const expectedScope = enumerateArchiveScope([sourcePath]);

const watchdog = setTimeout(() => {
  process.stderr.write('Electron ZIP verification stopped making progress\n');
  process.exit(3);
}, 6_000);

createVerifiedZip({ items: [sourcePath], partPath, expectedScope }).then(
  evidence => {
    clearTimeout(watchdog);
    process.stdout.write(`${JSON.stringify({
      totalBytes: expectedScope.totalBytes,
      fileCount: expectedScope.fileCount,
      archiveSize: evidence.size,
      electron: process.versions.electron,
      node: process.versions.node
    })}\n`);
    process.exit(0);
  },
  error => {
    clearTimeout(watchdog);
    process.stderr.write(`${error?.code || 'UNKNOWN'} ${error?.message || 'ZIP verification failed'}\n`);
    process.exit(2);
  }
);
