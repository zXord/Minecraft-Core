const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { TextDecoder } = require('node:util');

const { ModpackError } = require('../electron/services/modpacks/errors.cjs');

const RUNTIME_NAMES = Object.freeze(['7z.exe', '7z.dll', 'License.txt']);
const NOTICE_NAMES = Object.freeze(['BSD-notice.txt', 'LGPL-2.1-or-later.txt', 'NOTICE.md', 'unRAR-restriction.txt']);
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_NOTICE_BYTES = 128 * 1024;
const MAX_PROCESS_BYTES = 1024 * 1024;

const ARCHIVE_RUNTIME_MANIFEST = deepFreeze({
  schemaVersion: 1,
  version: '26.02',
  architecture: 'x64',
  msi: {
    url: 'https://github.com/ip7z/7zip/releases/download/26.02/7z2602-x64.msi',
    size: 1999872,
    sha256: 'db407a4f6d4999e5c7bc00ce8a882be94717b56e7fa68140fe3f12605d91643e'
  },
  source: {
    url: 'https://github.com/ip7z/7zip/releases/download/26.02/7z2602-src.7z',
    sha256: 'c7502dd4557481f52ccf1b3e680329f1fdd207e79a25544afeb3106325474944'
  },
  download: {
    finalHost: 'release-assets.githubusercontent.com',
    size: 1999872,
    sha256: 'db407a4f6d4999e5c7bc00ce8a882be94717b56e7fa68140fe3f12605d91643e'
  },
  authenticode: { status: 'NotSigned' },
  pe: {
    machine: 'AMD64',
    executable: { fileVersion: '26.02', productVersion: '26.02', authenticodeStatus: 'NotSigned' },
    library: { fileVersion: '26.02', productVersion: '26.02', authenticodeStatus: 'NotSigned' }
  },
  handlers: { version: '26.02', zip: true, rar: true },
  files: {
    '7z.exe': { size: 576000, sha256: '83967f1b02b43c4efeda302795722c809e0e81b8307de73558d10484d5676a7d' },
    '7z.dll': { size: 1906688, sha256: '69fd4df057985c40e510e2fac182881c7f85e90aa13ec703f763a8fdb2ce61f8' },
    'License.txt': { size: 6031, sha256: '519ac0a4bded9c18ea02e0afb71f663d8c47373bd9facd3ac96a79f51d77765d' }
  }
});

const NOTICE_IDENTITIES = deepFreeze({
  'BSD-notice.txt': { size: 3667, sha256: '972ae0f3ff83b5e971c3479e4ba1fec7b48b862712cc7337eb66a7d39bae8d33' },
  'LGPL-2.1-or-later.txt': { size: 26419, sha256: 'aadc43ac29e3385e70cf70e54432790f47e9527d7a190fd90275b9860d768cb9' },
  'NOTICE.md': { size: 1465, sha256: '20dc9b9262e5995ba60ea36cc5adba08928a3cf1cc996157f927436e53f714c3' },
  'unRAR-restriction.txt': { size: 640, sha256: 'd0fe728cf2af1aa6dc1d4e057844a5e9b87843eab7694f5246cce56bc87f5f91' }
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function unavailable() {
  return new ModpackError('EXTRACTOR_UNAVAILABLE', 'Bundled archive engine is unavailable');
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function sameScalarObject(value, expected) {
  if (!exactKeys(value, Object.keys(expected))) return false;
  return Object.entries(expected).every(([key, wanted]) => value[key] === wanted);
}

function parseJsonWithoutDuplicateKeys(text) {
  let offset = 0;
  const fail = () => { throw unavailable(); };
  const whitespace = () => {
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x20) break;
      offset += 1;
    }
  };
  const stringValue = () => {
    if (text[offset] !== '"') fail();
    const start = offset++;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code < 0x20) fail();
      if (text[offset] === '"') {
        offset += 1;
        try { return JSON.parse(text.slice(start, offset)); } catch { fail(); }
      }
      if (text[offset] === '\\') {
        offset += 1;
        if (offset >= text.length || !/["\\/bfnrtu]/.test(text[offset])) fail();
        if (text[offset] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(offset + 1, offset + 5))) fail();
          offset += 4;
        }
      }
      offset += 1;
    }
    fail();
  };
  const value = (depth = 0) => {
    if (depth > 32) fail();
    whitespace();
    if (text[offset] === '"') return stringValue();
    if (text[offset] === '{') {
      offset += 1;
      const result = Object.create(null);
      const keys = new Set();
      whitespace();
      if (text[offset] === '}') { offset += 1; return result; }
      for (;;) {
        whitespace();
        const key = stringValue();
        if (keys.has(key)) fail();
        keys.add(key);
        whitespace();
        if (text[offset++] !== ':') fail();
        result[key] = value(depth + 1);
        whitespace();
        if (text[offset] === '}') { offset += 1; return result; }
        if (text[offset++] !== ',') fail();
      }
    }
    if (text[offset] === '[') {
      offset += 1;
      const result = [];
      whitespace();
      if (text[offset] === ']') { offset += 1; return result; }
      for (;;) {
        result.push(value(depth + 1));
        whitespace();
        if (text[offset] === ']') { offset += 1; return result; }
        if (text[offset++] !== ',') fail();
      }
    }
    const remainder = text.slice(offset);
    const number = remainder.match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (number) {
      offset += number[0].length;
      const parsed = Number(number[0]);
      if (!Number.isFinite(parsed)) fail();
      return parsed;
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (remainder.startsWith(literal)) { offset += literal.length; return parsed; }
    }
    fail();
  };
  const parsed = value();
  whitespace();
  if (offset !== text.length) fail();
  return parsed;
}

