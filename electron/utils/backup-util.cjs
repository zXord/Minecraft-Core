const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const archiver = require('archiver');
const yauzl = require('yauzl');

const { ModpackError } = require('../services/modpacks/errors.cjs');
const { strictJsonClone } = require('./durable-fs.cjs');

const SCOPE_SCHEMA_VERSION = 1;
const SCOPE_HASH_PATTERN = /^[a-f0-9]{64}$/;

function backupFailure(cause) {
  if (cause instanceof ModpackError && cause.code === 'BACKUP_FAILED') return cause;
  return new ModpackError('BACKUP_FAILED', 'The restore point could not be verified', { cause });
}

function sameLocalPath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLocaleLowerCase('en-US') === resolvedRight.toLocaleLowerCase('en-US')
    : resolvedLeft === resolvedRight;
}

function stableFileDigest(filePath, fsApi = fs) {
  let descriptor = null;
  try {
    const beforePath = fsApi.lstatSync(filePath, { bigint: true });
    if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw backupFailure();
    descriptor = fsApi.openSync(filePath, 'r');
    const before = fsApi.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino) throw backupFailure();
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0n;
    while (true) {
      const count = fsApi.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length) throw backupFailure();
      if (count === 0) break;
      total += BigInt(count);
      hash.update(buffer.subarray(0, count));
    }
    const after = fsApi.fstatSync(descriptor, { bigint: true });
    fsApi.closeSync(descriptor);
    descriptor = null;
    const afterPath = fsApi.lstatSync(filePath, { bigint: true });
    const same = before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
      before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs &&
      before.dev === afterPath.dev && before.ino === afterPath.ino && before.size === afterPath.size &&
      before.mtimeNs === afterPath.mtimeNs && before.ctimeNs === afterPath.ctimeNs && total === before.size;
    if (!same) throw backupFailure();
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw backupFailure();
    return { sha256: hash.digest('hex'), size: Number(total) };
  } catch (error) {
    if (descriptor !== null) {
      try { fsApi.closeSync(descriptor); } catch { /* preserve primary error */ }
    }
    throw backupFailure(error);
  }
}

function normalizeArchiveEntryPath(value, { directory = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw backupFailure();
  const normalized = value.replaceAll('\\', '/');
  const withoutSlash = directory && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  if (!withoutSlash || withoutSlash.startsWith('/') || path.posix.isAbsolute(withoutSlash) || path.win32.isAbsolute(withoutSlash)) {
    throw backupFailure();
  }
  const segments = withoutSlash.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment !== segment.normalize('NFC'))) {
    throw backupFailure();
  }
  return directory ? `${withoutSlash}/` : withoutSlash;
}

function scopeHash(entries) {
  return crypto.createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');
}

