'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeRuntimeTuple } = require('../modpacks/contracts.cjs');
const { waitForRuntimeWorkerQuiescence } = require('../runtime-worker-quiescence.cjs');
const { assertRuntimeConstraints } = require('./client-runtime-constraints.cjs');

function failure(code = 'RUNTIME_INCOMPLETE') {
  if (!['RUNTIME_INCOMPLETE', 'UNSUPPORTED_LOADER', 'CANCELLED', 'LOADER_VERSION_REQUIRED', 'LOADER_VERSION_UNAVAILABLE'].includes(code)) code = 'RUNTIME_INCOMPLETE';
  return Object.assign(new Error(code === 'UNSUPPORTED_LOADER' ? 'The client loader is unsupported.' : 'The exact client runtime is incomplete.'), { code });
}
function normalizeClientRuntime(value) {
  const runtime = normalizeRuntimeTuple(value);
  if (!['vanilla', 'fabric', 'forge'].includes(runtime.loaderFamily)) throw failure('UNSUPPORTED_LOADER');
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(runtime.loaderVersion) || /^(latest|release|snapshot)$/i.test(runtime.loaderVersion)) throw failure();
  if (runtime.loaderFamily === 'vanilla' && runtime.loaderVersion !== runtime.minecraftVersion) throw failure();
  return runtime;
}
function relative(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\\:\u0000-\u001f\u007f]/u.test(value) || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) throw failure();
  return value;
}
function safePath(root, name = '', directory = false) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root) throw failure();
  const parts = name ? relative(name).split('/') : [];
  let current = root;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || ((index < parts.length - 1 || directory) ? !stat.isDirectory() : !stat.isFile()) || (!stat.isDirectory() && stat.nlink !== 1)) throw failure();
    const real = fs.realpathSync.native(current);
    const identity = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (identity(real) !== identity(current)) throw failure();
  }
  return current;
}
function readJson(root, name, maximum = 16 * 1024 * 1024) {
  const target = safePath(root, name);
  if (fs.statSync(target).size > maximum) throw failure();
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}
async function verifyFile(root, name, download = {}) {
  const target = safePath(root, name);
  const stat = fs.statSync(target);
  if (stat.size < 1 || (Number.isSafeInteger(download.size) && download.size >= 0 && stat.size !== download.size)) throw failure();
  // XMCL uses size:-1 and sha1:'' for Maven coordinates without checksums.
  if (download.sha1 !== undefined && download.sha1 !== '') {
    if (!/^[a-f0-9]{40}$/i.test(download.sha1)) throw failure();
    const hash = crypto.createHash('sha1');
    for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
    if (hash.digest('hex') !== download.sha1.toLowerCase()) throw failure();
  }
  return target;
}
function exactLoader(profile, runtime) {
  const names = (profile.libraries || []).map(item => item.name);
  if (runtime.loaderFamily === 'fabric') return names.includes(`net.fabricmc:fabric-loader:${runtime.loaderVersion}`);
  const version = `${runtime.minecraftVersion}-${runtime.loaderVersion}`;
  return names.some(name => name === `net.minecraftforge:forge:${version}` || name?.startsWith(`net.minecraftforge:forge:${version}:`)) || names.includes(`net.minecraftforge:fmlloader:${version}`);
}
function assertEffectiveLoader(libraries, runtime) {
  const identities = [];
  for (const library of libraries) {
    const [group, artifact, version] = library.name.split(':');
    let family;
    if (group === 'net.minecraftforge' && ['forge', 'fmlloader', 'fmlcore', 'javafmllanguage', 'lowcodelanguage', 'mclanguage'].includes(artifact)) family = 'forge';
    else if (group === 'net.fabricmc' && artifact === 'fabric-loader') family = 'fabric';
    else if (group === 'org.quiltmc' && artifact === 'quilt-loader') family = 'quilt';
    else if (group === 'net.neoforged' && ['neoforge', 'loader'].includes(artifact)) family = 'neoforge';
    else continue;
    if (family !== runtime.loaderFamily || version !== (family === 'forge' ? `${runtime.minecraftVersion}-${runtime.loaderVersion}` : runtime.loaderVersion)) throw failure();
    identities.push({ family, artifact });
  }
  if (runtime.loaderFamily !== 'vanilla' && !identities.some(item => item.family === runtime.loaderFamily && (item.family !== 'forge' || ['forge', 'fmlloader'].includes(item.artifact)))) throw failure();
}
function profileMetadata(root, runtime) {
  const base = readJson(root, `versions/${runtime.minecraftVersion}/${runtime.minecraftVersion}.json`);
  if (base.id !== runtime.minecraftVersion || base.inheritsFrom || base.jar && base.jar !== runtime.minecraftVersion || base.javaVersion?.majorVersion && base.javaVersion.majorVersion > runtime.javaMajor) throw failure();
  if (runtime.loaderFamily === 'vanilla') return { profileId: base.id, base, profile: base };
  const entries = fs.readdirSync(safePath(root, 'versions', true), { withFileTypes: true });
  if (entries.length > 1024) throw failure();
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,191}$/.test(entry.name) || entry.name === runtime.minecraftVersion) continue;
    let profile;
    try { profile = readJson(root, `versions/${entry.name}/${entry.name}.json`); } catch { continue; }
    if (!exactLoader(profile, runtime)) continue;
    if (profile.id !== entry.name || profile.inheritsFrom !== runtime.minecraftVersion || (profile.jar && profile.jar !== runtime.minecraftVersion) || !Array.isArray(profile.libraries)) throw failure();
    matches.push({ profileId: entry.name, base, profile });
  }
  if (matches.length !== 1) throw failure();
  return matches[0];
}
function validateRawLibraries(profile) {
  if (!Array.isArray(profile.libraries) || profile.libraries.length > 10000) throw failure();
  for (const library of profile.libraries) {
    if (typeof library.name !== 'string' || !/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.+-]+(?::[A-Za-z0-9_.+-]+)?(?:@[A-Za-z0-9]+)?$/.test(library.name)) throw failure();
    for (const artifact of [library.downloads?.artifact, ...Object.values(library.downloads?.classifiers || {})]) if (artifact?.path !== undefined) relative(artifact.path);
  }
}
function findJava(root, runtime) {
  const javaRoot = `java/java-${runtime.javaMajor}`;
  safePath(root, javaRoot, true);
  const candidates = [];
  let visited = 0;
  function visit(name, depth) {
    if (++visited > 512 || depth > 6) throw failure();
    const directory = safePath(root, name, true);
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (entries.some(entry => entry.name === 'release' && entry.isFile())) {
      const releasePath = safePath(root, `${name}/release`);
      if (fs.statSync(releasePath).size > 65536) throw failure();
      const release = fs.readFileSync(releasePath, 'utf8');
      const version = /^JAVA_VERSION="([^"\r\n]+)"$/m.exec(release)?.[1];
      const major = Number(version?.startsWith('1.') ? version.split('.')[1] : version?.split(/[.+-]/)[0]);
      if (major !== runtime.javaMajor || !/^OS_NAME="Windows"$/m.test(release) || !/^OS_ARCH="(?:amd64|x86_64|x64)"$/m.test(release)) throw failure();
      const executable = fs.existsSync(path.join(directory, 'bin/javaw.exe')) ? 'javaw.exe' : 'java.exe';
      const javaPath = safePath(root, `${name}/bin/${executable}`);
      const jvmPath = safePath(root, `${name}/bin/server/jvm.dll`);
      if (fs.statSync(javaPath).size < 1 || fs.statSync(jvmPath).size < 1) throw failure();
      candidates.push(javaPath);
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw failure();
      if (entry.isDirectory()) visit(`${name}/${entry.name}`, depth + 1);
    }
  }
  visit(javaRoot, 0);
  if (candidates.length !== 1) throw failure();
  return candidates[0];
}
async function verifyClientRuntime({ clientPath, runtime: input, runtimeConstraints }) {
  const runtime = normalizeClientRuntime(input);
  try {
    safePath(clientPath, '', true);
    const { profileId, base, profile } = profileMetadata(clientPath, runtime);
    validateRawLibraries(base); if (profile !== base) validateRawLibraries(profile);
    const { Version } = require('@xmcl/core');
    const resolved = await Version.parse(clientPath, profileId, { name: 'windows', arch: 'x64', version: '' });
    if (resolved.minecraftVersion !== runtime.minecraftVersion || resolved.libraries.length > 10000) throw failure();
    assertEffectiveLoader(resolved.libraries, runtime);
    assertRuntimeConstraints(resolved.libraries, runtime, runtimeConstraints);
    await verifyFile(clientPath, `versions/${runtime.minecraftVersion}/${runtime.minecraftVersion}.jar`, base.downloads?.client);
    for (const library of resolved.libraries) {
      if (relative(library.download.path) !== relative(library.path)) throw failure();
      await verifyFile(clientPath, `libraries/${library.download.path}`, library.download);
    }
    const indexId = base.assetIndex?.id;
    if (typeof indexId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(indexId)) throw failure();
    const indexName = `assets/indexes/${indexId}.json`;
    await verifyFile(clientPath, indexName, base.assetIndex);
    const index = readJson(clientPath, indexName);
    if (!index.objects || typeof index.objects !== 'object' || Array.isArray(index.objects) || Object.keys(index.objects).length > 100000) throw failure();
    for (const object of Object.values(index.objects)) {
      if (!/^[a-f0-9]{40}$/.test(object.hash) || !Number.isSafeInteger(object.size) || object.size < 0) throw failure();
      await verifyFile(clientPath, `assets/objects/${object.hash.slice(0, 2)}/${object.hash}`, { sha1: object.hash, size: object.size });
    }
    if (base.logging?.client?.file) await verifyFile(clientPath, `assets/log_configs/${relative(base.logging.client.file.id)}`, base.logging.client.file);
    const javaPath = findJava(clientPath, runtime);
    return Object.freeze({ verified: true, runtime, profileId, javaPath });
  } catch { throw failure(); }
}