async function assertDirectory(root, segments, expectedEntries) {
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const stat = await fsp.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  }
  const entries = (await fsp.readdir(cursor)).sort();
  const expected = [...expectedEntries].sort();
  if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) throw unavailable();
  return cursor;
}

async function assertRegularContained(root, segments) {
  const candidate = path.join(root, ...segments);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw unavailable();
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    cursor = path.join(cursor, segment);
    const directory = await fsp.lstat(cursor);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw unavailable();
  }
  const stat = await fsp.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw unavailable();
  const [realRoot, realCandidate] = await Promise.all([fsp.realpath(root), fsp.realpath(candidate)]);
  const realRelative = path.relative(realRoot, realCandidate);
  if (!realRelative || realRelative.startsWith(`..${path.sep}`) || realRelative === '..' || path.isAbsolute(realRelative)) throw unavailable();
  return { candidate, stat };
}

async function measureFile(root, segments, { maxBytes = Number.MAX_SAFE_INTEGER, capture = false } = {}) {
  const { candidate, stat: initial } = await assertRegularContained(root, segments);
  if (!Number.isSafeInteger(initial.size) || initial.size > maxBytes) throw unavailable();
  const handle = await fsp.open(candidate, 'r');
  const hash = crypto.createHash('sha256');
  const chunks = [];
  let measured = 0;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== initial.size) throw unavailable();
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      measured += chunk.length;
      if (measured > maxBytes || measured > initial.size) throw unavailable();
      hash.update(chunk);
      if (capture) chunks.push(chunk);
    }
    const after = await handle.stat();
    if (measured !== initial.size || after.size !== initial.size || after.mtimeMs !== opened.mtimeMs || after.ino !== opened.ino || after.dev !== opened.dev) {
      throw unavailable();
    }
  } finally {
    await handle.close();
  }
  return { size: measured, sha256: hash.digest('hex'), bytes: capture ? Buffer.concat(chunks) : undefined, path: candidate };
}