function enumerateArchiveScopeInternal(items, fsApi = fs) {
  try {
    if (!Array.isArray(items) || items.length === 0 || Object.getPrototypeOf(items) !== Array.prototype ||
        Object.getOwnPropertySymbols(items).length !== 0) throw backupFailure();
    const itemDescriptors = Object.getOwnPropertyDescriptors(items);
    const expectedNames = new Set(['length']);
    for (let index = 0; index < items.length; index += 1) expectedNames.add(String(index));
    if (Object.getOwnPropertyNames(items).some(name => !expectedNames.has(name))) throw backupFailure();
    for (let index = 0; index < items.length; index += 1) {
      const descriptor = itemDescriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
          typeof descriptor.value !== 'string' || !path.isAbsolute(descriptor.value)) throw backupFailure();
    }
    const resolvedItems = items.map(item => path.resolve(item));
    const parent = path.dirname(resolvedItems[0]);
    if (resolvedItems.some(item => path.dirname(item) !== parent) || new Set(resolvedItems).size !== resolvedItems.length) {
      throw backupFailure();
    }
    const entries = [];
    const names = new Set();

    function walk(sourcePath, archivePath) {
      const stat = fsApi.lstatSync(sourcePath, { bigint: true });
      if (stat.isSymbolicLink() || !sameLocalPath(fsApi.realpathSync.native(sourcePath), sourcePath)) throw backupFailure();
      if (stat.isDirectory()) {
        const name = normalizeArchiveEntryPath(archivePath, { directory: true });
        if (names.has(name)) throw backupFailure();
        names.add(name);
        entries.push({ path: name, type: 'directory', size: 0, sha256: null, sourcePath });
        const children = fsApi.readdirSync(sourcePath, { withFileTypes: true })
          .sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
        for (const child of children) walk(path.join(sourcePath, child.name), `${name}${child.name}`);
        const after = fsApi.lstatSync(sourcePath, { bigint: true });
        if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino ||
            after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) throw backupFailure();
        return;
      }
      if (!stat.isFile()) throw backupFailure();
      const name = normalizeArchiveEntryPath(archivePath);
      if (names.has(name) || names.has(`${name}/`)) throw backupFailure();
      const evidence = stableFileDigest(sourcePath, fsApi);
      names.add(name);
      entries.push({ path: name, type: 'file', size: evidence.size, sha256: evidence.sha256, sourcePath });
    }

    for (const item of [...resolvedItems].sort((left, right) => path.basename(left).localeCompare(path.basename(right), 'en-US'))) {
      walk(item, path.basename(item));
    }
    entries.sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
    const publicEntries = entries.map(({ path: entryPath, type, size, sha256 }) => ({ path: entryPath, type, size, sha256 }));
    return {
      internalEntries: entries,
      publicScope: Object.freeze({
        schemaVersion: SCOPE_SCHEMA_VERSION,
        entries: Object.freeze(publicEntries.map(entry => Object.freeze(entry))),
        totalBytes: publicEntries.reduce((total, entry) => total + entry.size, 0),
        fileCount: publicEntries.filter(entry => entry.type === 'file').length,
        scopeSha256: scopeHash(publicEntries)
      })
    };
  } catch (error) {
    throw backupFailure(error);
  }
}

function enumerateArchiveScope(items, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.getPrototypeOf(options) !== Object.prototype || Object.keys(options).some(key => key !== 'fsApi')) throw backupFailure();
  return enumerateArchiveScopeInternal(items, options.fsApi || fs).publicScope;
}

function normalizeExpectedScope(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw backupFailure();
    }
    const clone = strictJsonClone(value, { maxDepth: 8, maxCollection: 250_000, maxStringBytes: 4096 });
    if (clone.schemaVersion !== SCOPE_SCHEMA_VERSION || !Array.isArray(clone.entries) ||
        !Number.isSafeInteger(clone.totalBytes) || clone.totalBytes < 0 ||
        !Number.isSafeInteger(clone.fileCount) || clone.fileCount < 0 ||
        typeof clone.scopeSha256 !== 'string' || !SCOPE_HASH_PATTERN.test(clone.scopeSha256)) throw backupFailure();
    const entries = clone.entries.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          !['directory', 'file'].includes(entry.type) || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
          (entry.type === 'directory' ? entry.sha256 !== null || entry.size !== 0 :
            typeof entry.sha256 !== 'string' || !SCOPE_HASH_PATTERN.test(entry.sha256))) throw backupFailure();
      return {
        path: normalizeArchiveEntryPath(entry.path, { directory: entry.type === 'directory' }),
        type: entry.type,
        size: entry.size,
        sha256: entry.sha256
      };
    });
    if (new Set(entries.map(entry => entry.path)).size !== entries.length ||
        entries.reduce((total, entry) => total + entry.size, 0) !== clone.totalBytes ||
        entries.filter(entry => entry.type === 'file').length !== clone.fileCount ||
        scopeHash(entries) !== clone.scopeSha256) throw backupFailure();
    return { schemaVersion: SCOPE_SCHEMA_VERSION, entries, totalBytes: clone.totalBytes, fileCount: clone.fileCount, scopeSha256: clone.scopeSha256 };
  } catch (error) {
    throw backupFailure(error);
  }
}

