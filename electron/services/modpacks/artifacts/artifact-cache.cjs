const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ModpackError } = require('../errors.cjs');

const SHA256 = /^[a-f0-9]{64}$/;

function invalid(field) {
  throw new ModpackError('INVALID_REQUEST', 'Artifact cache request is invalid', { details: { field } });
}

function validSize(size) {
  return typeof size === 'string' && /^(0|[1-9][0-9]*)$/.test(size);
}

function safeBasename(name) {
  return typeof name === 'string' && name === path.basename(name) && name !== '.' && name !== '..' &&
    name === name.trim() && !/[<>:"/\\|?*\u0000-\u001f]/.test(name) && !/[. ]$/.test(name);
}

class ArtifactCache {
  constructor({ root, fsApi = fs, clock = () => Date.now() } = {}) {
    if (typeof root !== 'string' || !root) invalid('root');
    this.root = path.resolve(root);
    this.fs = fsApi;
    this.clock = clock;
    this.references = new Map();
  }

  pathForSha256(digest) {
    if (typeof digest !== 'string' || !SHA256.test(digest)) invalid('sha256');
    return path.join(this.root, 'sha256', digest.slice(0, 2), digest);
  }

  async verifyEntry({ sha256, size }) {
    const entry = this.pathForSha256(sha256);
    if (!validSize(size)) invalid('size');
    try {
      const stat = await this.fs.stat(entry);
      if (!stat.isFile() || BigInt(stat.size) !== BigInt(size)) throw new Error('size mismatch');
      const content = await this.fs.readFile(entry);
      if (crypto.createHash('sha256').update(content).digest('hex') !== sha256) throw new Error('digest mismatch');
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      await this.fs.rm(entry, { force: true }).catch(() => {});
      return false;
    }
  }

  async commitPart({ partialPath, sha256, measuredSize }) {
    if (typeof partialPath !== 'string' || !partialPath) invalid('partialPath');
    if (!validSize(measuredSize)) invalid('measuredSize');
    const resolvedPartial = path.resolve(partialPath);
    if (path.relative(this.root, resolvedPartial).startsWith('..') || path.isAbsolute(path.relative(this.root, resolvedPartial))) invalid('partialPath');
    const contents = await this.fs.readFile(resolvedPartial);
    if (BigInt(contents.length) !== BigInt(measuredSize) || crypto.createHash('sha256').update(contents).digest('hex') !== sha256) {
      throw new ModpackError('HASH_MISMATCH', 'Artifact cache bytes did not match the measured digest');
    }
    const entry = this.pathForSha256(sha256);
    await this.fs.mkdir(path.dirname(entry), { recursive: true });
    if (await this.verifyEntry({ sha256, size: measuredSize })) {
      await this.fs.rm(resolvedPartial, { force: true });
      return entry;
    }
    const temporary = `${entry}.${randomUUID()}.partial`;
    const handle = await this.fs.open(temporary, 'wx');
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await this.fs.rename(temporary, entry);
    } catch (error) {
      if (!error || (error.code !== 'EEXIST' && error.code !== 'EPERM') || !await this.verifyEntry({ sha256, size: measuredSize })) throw error;
      await this.fs.rm(temporary, { force: true });
    }
    if (!await this.verifyEntry({ sha256, size: measuredSize })) {
      throw new ModpackError('HASH_MISMATCH', 'Artifact cache commit could not be verified');
    }
    await this.fs.rm(resolvedPartial, { force: true });
    return entry;
  }

  async materializeSet(verifiedSet, destination) {
    if (!verifiedSet || verifiedSet.type !== 'verified-artifact-set' || !verifiedSet.artifactSet || !Array.isArray(verifiedSet.artifactSet.parts)) invalid('verifiedSet');
    if (typeof destination !== 'string' || !destination) invalid('destination');
    const { parts, primaryPartId } = verifiedSet.artifactSet;
    const aliases = new Set();
    for (const part of parts) {
      if (!part || !safeBasename(part.fileName) || !part.calculatedDigests || !SHA256.test(part.calculatedDigests.sha256) || !validSize(part.measuredSize)) invalid('verifiedSet');
      const alias = part.fileName.normalize('NFC').toLocaleLowerCase('en-US');
      if (aliases.has(alias)) invalid('verifiedSet');
      aliases.add(alias);
      if (!await this.verifyEntry({ sha256: part.calculatedDigests.sha256, size: part.measuredSize })) {
        throw new ModpackError('HASH_MISMATCH', 'Verified artifact cache entry is unavailable');
      }
    }
    const primary = parts.find((part) => part.partId === primaryPartId);
    if (!primary) invalid('verifiedSet');
    await this.fs.rm(destination, { recursive: true, force: true });
    await this.fs.mkdir(destination, { recursive: true });
    for (const part of parts) await this.fs.copyFile(this.pathForSha256(part.calculatedDigests.sha256), path.join(destination, part.fileName));
    return path.join(destination, primary.fileName);
  }

  async removeIfUnreferenced(sha256) {
    const entry = this.pathForSha256(sha256);
    if ((this.references.get(sha256) || 0) > 0) return false;
    try {
      await this.fs.unlink(entry);
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
  }
}

module.exports = { ArtifactCache };
