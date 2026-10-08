const fs = require('node:fs');
const path = require('node:path');
const {
  JAVA_ARCHIVE_WORKER_TOKEN_ENV,
  createJavaArchiveResponse,
  javaArchiveStagingPath,
  verifyJavaArchiveRequest
} = require('../../electron/services/java-archive-worker-protocol.cjs');

const token = process.env[JAVA_ARCHIVE_WORKER_TOKEN_ENV];
delete process.env[JAVA_ARCHIVE_WORKER_TOKEN_ENV];

process.once('message', message => {
  let request;
  try {
    request = verifyJavaArchiveRequest(message, token);
  } catch {
    process.exit(64);
    return;
  }
  const stagingPath = javaArchiveStagingPath(request.payload.destinationPath, request.requestId);
  fs.mkdirSync(path.join(stagingPath, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(stagingPath, 'bin', 'java.exe'), 'java');
  const deadline = Date.now() + 250;
  while (Date.now() < deadline) {
    // Deliberately occupy this child to prove the parent event loop stays responsive.
  }
  const response = createJavaArchiveResponse({
    token,
    requestId: request.requestId,
    ok: true,
    result: {
      entryCount: 1,
      expandedBytes: '4',
      javaExecutableRelativePath: 'bin/java.exe'
    }
  });
  process.send(response, error => {
    if (!error) process.disconnect();
    process.exit(error ? 70 : 0);
  });
});