function openZipStreaming(descriptor, yauzlApi) {
  return new Promise((resolve, reject) => {
    yauzlApi.fromFd(descriptor, {
      autoClose: false,
      decodeStrings: true,
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true
    }, (error, zip) => error ? reject(error) : resolve(zip));
  });
}

async function verifyZipScopeStreaming(zipPath, expectedScope, options = {}) {
  let descriptor = null;
  try {
    if (typeof zipPath !== 'string' || !path.isAbsolute(zipPath) || !options || typeof options !== 'object' ||
        Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype ||
        Object.keys(options).some(key => !['yauzlApi', 'onChunk'].includes(key)) ||
        (options.onChunk !== undefined && typeof options.onChunk !== 'function')) throw backupFailure();
    const expected = normalizeExpectedScope(expectedScope);
    const yauzlApi = options.yauzlApi || yauzl;
    if (!yauzlApi || typeof yauzlApi.fromFd !== 'function') throw backupFailure();
    const before = fs.lstatSync(zipPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || !sameLocalPath(fs.realpathSync.native(zipPath), zipPath)) {
      throw backupFailure();
    }
    descriptor = fs.openSync(zipPath, 'r');
    const pinnedBefore = fs.fstatSync(descriptor, { bigint: true });
    if (!pinnedBefore.isFile() || before.dev !== pinnedBefore.dev || before.ino !== pinnedBefore.ino ||
        before.birthtimeNs !== pinnedBefore.birthtimeNs || before.size !== pinnedBefore.size) throw backupFailure();
    const archiveHash = crypto.createHash('sha256');
    const hashBuffer = Buffer.allocUnsafe(1024 * 1024);
    let archiveBytes = 0;
    while (true) {
      const count = fs.readSync(descriptor, hashBuffer, 0, hashBuffer.length, archiveBytes);
      if (!Number.isSafeInteger(count) || count < 0 || count > hashBuffer.length) throw backupFailure();
      if (count === 0) break;
      archiveHash.update(hashBuffer.subarray(0, count));
      archiveBytes += count;
      if (!Number.isSafeInteger(archiveBytes)) throw backupFailure();
    }
    hashBuffer.fill(0);
    if (BigInt(archiveBytes) !== pinnedBefore.size) throw backupFailure();
    const archiveSha256 = archiveHash.digest('hex');
    const zip = await openZipStreaming(descriptor, yauzlApi);
    const declared = new Map(expected.entries.map(entry => [entry.path, entry]));
    const observed = new Set();
    let totalBytes = 0;
    let fileCount = 0;
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
          try { zip.close(); } catch { /* preserve verification failure */ }
        reject(error);
      };
      zip.once('error', fail);
      zip.on('entry', entry => {
        try {
          const isDirectory = entry.fileName.endsWith('/');
          const normalizedName = normalizeArchiveEntryPath(entry.fileName, { directory: isDirectory });
          const expectedEntry = declared.get(normalizedName);
          if (!expectedEntry || observed.has(normalizedName) || isDirectory !== (expectedEntry.type === 'directory') ||
              !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize !== expectedEntry.size) throw backupFailure();
          observed.add(normalizedName);
          if (isDirectory) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (error, stream) => {
            if (error) { fail(error); return; }
            const hash = crypto.createHash('sha256');
            let measured = 0;
            stream.on('data', chunk => {
              try {
                if (!Buffer.isBuffer(chunk)) throw backupFailure();
                measured += chunk.length;
                if (!Number.isSafeInteger(measured) || measured > expectedEntry.size) throw backupFailure();
                hash.update(chunk);
                options.onChunk?.(chunk);
              } catch (streamError) {
                stream.destroy(streamError);
              }
            });
            stream.once('error', fail);
            stream.once('end', () => {
              try {
                if (measured !== expectedEntry.size || hash.digest('hex') !== expectedEntry.sha256) throw backupFailure();
                totalBytes += measured;
                fileCount += 1;
                zip.readEntry();
              } catch (streamError) {
                fail(streamError);
              }
            });
          });
        } catch (error) {
          fail(error);
        }
      });
      zip.once('end', () => {
        if (settled) return;
        try {
          if (observed.size !== declared.size || totalBytes !== expected.totalBytes || fileCount !== expected.fileCount) {
            throw backupFailure();
          }
          settled = true;
          resolve();
        } catch (error) {
          fail(error);
        }
      });
      zip.readEntry();
    });
    const pinnedAfter = fs.fstatSync(descriptor, { bigint: true });
    const after = fs.lstatSync(zipPath, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || pinnedBefore.dev !== pinnedAfter.dev || pinnedBefore.ino !== pinnedAfter.ino ||
        pinnedBefore.size !== pinnedAfter.size || pinnedBefore.birthtimeNs !== pinnedAfter.birthtimeNs ||
        pinnedBefore.mtimeNs !== pinnedAfter.mtimeNs || pinnedBefore.ctimeNs !== pinnedAfter.ctimeNs ||
        pinnedBefore.dev !== after.dev || pinnedBefore.ino !== after.ino || pinnedBefore.size !== after.size ||
        pinnedBefore.birthtimeNs !== after.birthtimeNs || pinnedBefore.mtimeNs !== after.mtimeNs ||
        pinnedBefore.ctimeNs !== after.ctimeNs) throw backupFailure();
    fs.closeSync(descriptor);
    descriptor = null;
    return Object.freeze({
      scopeSha256: expected.scopeSha256,
      totalBytes,
      fileCount,
      archiveSha256,
      archiveSize: archiveBytes,
      archiveIdentity: Object.freeze({
        dev: String(after.dev),
        ino: String(after.ino),
        size: String(after.size),
        birthtimeNs: String(after.birthtimeNs),
        mtimeNs: String(after.mtimeNs),
        ctimeNs: String(after.ctimeNs)
      })
    });
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* preserve verification failure */ }
    }
    throw backupFailure(error);
  }
}