function validateManifest(manifest) {
  if (!exactKeys(manifest, ['schemaVersion', 'version', 'architecture', 'msi', 'source', 'acquiredAt', 'download', 'authenticode', 'pe', 'handlers', 'files'])) throw unavailable();
  if (manifest.schemaVersion !== 1 || manifest.version !== '26.02' || manifest.architecture !== 'x64') throw unavailable();
  if (!sameScalarObject(manifest.msi, ARCHIVE_RUNTIME_MANIFEST.msi) || !sameScalarObject(manifest.source, ARCHIVE_RUNTIME_MANIFEST.source)) throw unavailable();
  if (!sameScalarObject(manifest.download, ARCHIVE_RUNTIME_MANIFEST.download) || !sameScalarObject(manifest.authenticode, ARCHIVE_RUNTIME_MANIFEST.authenticode)) throw unavailable();
  if (typeof manifest.acquiredAt !== 'string' || manifest.acquiredAt.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|\+00:00)$/.test(manifest.acquiredAt) || !Number.isFinite(Date.parse(manifest.acquiredAt))) throw unavailable();
  if (!exactKeys(manifest.pe, ['machine', 'executable', 'library']) || manifest.pe.machine !== 'AMD64') throw unavailable();
  if (!sameScalarObject(manifest.pe.executable, ARCHIVE_RUNTIME_MANIFEST.pe.executable) || !sameScalarObject(manifest.pe.library, ARCHIVE_RUNTIME_MANIFEST.pe.library)) throw unavailable();
  if (!sameScalarObject(manifest.handlers, ARCHIVE_RUNTIME_MANIFEST.handlers) || !exactKeys(manifest.files, RUNTIME_NAMES)) throw unavailable();
  for (const name of RUNTIME_NAMES) {
    const record = manifest.files[name];
    const expected = ARCHIVE_RUNTIME_MANIFEST.files[name];
    if (!exactKeys(record, ['size', 'sha256']) || !Number.isSafeInteger(record.size) || record.size <= 0 || !/^[a-f0-9]{64}$/.test(record.sha256) || !sameScalarObject(record, expected)) throw unavailable();
  }
  return manifest;
}

async function verifyAmd64Pe(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const header = Buffer.alloc(64);
    if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length || header.readUInt16LE(0) !== 0x5a4d) throw unavailable();
    const peOffset = header.readUInt32LE(0x3c);
    const pe = Buffer.alloc(6);
    if (!Number.isSafeInteger(peOffset) || peOffset < 64 || (await handle.read(pe, 0, pe.length, peOffset)).bytesRead !== pe.length) throw unavailable();
    if (pe.readUInt32LE(0) !== 0x00004550 || pe.readUInt16LE(4) !== 0x8664) throw unavailable();
  } finally {
    await handle.close();
  }
}

function spawnBounded(executable, args, { timeoutMs = 30000, maxStdoutBytes = MAX_PROCESS_BYTES, maxStderrBytes = MAX_PROCESS_BYTES, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    let child;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    try {
      child = childProcess.spawn(executable, args, {
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('deadline'));
    }, timeoutMs);
    child.once('error', error => finish(error));
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        child.kill();
        finish(new Error('stdout limit'));
      } else stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) {
        child.kill();
        finish(new Error('stderr limit'));
      } else stderr.push(chunk);
    });
    child.once('close', code => finish(null, { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}

function decodeProcessText(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : '');
  if (bytes.length > MAX_PROCESS_BYTES) throw unavailable();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw unavailable(); }
}

async function defaultInspectVersion(filePath) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (typeof systemRoot !== 'string' || !path.isAbsolute(systemRoot)) throw unavailable();
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const windowsModules = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  const command = '$p=$env:MINECRAFT_CORE_ARCHIVE_RUNTIME_FILE;$v=[Diagnostics.FileVersionInfo]::GetVersionInfo($p);$s=Get-AuthenticodeSignature -LiteralPath $p;[Console]::Out.Write(($v.FileVersion+"`n"+$v.ProductVersion+"`n"+$s.Status+"`n"+$s.SignatureType))';
  const result = await spawnBounded(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    env: {
      ...process.env,
      MINECRAFT_CORE_ARCHIVE_RUNTIME_FILE: filePath,
      PSModulePath: `${windowsModules};${process.env.PSModulePath || ''}`
    },
    timeoutMs: 15000,
    maxStdoutBytes: 4096,
    maxStderrBytes: 4096
  });
  const stdout = decodeProcessText(result.stdout).trim().split(/\r?\n/);
  const stderr = decodeProcessText(result.stderr);
  if (result.code !== 0 || stderr.length !== 0 || stdout.length !== 4 || stdout[2] !== 'NotSigned' || stdout[3] !== 'None') throw unavailable();
  return { fileVersion: stdout[0], productVersion: stdout[1], authenticodeStatus: stdout[2] };
}

async function defaultRunEngine(executable) {
  return spawnBounded(executable, ['i'], { timeoutMs: 30000 });
}