class ClientRuntimeInstaller {
  constructor(options = {}) {
    this.ownership = options.ownership || null;
    this.injectedWorker = typeof options.runWorker === 'function';
    this.runWorker = options.runWorker || (request => require('./client-runtime-worker-client.cjs').runClientRuntimeWorker(request));
    this.operations = new Map();
  }
  async prepare({ clientPath, runtime: input, signal, onProgress, operationId }) {
    const runtime = normalizeClientRuntime(input);
    if (!this.ownership && !this.injectedWorker) throw failure();
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(operationId) || this.operations.has(operationId) || this.operations.size >= 256) throw failure();
    let resolveProof;
    const proof = new Promise(resolve => { resolveProof = resolve; });
    this.operations.set(operationId, proof);
    try {
      const ownership = this.ownership ? await this.ownership.activate(operationId) : null;
      if (ownership && ownership.clientPath !== clientPath) throw failure();
      const result = await this.runWorker({ clientPath, runtime, signal, onProgress, ...(ownership ? { ownership } : {}) });
      if (result?.quiescent !== true) throw failure();
      if (this.ownership) await this.ownership.completeFromExactClose(operationId);
      resolveProof(true);
      return { runtime, quiescent: true };
    } catch (error) {
      if (this.ownership) await this.ownership.releaseMain(operationId).catch(() => {});
      // The worker client always retains an in-process proof, including failures
      // before spawn. Flags alone are never sufficient cleanup authority.
      if (error?.preserveWorkspace === true) {
        waitForRuntimeWorkerQuiescence(error).then(async () => {
          try { if (this.ownership) await this.ownership.completeFromExactClose(operationId); resolveProof(true); }
          catch { resolveProof(false); }
        }, () => resolveProof(false));
      } else resolveProof(false);
      throw error;
    }
  }
  verify(request) { return verifyClientRuntime(request); }
  async reserveOperation(request) { if (!this.ownership) throw failure(); await this.ownership.reserve(request); }
  async releaseReservedOperation(operationId) { return this.ownership ? this.ownership.releaseReserved(operationId) : false; }
  async getRecoveryState(operationId) { return this.ownership ? this.ownership.getRecoveryState(operationId) : { quiescent: false, status: 'unknown' }; }
  async awaitQuiescence(operationId) {
    if (this.operations.has(operationId) && await this.operations.get(operationId) === true) return true;
    return this.ownership ? (await this.ownership.getRecoveryState(operationId)).quiescent === true : false;
  }
  async forgetOperation(operationId) {
    if (await this.awaitQuiescence(operationId) !== true) return false;
    this.operations.delete(operationId); return true;
  }
}

module.exports = { ClientRuntimeInstaller, normalizeClientRuntime, verifyClientRuntime, failure, safePath, profileMetadata, assertEffectiveLoader };