async function createVerifiedZip({
  items,
  partPath,
  expectedScope,
  onProgress = null,
  fsApi = fs,
  archiveFactory = archiver,
  zipStreamVerifier = verifyZipScopeStreaming,
  faultInjector = () => {}
} = {}) {
  let descriptor = null;
  try {
    if (typeof partPath !== 'string' || !path.isAbsolute(partPath) || !partPath.endsWith('.part') ||
        (onProgress !== null && typeof onProgress !== 'function') || typeof archiveFactory !== 'function' ||
        typeof zipStreamVerifier !== 'function' || typeof faultInjector !== 'function') throw backupFailure();
    const parent = path.dirname(partPath);
    const parentStat = fsApi.lstatSync(parent, { bigint: true });
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() ||
        !sameLocalPath(fsApi.realpathSync.native(parent), parent)) throw backupFailure();
    const expected = normalizeExpectedScope(expectedScope);
    const current = enumerateArchiveScopeInternal(items, fsApi);
    if (JSON.stringify(current.publicScope) !== JSON.stringify(expected)) throw backupFailure();
    descriptor = fsApi.openSync(partPath, 'wx', 0o600);
    const output = fsApi.createWriteStream(partPath, { fd: descriptor, autoClose: false });
    const archive = archiveFactory('zip', { zlib: { level: 1 } });
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      output.on('error', fail);
      archive.on('error', fail);
      archive.on('progress', progress => {
        if (onProgress) onProgress(progress);
      });
      output.on('finish', () => {
        if (settled) return;
        try {
          faultInjector('before-archive-close');
          fsApi.fsyncSync(descriptor);
          fsApi.closeSync(descriptor);
          descriptor = null;
          settled = true;
          resolve();
        } catch (error) {
          fail(error);
        }
      });
      archive.pipe(output);
      for (const entry of current.internalEntries) {
        if (entry.type === 'directory') archive.append(Buffer.alloc(0), { name: entry.path });
        else archive.file(entry.sourcePath, { name: entry.path });
      }
      archive.finalize().catch(fail);
    });

    faultInjector('during-integrity-test');
    faultInjector('during-manifest-comparison');
    const archiveEvidence = await zipStreamVerifier(partPath, expected);
    return Object.freeze({
      sha256: archiveEvidence.archiveSha256,
      size: archiveEvidence.archiveSize,
      scopeSha256: expected.scopeSha256,
      scope: Object.freeze(expected)
    });
  } catch (error) {
    if (descriptor !== null) {
      try { fsApi.closeSync(descriptor); } catch { /* preserve primary error */ }
    }
    throw backupFailure(error);
  }
}