async function verifyArchiveRuntime(root, options = {}) {
  try {
    const platform = options.platform ?? process.platform;
    const architecture = options.architecture ?? process.arch;
    if (platform !== 'win32' || architecture !== 'x64') throw unavailable();
    if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) throw unavailable();
    const repositoryRoot = path.resolve(root);
    const rootStat = await fsp.lstat(repositoryRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw unavailable();

    await assertDirectory(repositoryRoot, ['build-resources', 'archive-runtime'], ['7zip-26.02.json']);
    await assertDirectory(repositoryRoot, ['vendor', '7zip', 'x64'], RUNTIME_NAMES);
    await assertDirectory(repositoryRoot, ['third-party', '7zip'], NOTICE_NAMES);

    const manifestFile = await measureFile(repositoryRoot, ['build-resources', 'archive-runtime', '7zip-26.02.json'], { maxBytes: MAX_MANIFEST_BYTES, capture: true });
    let manifestText;
    try { manifestText = new TextDecoder('utf-8', { fatal: true }).decode(manifestFile.bytes); } catch { throw unavailable(); }
    const manifest = validateManifest(parseJsonWithoutDuplicateKeys(manifestText));

    const files = [];
    for (const name of RUNTIME_NAMES) {
      const measured = await measureFile(repositoryRoot, ['vendor', '7zip', 'x64', name]);
      const expected = manifest.files[name];
      if (measured.size !== expected.size || measured.sha256 !== expected.sha256) throw unavailable();
      files.push({ name, size: measured.size, sha256: measured.sha256, path: measured.path });
    }
    for (const name of NOTICE_NAMES) {
      const measured = await measureFile(repositoryRoot, ['third-party', '7zip', name], { maxBytes: MAX_NOTICE_BYTES });
      const expected = NOTICE_IDENTITIES[name];
      if (measured.size !== expected.size || measured.sha256 !== expected.sha256) throw unavailable();
    }

    const executable = files.find(file => file.name === '7z.exe').path;
    const library = files.find(file => file.name === '7z.dll').path;
    await verifyAmd64Pe(executable);
    await verifyAmd64Pe(library);

    const inspectVersion = options.inspectVersion ?? defaultInspectVersion;
    for (const [filePath, expected] of [[executable, manifest.pe.executable], [library, manifest.pe.library]]) {
      const actual = await inspectVersion(filePath);
      if (!sameScalarObject(actual, expected)) throw unavailable();
    }

    const runEngine = options.runEngine ?? defaultRunEngine;
    const result = await runEngine(executable, ['i'], { shell: false, windowsHide: true, stdin: 'closed', timeoutMs: 30000, maxStdoutBytes: MAX_PROCESS_BYTES, maxStderrBytes: MAX_PROCESS_BYTES });
    const stdout = decodeProcessText(result?.stdout);
    const stderr = decodeProcessText(result?.stderr);
    if (result?.code !== 0 || stderr.length !== 0 || !/^7-Zip 26\.02 \(x64\)/m.test(stdout)) throw unavailable();
    const formats = stdout.match(/(?:^|\r?\n)Formats:\r?\n([\s\S]*?)(?=\r?\n\r?\n(?:Codecs|Hashers):|$)/i)?.[1] ?? '';
    if (!/^\s*0\s+[^\r\n]*\bZip\b/im.test(formats) || !/^\s*0\s+[^\r\n]*\bRar(?:5)?\b/im.test(formats)) throw unavailable();

    return deepFreeze({
      version: manifest.version,
      architecture: manifest.architecture,
      handlers: { zip: true, rar: true },
      files: files.map(({ name, size, sha256 }) => ({ name, size, sha256 }))
    });
  } catch (error) {
    if (error instanceof ModpackError && error.code === 'EXTRACTOR_UNAVAILABLE') throw error;
    throw unavailable();
  }
}

module.exports = {
  ARCHIVE_RUNTIME_MANIFEST,
  verifyArchiveRuntime
};

if (require.main === module) {
  verifyArchiveRuntime(path.resolve(__dirname, '..')).then(result => {
    process.stdout.write(`Verified 7-Zip ${result.version} ${result.architecture} archive runtime\n`);
  }).catch(error => {
    process.stderr.write(`${error?.safeMessage || 'Bundled archive engine is unavailable'}\n`);
    process.exitCode = 1;
  });
}
