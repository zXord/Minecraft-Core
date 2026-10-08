const fs = require('node:fs');

const chunks = [];

process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.once('end', () => {
  const frame = Buffer.concat(chunks);
  if (frame.length < 5 || frame.readUInt32LE(0) !== frame.length - 4) process.exit(64);
  let request;
  try { request = JSON.parse(frame.subarray(4).toString('utf8')); } catch { process.exit(64); }
  const deadline = Date.now() + 250;
  while (Date.now() < deadline) {
    // Deliberately synchronous: this must block only the native-helper process.
  }
  if (request.operation === 'move-write-through' || request.operation === 'replace-file-write-through') {
    fs.renameSync(request.sourcePath, request.destinationPath);
  }
  const body = Buffer.from(JSON.stringify({ ok: true }), 'utf8');
  const responseFrame = Buffer.allocUnsafe(body.length + 4);
  responseFrame.writeUInt32LE(body.length, 0);
  body.copy(responseFrame, 4);
  process.stdout.write(responseFrame, () => process.exit(0));
});