function shouldIgnoreArchiveEntry(fileName) {
  const normalized = String(fileName || '').toLowerCase();
  return normalized.endsWith('~')
    || normalized.startsWith('tmp')
    || normalized.endsWith('.lock')
    || normalized.endsWith('.tmp');
}

function calculateArchiveInputSize(items) {
  const summary = {
    totalBytes: 0,
    fileCount: 0
  };

  const walk = (itemPath) => {
    if (!fs.existsSync(itemPath)) {
      return;
    }

    const stats = fs.statSync(itemPath);
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(itemPath, { withFileTypes: true })) {
        if (shouldIgnoreArchiveEntry(entry.name)) {
          continue;
        }
        walk(path.join(itemPath, entry.name));
      }
      return;
    }

    if (stats.isFile()) {
      summary.totalBytes += stats.size;
      summary.fileCount += 1;
    }
  };

  for (const item of items) {
    walk(item);
  }

  return summary;
}

function normalizeCompressionLevel(level) {
  const numericLevel = Number(level);
  if (Number.isInteger(numericLevel) && numericLevel >= 0 && numericLevel <= 9) {
    return numericLevel;
  }
  return 5;
}

/**
 * Create a zip file from a list of folders or files
 * 
 * @param {Array<string>} items - Paths to folders or files to include in the zip
 * @param {string} outputPath - Path where to save the zip file
 * @returns {Promise<void>} - Resolves when zip is created
 */
async function createZip(items, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
      const inputSummary = options.inputSummary || calculateArchiveInputSize(items);
      const compressionLevel = normalizeCompressionLevel(options.compressionLevel);
      const expectedTotalBytes = Number(inputSummary.totalBytes) || 0;
      const expectedEntriesTotal = Number(inputSummary.fileCount) || items.length;
      let settled = false;
      let lastProgressAt = 0;

      const emitProgress = (payload, { force = false } = {}) => {
        if (!onProgress) return;
        const now = Date.now();
        if (!force && now - lastProgressAt < 500) return;
        lastProgressAt = now;
        onProgress(payload);
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const output = fs.createWriteStream(outputPath);
      const archive = (/** @type {any} */ (archiver))('zip', {
        zlib: { level: compressionLevel }
      });
      
      output.on('error', (err) => {
        output.end();
        fail(err);
      });

      archive.on('error', (err) => {
        output.end();
        fail(err);
      });
      
      output.on('close', () => {
        if (settled) return;
        settled = true;
        emitProgress({
          phase: 'complete',
          percent: 100,
          processedBytes: expectedTotalBytes || archive.pointer(),
          totalBytes: expectedTotalBytes,
          entriesTotal: expectedEntriesTotal
        }, { force: true });
        resolve();
      });
      archive.on('warning', (err) => {
        if (err.code !== 'ENOENT') {
          fail(err);
        }
      });

      archive.on('progress', (progress) => {
        const processedBytes = progress?.fs?.processedBytes || 0;
        const totalBytes = expectedTotalBytes || progress?.fs?.totalBytes || 0;
        const entriesProcessed = progress?.entries?.processed || 0;
        const entriesTotal = expectedEntriesTotal || progress?.entries?.total || 0;
        const bytePercent = totalBytes > 0 ? (processedBytes / totalBytes) * 100 : null;
        const entryPercent = entriesTotal > 0 ? (entriesProcessed / entriesTotal) * 100 : null;
        const percent = bytePercent ?? entryPercent;

        emitProgress({
          phase: 'zipping',
          percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null,
          processedBytes,
          totalBytes,
          entriesProcessed,
          entriesTotal
        });
      });

      archive.pipe(output);

      for (const item of items) {
          if (!fs.existsSync(item)) {
            continue;
          }
          
          const itemName = path.basename(item);
          const stats = fs.statSync(item);
          
          if (stats.isDirectory()) {
            archive.glob('**/*', {
              cwd: item,
              ignore: ['**/*~', '**/tmp*', '**/*.lock', '**/*.tmp'],
              dot: true
            }, { prefix: itemName });
          } else {
            fs.accessSync(item, fs.constants.R_OK);
            archive.file(item, { name: itemName });
          }
      }
      
      emitProgress({
        phase: 'queued',
        percent: 0,
        processedBytes: 0,
        totalBytes: expectedTotalBytes,
        entriesTotal: expectedEntriesTotal
      }, { force: true });
      archive.finalize();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Create a backup of the entire server or specific folders
 * 
 * @param {string} serverPath - Path to the server directory
 * @param {Array<string>} [folders] - Optional list of specific folders to backup
 * @returns {Promise<string>} - Path to the created backup file
 */
async function createServerBackup(serverPath, folders = null) {
    const backupDir = path.join(serverPath, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilename = `server-backup-${timestamp}.zip`;
    const backupPath = path.join(backupDir, backupFilename);
    
    let itemsToBackup = [];
    
    if (folders && Array.isArray(folders) && folders.length > 0) {
      itemsToBackup = folders.map(folder => path.join(serverPath, folder))
        .filter(folderPath => fs.existsSync(folderPath));
    } else {
      const defaultFolders = ['world', 'world_nether', 'world_the_end', 'config', 'mods'];
      itemsToBackup = defaultFolders.map(folder => path.join(serverPath, folder))
        .filter(folderPath => fs.existsSync(folderPath));
      
        const serverPropertiesPath = path.join(serverPath, 'server.properties');
      if (fs.existsSync(serverPropertiesPath)) {
        itemsToBackup.push(serverPropertiesPath);
      }
    }
    
    if (itemsToBackup.length === 0) {
      throw new Error('No valid folders or files found to backup');
    }
    
    await createZip(itemsToBackup, backupPath);
    return backupPath;
}

/**
 * List available backups for a server
 * 
 * @param {string} serverPath - Path to the server directory
 * @returns {Promise<Array<Object>>} - List of backup info objects
 */
async function listBackups(serverPath) {
  try {
    const backupDir = path.join(serverPath, 'backups');
    if (!fs.existsSync(backupDir)) {
      return [];
    }
    
    const backupFiles = fs.readdirSync(backupDir)
      .filter(file => file.endsWith('.zip'))
      .map(file => {
        const filePath = path.join(backupDir, file);
        const stats = fs.statSync(filePath);
        
        return {
          name: file,
          path: filePath,
          size: stats.size,
          created: stats.mtime
        };
      })
        .sort((a, b) => b.created.getTime() - a.created.getTime());
    
    return backupFiles;
    } catch {
      return [];
    }
  }

module.exports = {
  createVerifiedZip,
  createZip,
  createServerBackup,
  enumerateArchiveScope,
  listBackups,
  calculateArchiveInputSize,
  normalizeCompressionLevel,
  verifyZipScopeStreaming
}; 
