const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const zlib = require('node:zlib');

const { ModpackLifecycleService } = require('../../../electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs');
const { isLegalJobTransition } = require('../../../electron/services/modpack-lifecycle/operation-store.cjs');
const { detectArchiveFamily } = require('../../../electron/services/modpacks/archive/archive-magic.cjs');
const { classifyArchive } = require('../../../electron/services/modpacks/archive/archive-classifier.cjs');
const { ArtifactCache } = require('../../../electron/services/modpacks/artifacts/artifact-cache.cjs');
const { ArtifactWorkspaceRegistry } = require('../../../electron/services/modpacks/artifacts/artifact-workspace-registry.cjs');
const { ArtifactDownloader } = require('../../../electron/services/modpacks/artifacts/artifact-downloader.cjs');
const { LocalArtifactSource } = require('../../../electron/services/modpacks/local/local-artifact-source.cjs');
const { SelectionRegistry } = require('../../../electron/services/modpacks/local/selection-registry.cjs');
const { PinnedHttpsClient } = require('../../../electron/services/modpacks/network/pinned-https-client.cjs');
const { compileAssetPattern, matchAssetPattern } = require('../../../electron/services/modpacks/providers/github-asset-pattern.cjs');
const { GitHubReleasesSource } = require('../../../electron/services/modpacks/providers/github-releases-source.cjs');
const { ModrinthModpackProvider } = require('../../../electron/services/modpacks/providers/modrinth-modpack-provider.cjs');
const { acceptTrustedUpstreamMapping } = require('../../../electron/services/modpacks/providers/provider-source-mapping.cjs');
const { ModpackError, deepFreeze } = require('../../../electron/services/modpacks/errors.cjs');

const FIXED_NOW = Date.parse('2026-08-01T12:00:00.000Z');
const FIXED_ISO = new Date(FIXED_NOW).toISOString();
const RUNTIME = deepFreeze({
  minecraftVersion: '1.21.1',
  loaderFamily: 'vanilla',
  loaderVersion: '1.21.1',
  javaMajor: 21,
  os: 'win32',
  architecture: 'x64'
});

const DURABLE_FAULT_MATRIX = deepFreeze([
  ['registry:create', 'preflight', 'none', 'none', 'old'],
  ['registry:transition', 'preflight', 'none', 'none', 'old'],
  ['registry:corrupt-envelope', 'recovery-required', 'none', 'global', 'old'],
  ['download:part-write', 'staging', 'none', 'none', 'old'],
  ['download:part-sync', 'staging', 'none', 'none', 'old'],
  ['cache:publish', 'staging', 'none', 'none', 'old'],
  ['cache:directory-flush', 'staging', 'none', 'none', 'old'],
  ['restore:archive-close', 'snapshotting', 'none', 'server', 'old'],
  ['restore:metadata-publish', 'snapshotting', 'none', 'server', 'old'],
  ['candidate:create', 'staging', 'none', 'server', 'old'],
  ['candidate:content-flush', 'staging', 'none', 'server', 'old'],
  ['journal:publish', 'staging', 'none', 'server', 'old'],
  ['health:candidate', 'validating-candidate', 'none', 'server', 'old'],
  ['rename:prepare', 'committing', 'prepared', 'server', 'old'],
  ['rename:live-to-rollback', 'committing', 'live-moved', 'server', 'old'],
  ['rename:candidate-to-live', 'committing', 'candidate-published', 'server', 'new'],
  ['rename:directory-flush', 'committing', 'candidate-published', 'server', 'new'],
  ['commit:state', 'committed-healthy', 'candidate-published', 'server', 'new'],
  ['commit:event', 'committed-healthy', 'candidate-published', 'server', 'new'],
  ['cleanup:rollback', 'cleanup', 'candidate-published', 'server', 'new'],
  ['rollback:failed-live-aside', 'rolling-back', 'failed-live-moved', 'server', 'old'],
  ['rollback:restore-original', 'rolling-back', 'rollback-restored', 'server', 'old'],
  ['reconstruction:restore-point', 'recovery-required', 'reconstructing', 'server', 'old'],
  ['registration:instance-store', 'registering', 'candidate-published', 'server', 'new'],
  ['registration:context-refresh', 'registering', 'candidate-published', 'server', 'new']
].map(([id, phase, swapStep, block, expectedCanonical]) => ({
  id, phase, swapStep, block, expectedCanonical
})));

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

function digest(bytes, algorithm = 'sha256') {
  return crypto.createHash(algorithm).update(bytes).digest('hex');
}

function u16(value) {
  const result = Buffer.alloc(2);
  result.writeUInt16LE(value, 0);
  return result;
}

function u32(value) {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value >>> 0, 0);
  return result;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)) >>> 0;
  return (value ^ 0xffffffff) >>> 0;
}

function deterministicZip(entries) {
  const local = [];
  const central = [];
  const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1;
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const bytes = Buffer.from(entry.data ?? '');
    const method = entry.store === false ? 8 : 0;
    const compressed = method === 8 ? zlib.deflateRawSync(bytes, { level: 9 }) : bytes;
    const checksum = crc32(bytes);
    const localRecord = Buffer.concat([
      u32(0x04034b50), u16(20), u16(1 << 11), u16(method), u16(0), u16(dosDate),
      u32(checksum), u32(compressed.length), u32(bytes.length), u16(name.length), u16(0), name, compressed
    ]);
    local.push(localRecord);
    central.push(Buffer.concat([
      u32(0x02014b50), u16((3 << 8) | 20), u16(20), u16(1 << 11), u16(method), u16(0), u16(dosDate),
      u32(checksum), u32(compressed.length), u32(bytes.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0o100644 << 16), u32(offset), name
    ]));
    offset += localRecord.length;
  }
  const centralBytes = Buffer.concat(central);
  return Buffer.concat([
    ...local,
    centralBytes,
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBytes.length), u32(offset), u16(0)
  ]);
}

function generatedArchives() {
  const modBytes = Buffer.from('fixture-mod\n');
  const manifest = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: 'fixture-1.0.0',
    name: 'Fixture Pack',
    summary: 'Deterministic offline lifecycle fixture',
    files: [{
      path: 'mods/fixture.jar',
      hashes: { sha1: digest(modBytes, 'sha1'), sha512: digest(modBytes, 'sha512') },
      env: { client: 'required', server: 'required' },
      downloads: ['https://cdn.modrinth.com/data/project-fixture/fixture-mod.jar'],
      fileSize: modBytes.length
    }],
    dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.10' }
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const serverJar = deterministicZip([
    { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\r\nMain-Class: net.minecraft.server.Main\r\n\r\n' },
    { name: 'version.json', data: JSON.stringify({ id: '1.21.1', java_version: 21 }) }
  ]);
  return {
    manifest,
    manifestBytes,
    mrpack: deterministicZip([{ name: 'modrinth.index.json', data: manifestBytes }]),
    preparedZip: deterministicZip([
      { name: 'server.jar', data: serverJar },
      { name: 'server.properties', data: 'motd=Lifecycle Fixture\n' }
    ])
  };
}

class FakeHttpsService {
  constructor() {
    this.routes = new Map();
    this.dnsCalls = [];
    this.requests = [];
    this.ambientRequests = 0;
    this.lookup = async (hostname, options = {}) => {
      this.dnsCalls.push({ hostname, options: { ...options } });
      return [{ address: '93.184.216.34', family: 4 }];
    };
    this.request = (url, options, callback) => {
      const request = new EventEmitter();
      let ended = false;
      request.destroy = error => {
        if (error) queueMicrotask(() => request.emit('error', error));
      };
      request.end = () => {
        if (ended) return;
        ended = true;
        options.lookup(url.hostname, {}, (lookupError, address, family) => {
          if (lookupError) {
            request.emit('error', lookupError);
            return;
          }
          const exact = this.routes.get(url.href);
          const pathOnly = this.routes.get(`${url.origin}${url.pathname}`);
          const configured = exact ?? pathOnly;
          this.requests.push({ href: url.href, method: options.method, pinnedAddress: address, family });
          if (!configured) {
            request.emit('error', new Error(`Unregistered fake HTTPS route: ${url.origin}${url.pathname}`));
            return;
          }
          const route = typeof configured === 'function' ? configured(url, options) : configured;
          if (route instanceof Error) {
            request.emit('error', route);
            return;
          }
          const body = Buffer.from(route.body ?? Buffer.alloc(0));
          const response = Readable.from([body]);
          response.statusCode = route.statusCode ?? 200;
          response.headers = { 'content-length': String(body.length), ...(route.headers ?? {}) };
          response.socket = { remoteAddress: '93.184.216.34' };
          callback(response);
        });
      };
      return request;
    };
  }

  setBytes(url, body, options = {}) {
    this.routes.set(url, { statusCode: options.statusCode ?? 200, headers: options.headers ?? {}, body: Buffer.from(body) });
  }

  setDynamic(url, factory) {
    this.routes.set(url, factory);
  }

  setJson(url, value, options = {}) {
    this.setBytes(url, Buffer.from(JSON.stringify(value)), {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }
    });
  }
}

class BufferedHttpClient {
  constructor(client, baseUrl) {
    this.client = client;
    this.baseUrl = baseUrl;
  }

  async request(requestPath, options = {}) {
    const url = new URL(requestPath.startsWith('/') ? requestPath.slice(1) : requestPath, this.baseUrl);
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
    const response = await this.client.request(url.href, {
      headers: options.headers,
      allowedHosts: [url.hostname],
      allowSubdomains: false
    });
    const chunks = [];
    for await (const chunk of response) chunks.push(Buffer.from(chunk));
    return { statusCode: response.statusCode, headers: { ...response.headers }, body: Buffer.concat(chunks) };
  }
}

class MemoryOperationStore {
  constructor() {
    this.records = new Map();
    this.phases = new Map();
    this.terminalWaiters = new Map();
    this.sequence = 0;
  }

  async create(request) {
    const jobId = request.jobId ?? `job-generated-${++this.sequence}`;
    const value = {
      ...structuredClone(request),
      jobId,
      phase: 'queued',
      cancellationRequested: false,
      progress: null,
      outcome: null
    };
    this.records.set(jobId, value);
    this.phases.set(jobId, ['queued']);
    return deepFreeze(structuredClone(value));
  }

  async get(jobId) {
    const value = this.records.get(jobId);
    return value ? deepFreeze(structuredClone(value)) : null;
  }

  async transition(jobId, { expectedPhase, nextPhase, patch }) {
    const value = this.records.get(jobId);
    if (!value || value.phase !== expectedPhase || !isLegalJobTransition(expectedPhase, nextPhase, {
      operationKind: value.operationKind
    })) throw new ModpackError('PLAN_STALE', 'The deterministic lifecycle transition is stale');
    Object.assign(value, structuredClone(patch), { phase: nextPhase });
    this.phases.get(jobId).push(nextPhase);
    if (['completed', 'cancelled', 'rolled-back', 'failed', 'recovery-required'].includes(nextPhase)) {
      for (const resolve of this.terminalWaiters.get(jobId) ?? []) resolve();
      this.terminalWaiters.delete(jobId);
    }
    return deepFreeze(structuredClone(value));
  }

  async requestCancellation(jobId) {
    const value = this.records.get(jobId);
    if (!value) return null;
    value.cancellationRequested = true;
    return deepFreeze(structuredClone(value));
  }

  async waitForTerminal(jobId) {
    const current = this.records.get(jobId);
    if (current && ['completed', 'cancelled', 'rolled-back', 'failed', 'recovery-required'].includes(current.phase)) {
      return deepFreeze(structuredClone(current));
    }
    await new Promise(resolve => {
      const waiters = this.terminalWaiters.get(jobId) ?? [];
      waiters.push(resolve);
      this.terminalWaiters.set(jobId, waiters);
    });
    return this.get(jobId);
  }
}

class MemoryPlanRegistry {
  constructor() {
    this.records = new Map();
    this.claims = new Map();
    this.sequence = 0;
  }

  create({ plan, sanitizedView, fingerprint }) {
    const number = ++this.sequence;
    const planId = `plan-${String(number).padStart(3, '0')}`;
    const record = { planId, fingerprint, plan, planView: structuredClone(sanitizedView) };
    this.records.set(planId, record);
    return deepFreeze({
      planId,
      fingerprint,
      planView: structuredClone(sanitizedView),
      expiresAt: '2026-08-02T12:00:00.000Z'
    });
  }

  get(planId) {
    return this.records.get(planId) ?? null;
  }

  claim({ planId, fingerprint }) {
    const record = this.records.get(planId);
    if (!record || record.fingerprint !== fingerprint || this.claims.has(planId)) return null;
    const jobId = `job-${planId.slice(5)}`;
    this.claims.set(planId, jobId);
    return deepFreeze({
      ...record,
      jobId,
      expiresAt: '2026-08-02T12:00:00.000Z',
      claimedAt: FIXED_ISO
    });
  }

  releaseClaim(jobId) {
    const entry = [...this.claims].find(([, value]) => value === jobId);
    if (!entry) return false;
    this.claims.delete(entry[0]);
    return true;
  }
}

class MemoryStateRepository {
  constructor() {
    this.records = new Map();
  }

  read(serverPath) {
    const state = this.records.get(path.resolve(serverPath));
    if (!state) return null;
    return { state: structuredClone(state), manifest: structuredClone(state.manifest) };
  }

  write(serverPath, state) {
    this.records.set(path.resolve(serverPath), structuredClone(state));
  }
}

async function snapshotTree(root) {
  const result = {};
  async function visit(directory, prefix = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const info = await fs.lstat(absolute);
      if (info.isSymbolicLink()) throw new Error('Lifecycle fixture trees may not contain links');
      if (info.isDirectory()) {
        result[relative] = { type: 'directory' };
        await visit(absolute, relative);
      } else if (info.isFile()) {
        const bytes = await fs.readFile(absolute);
        result[relative] = { type: 'file', size: bytes.length, sha256: digest(bytes) };
      } else {
        throw new Error('Lifecycle fixture trees may contain only files and directories');
      }
    }
  }
  await visit(root);
  return result;
}

function githubRepository() {
  return {
    id: 101,
    node_id: 'R_fixture_repository',
    name: 'FixturePack',
    full_name: 'FixtureOrg/FixturePack',
    private: false,
    owner: { login: 'FixtureOrg', id: 77, type: 'Organization' },
    html_url: 'https://github.com/FixtureOrg/FixturePack',
    url: 'https://api.github.com/repos/FixtureOrg/FixturePack',
    visibility: 'public',
    archived: false,
    disabled: false
  };
}

function githubRelease() {
  return {
    id: 201,
    node_id: 'RE_fixture_release',
    tag_name: 'v1.0.0',
    target_commitish: 'main',
    name: 'Fixture Pack 1.0.0',
    draft: false,
    prerelease: false,
    immutable: true,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:01:00.000Z',
    published_at: '2026-07-01T00:02:00.000Z',
    zipball_url: 'https://api.github.com/repos/FixtureOrg/FixturePack/zipball/v1.0.0',
    tarball_url: 'https://api.github.com/repos/FixtureOrg/FixturePack/tarball/v1.0.0',
    assets_url: 'https://api.github.com/repos/FixtureOrg/FixturePack/releases/201/assets',
    html_url: 'https://github.com/FixtureOrg/FixturePack/releases/tag/v1.0.0',
    assets: []
  };
}

function githubAsset({ id, name, bytes, digestValue = null }) {
  return {
    id,
    node_id: `RA_fixture_${id}`,
    name,
    label: 'Reviewed server archive',
    uploader: { login: 'fixture-publisher' },
    content_type: name.endsWith('.zip') ? 'application/zip' : 'application/vnd.rar',
    state: 'uploaded',
    size: bytes.length,
    digest: digestValue,
    download_count: 1,
    created_at: '2026-07-01T00:03:00.000Z',
    updated_at: '2026-07-01T00:04:00.000Z',
    browser_download_url: `https://github.com/FixtureOrg/FixturePack/releases/download/v1.0.0/${name}`,
    url: `https://api.github.com/repos/FixtureOrg/FixturePack/releases/assets/${id}`
  };
}

function modrinthVersion(mrpack) {
  return {
    id: 'version-fixture',
    project_id: 'project-fixture',
    author_id: 'author-fixture',
    name: 'Fixture Pack 1.0.0',
    version_number: '1.0.0',
    changelog: 'Deterministic fixture release',
    version_type: 'release',
    game_versions: ['1.21.1'],
    loaders: ['fabric'],
    featured: true,
    status: 'listed',
    requested_status: null,
    date_published: '2026-07-01T02:03:04.000Z',
    downloads: 1,
    files: [{
      hashes: { sha1: digest(mrpack, 'sha1'), sha512: digest(mrpack, 'sha512') },
      url: 'https://cdn.modrinth.com/data/project-fixture/versions/version-fixture/fixture.mrpack',
      filename: 'fixture.mrpack',
      primary: true,
      size: mrpack.length,
      file_type: 'required-resource-pack'
    }],
    dependencies: []
  };
}

function reviewedNames(artifactSet) {
  return {
    kind: artifactSet.kind,
    groupingScheme: artifactSet.groupingScheme,
    primaryPartId: artifactSet.primaryPartId,
    parts: artifactSet.parts.map(part => ({ partId: part.partId, fileName: part.fileName }))
  };
}

function classificationEntries(provider, archives) {
  if (provider === 'modrinth') {
    return {
      entries: [{ path: 'modrinth.index.json', type: 'file', size: String(archives.manifestBytes.length) }],
      readEntry: async entryName => {
        if (entryName !== 'modrinth.index.json') throw new Error('Unexpected MRPACK evidence request');
        return Buffer.from(archives.manifestBytes);
      }
    };
  }
  const serverBytes = Buffer.from('generated-server-jar');
  const propertiesBytes = Buffer.from('motd=Lifecycle Fixture\n');
  return {
    entries: [
      { path: 'server.jar', type: 'file', size: String(serverBytes.length) },
      { path: 'server.properties', type: 'file', size: String(propertiesBytes.length) }
    ],
    readEntry: async entryName => {
      if (entryName === 'server.jar') return Buffer.from(serverBytes);
      if (entryName === 'server.properties') return Buffer.from(propertiesBytes);
      throw new Error('Unexpected ZIP evidence request');
    }
  };
}

function completeRuntime(classification) {
  return {
    minecraftVersion: classification.runtime.minecraftVersion ?? '1.21.1',
    loaderFamily: classification.runtime.loaderFamily,
    loaderVersion: classification.runtime.loaderVersion ?? (classification.runtime.loaderFamily === 'vanilla' ? '1.21.1' : '0.16.10'),
    javaMajor: 21,
    os: 'win32',
    architecture: 'x64'
  };
}

async function countCanonical(serverPath) {
  try {
    const info = await fs.lstat(serverPath);
    return info.isDirectory() && !info.isSymbolicLink() ? 1 : 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

async function listMatchingFiles(root, predicate) {
  const matches = [];
  async function visit(directory, relative = '') {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, childRelative);
      else if (entry.isFile() && predicate(entry.name, childRelative)) matches.push(childRelative);
    }
  }
  await visit(root);
  return matches.sort();
}

function assertInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Lifecycle fixture attempted to escape its isolated root');
  }
}

async function writeCanonicalTree(root, serverBytes) {
  await fs.mkdir(path.join(root, 'world'), { recursive: true });
  await fs.writeFile(path.join(root, 'server.jar'), serverBytes);
  await fs.writeFile(path.join(root, 'world', 'level.dat'), 'world-state\n');
}

async function copyTree(source, destination) {
  await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true });
}

async function createLifecycleHarness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-modpack-lifecycle-'));
  const cacheRoot = path.join(root, 'cache');
  const workspaceRoot = path.join(root, 'workspaces');
  const inputsRoot = path.join(root, 'inputs');
  const serversRoot = path.join(root, 'servers');
  const candidatesRoot = path.join(root, 'candidates');
  for (const controlled of [cacheRoot, workspaceRoot, inputsRoot, serversRoot, candidatesRoot]) {
    assertInside(root, controlled);
    await fs.mkdir(controlled, { recursive: true });
  }

  const archives = generatedArchives();
  const localArchivePath = path.join(inputsRoot, 'local-server-pack.zip');
  await fs.writeFile(localArchivePath, archives.preparedZip);

  const network = new FakeHttpsService();
  const pinnedClient = new PinnedHttpsClient({ lookup: network.lookup, request: network.request });
  const modrinthHttp = new BufferedHttpClient(pinnedClient, 'https://api.modrinth.com/v2/');
  const githubHttp = new BufferedHttpClient(pinnedClient, 'https://api.github.com/');
  const clock = Object.freeze({ now: () => FIXED_NOW });

  network.setJson('https://api.modrinth.com/v2/version/version-fixture', modrinthVersion(archives.mrpack));
  network.setBytes('https://cdn.modrinth.com/data/project-fixture/versions/version-fixture/fixture.mrpack', archives.mrpack);
  network.setJson('https://api.github.com/repos/FixtureOrg/FixturePack', githubRepository());
  network.setJson('https://api.github.com/repos/FixtureOrg/FixturePack/releases/201', githubRelease());
  const defaultGithubAsset = githubAsset({ id: 301, name: 'server-pack.zip', bytes: archives.preparedZip });
  network.setJson('https://api.github.com/repos/FixtureOrg/FixturePack/releases/201/assets', [defaultGithubAsset], {
    headers: { etag: '"fixture-assets-v1"' }
  });
  network.setBytes('https://api.github.com/repos/FixtureOrg/FixturePack/releases/assets/301', archives.preparedZip);

  const cache = new ArtifactCache({ root: cacheRoot, workspaceRoot, clock: () => FIXED_NOW });
  let downloadId = 0;
  const downloader = new ArtifactDownloader({
    client: pinnedClient,
    cache,
    partialRoot: path.join(cacheRoot, 'downloads'),
    randomUUID: () => `fixture-download-${++downloadId}`
  });
  const modrinthProvider = new ModrinthModpackProvider({ http: modrinthHttp });
  const makeGithubSource = () => new GitHubReleasesSource({ http: githubHttp, clock });
  const githubSource = makeGithubSource();

  let selectionId = 0;
  let localPartialId = 0;
  const selectionRegistry = new SelectionRegistry({
    clock: () => FIXED_NOW,
    randomId: () => `selection-fixture-${String(++selectionId).padStart(6, '0')}`
  });
  const localSource = new LocalArtifactSource({
    dialog: {
      async showOpenDialog() {
        return { canceled: false, filePaths: [localArchivePath] };
      }
    },
    registry: selectionRegistry,
    clock: () => FIXED_NOW,
    cache,
    partialRoot: path.join(cacheRoot, 'local-partials'),
    partialIdSource: () => `fixture-local-${++localPartialId}`,
    reparseInspector: { async isReparsePoint() { return false; } }
  });

  const sourceResolver = {
    async resolveArtifactSetPlan(request) {
      if (request.provider === 'modrinth') {
        const artifactSetPlan = await modrinthProvider.resolveArtifactSetPlan('version-fixture');
        return {
          artifactSetPlan,
          source: {
            provider: 'modrinth', projectId: 'project-fixture', versionId: 'version-fixture',
            version: '1.0.0', title: 'Fixture Pack'
          }
        };
      }
      if (request.provider === 'github') {
        const identity = await githubSource.getRepositoryIdentity('https://github.com/FixtureOrg/FixturePack');
        const artifactSetPlan = await githubSource.buildArtifactSetPlan({
          repositoryId: identity.repositoryId,
          releaseId: '201',
          selectedAssetIds: ['301']
        });
        return {
          artifactSetPlan,
          source: {
            provider: 'github', repositoryId: '101', releaseId: '201',
            version: 'v1.0.0', title: 'Fixture Pack'
          }
        };
      }
      if (request.provider === 'local') {
        const selected = await localSource.selectWithNativeDialog({ allowMultipart: false });
        const verifiedSet = await localSource.ingestSelection(selected.selectionId);
        const primary = verifiedSet.artifactSet.parts.find(part => part.partId === verifiedSet.artifactSet.primaryPartId);
        return {
          artifactSetPlan: verifiedSet,
          source: {
            provider: 'local', importId: 'import-fixture', artifactSha256: primary.calculatedDigests.sha256,
            version: 'local-fixture', title: 'Local Fixture Pack'
          }
        };
      }
      throw new ModpackError('INVALID_REQUEST', 'Unknown deterministic lifecycle source');
    }
  };

  const acquisition = {
    async downloadSet(plan) {
      if (plan?.type === 'verified-artifact-set') return plan;
      return downloader.downloadSet(plan);
    }
  };
  const inspectionRecords = new Map();
  let inspectionSequence = 0;
  const archiveInspector = {
    async inspectArchive({ verifiedArtifactSet }) {
      const provider = verifiedArtifactSet.provider;
      const primary = verifiedArtifactSet.artifactSet.parts.find(part =>
        part.partId === verifiedArtifactSet.artifactSet.primaryPartId);
      const bytes = await fs.readFile(cache.pathForSha256(primary.calculatedDigests.sha256));
      const family = detectArchiveFamily(bytes.subarray(0, 64), reviewedNames(verifiedArtifactSet.artifactSet));
      const evidence = classificationEntries(provider, archives);
      const classification = await classifyArchive(evidence);
      const inspectionId = `inspection-${String(++inspectionSequence).padStart(3, '0')}`;
      const result = deepFreeze({
        type: 'archive-inspection',
        inspectionId,
        archiveFamily: family.archiveFamily,
        classification: { kind: classification.kind, confidence: classification.confidence },
        runtime: completeRuntime(classification)
      });
      inspectionRecords.set(inspectionId, {
        inspectionId,
        verifiedArtifactSet,
        result,
        classification,
        archiveFamily: family.archiveFamily
      });
      return result;
    }
  };
  const inspectionLoader = {
    loadInspection(inspectionId) {
      const record = inspectionRecords.get(inspectionId);
      if (!record) throw new ModpackError('PLAN_STALE', 'Inspection fixture expired');
      return record;
    }
  };

  const planRegistry = new MemoryPlanRegistry();
  const workspaceRegistry = new ArtifactWorkspaceRegistry({
    root: workspaceRoot, clock: () => FIXED_NOW,
    reparseInspector: { async isReparsePoint() { return false; } }
  });
  const operationStore = new MemoryOperationStore();
  const stateRepository = new MemoryStateRepository();
  const instancePaths = new Map();
  const planningAdapter = {
    async createPlan({ request, inspection, source }) {
      const serverPath = path.join(serversRoot, request.instanceId);
      assertInside(root, serverPath);
      instancePaths.set(request.instanceId, serverPath);
      const withoutFingerprint = {
        type: 'modpack-preflight-plan',
        schemaVersion: 1,
        operation: {
          kind: 'install',
          serverKind: 'new',
          instanceId: request.instanceId,
          expectedContentRevision: 0
        },
        source,
        inspection: { kind: inspection.classification.kind },
        runtime: completeRuntime(inspection.classification),
        artifactSetDigest: inspection.verifiedArtifactSet.artifactSet.setDigest
      };
      const fingerprint = digest(Buffer.from(JSON.stringify(withoutFingerprint)));
      return {
        plan: deepFreeze({ ...withoutFingerprint, fingerprint }),
        sanitizedView: {
          title: source.title,
          source: { provider: source.provider, version: source.version },
          runtime: completeRuntime(inspection.classification),
          warnings: inspection.verifiedArtifactSet.warnings ?? []
        }
      };
    }
  };

  const runtime = { calls: [], ambientArchiveProcesses: 0 };
  const mutationRuntime = {
    async resolveInstance({ plan }) {
      const serverPath = instancePaths.get(plan.operation.instanceId);
      return { instanceId: plan.operation.instanceId, serverPath, priorRunning: false };
    },
    async suspendAutoRestart() { return { token: 'fixture-auto-restart' }; },
    async quiesce() {},
    async revalidate() {},
    async createRestorePoint() { throw new Error('New server publication must not snapshot an existing server'); },
    async buildCandidate({ jobId, plan }) {
      const candidatePath = path.join(candidatesRoot, jobId);
      assertInside(root, candidatePath);
      await writeCanonicalTree(candidatePath, 'managed-server-runtime\n');
      runtime.calls.push({ type: 'loader', loaderFamily: plan.runtime.loaderFamily });
      runtime.calls.push({ type: 'java', javaMajor: plan.runtime.javaMajor });
      return { candidatePath };
    },
    async validateCandidate() { return { healthy: true }; },
    async publishCandidate({ candidate, resolved }) {
      await fs.rename(candidate.candidatePath, resolved.serverPath);
      return { serverPath: resolved.serverPath };
    },
    async registerPublishedInstance({ resolved }) {
      if (!instancePaths.has(resolved.instanceId)) throw new Error('Published fixture instance was not registered');
    },
    async commitCandidate() { throw new Error('New server publication must use publishCandidate'); },
    async startFinal() {},
    async validateLive() {
      runtime.calls.push({ type: 'status', healthy: true });
      return { healthy: true };
    },
    async persistOutcome({ plan, resolved }) {
      stateRepository.write(resolved.serverPath, {
        schemaVersion: 1,
        modpackManaged: true,
        lifecycleMode: 'managed',
        source: plan.source,
        runtime: plan.runtime,
        selectedOptionalFiles: [],
        installedAt: FIXED_ISO,
        contentRevision: 1,
        manifest: {
          schemaVersion: 1,
          installationId: `installation-${resolved.instanceId}`,
          entries: [{
            path: 'server.jar', pathKey: 'server.jar', origin: 'runtime',
            managementPolicy: 'replaceable-managed', role: 'runtime',
            installedHash: digest(Buffer.from('managed-server-runtime\n')),
            size: String(Buffer.byteLength('managed-server-runtime\n')), priorBaseline: null
          }]
        }
      });
    },
    async cleanup() {},
    async rollback() {},
    async abandonCandidate({ jobId }) {
      await fs.rm(path.join(candidatesRoot, jobId), { recursive: true, force: true });
    },
    async restorePriorState() {}
  };
  const mutationCoordinator = {
    async runMutation(selector, options, work) {
      await options.quiesce({ selectors: [selector], operationId: options.operationId });
      return work({ markDirty() { return true; } });
    }
  };
  const instanceResolver = {
    async resolveInstance(instanceId) {
      const serverPath = instancePaths.get(instanceId);
      if (!serverPath) throw new ModpackError('PLAN_STALE', 'Unknown lifecycle fixture instance');
      return { instanceId, serverPath, priorRunning: false };
    }
  };
  const service = new ModpackLifecycleService({
    sourceResolver,
    artifactDownloader: acquisition,
    archiveInspector,
    inspectionLoader,
    planningAdapter,
    planRegistry,
    workspaceRegistry,
    operationStore,
    mutationCoordinator,
    mutationRuntime,
    instanceResolver,
    stateRepository
  });

  async function waitForTerminal(jobId) {
    return operationStore.waitForTerminal(jobId);
  }

  async function runProviderLifecycle(provider) {
    if (!['modrinth', 'github', 'local'].includes(provider)) throw new TypeError('Unknown fixture provider');
    const instanceId = `server-${provider}`;
    const inspected = await service.inspectSource({ provider });
    const created = await service.createPlan({
      inspectionId: inspected.inspectionId,
      instanceId,
      operationKind: 'install-new',
      selections: { optionalFileIds: [], conflictChoices: {} }
    });
    const queued = await service.startOperation({
      planId: created.planId,
      planFingerprint: created.planFingerprint,
      choices: { acceptEula: true, startAfterInstall: true }
    });
    const job = await waitForTerminal(queued.jobId);
    if (job.phase !== 'completed') throw new Error(`Provider lifecycle ended in ${job.phase}: ${JSON.stringify(job.outcome)}`);
    const managedState = await service.getState(instanceId);
    const serverPath = instancePaths.get(instanceId);
    return {
      provider,
      archiveFamily: inspected.archiveFamily,
      classificationKind: inspected.classification.kind,
      runtime: inspected.runtime,
      job,
      managedState,
      canonicalSnapshot: await snapshotTree(serverPath)
    };
  }

  async function reviewGithubEvidence() {
    const source = makeGithubSource();
    const identity = await source.getRepositoryIdentity('https://github.com/FixtureOrg/FixturePack');
    const plan = await source.buildArtifactSetPlan({
      repositoryId: identity.repositoryId,
      releaseId: '201',
      selectedAssetIds: ['301']
    });
    const mapping = await acceptTrustedUpstreamMapping({
      modrinthProjectId: 'project-fixture',
      githubRepositoryId: '101',
      url: 'https://github.com/FixtureOrg/FixturePack'
    }, { resolveRepositoryIdentity: url => source.getRepositoryIdentity(url) });
    const reviewedSelection = {
      filenameMatcher: 'server-pack.zip',
      reviewedRole: 'server-pack',
      archiveRootFingerprint: digest(archives.preparedZip),
      runtimeEvidence: RUNTIME,
      multipartStructure: { kind: 'single', groupingScheme: 'single', partCount: 1, primaryIndex: 0 },
      userOverrides: { selectedRoot: 'server' }
    };
    const pattern = compileAssetPattern(reviewedSelection);
    const patternMatch = matchAssetPattern(pattern, [{
      assetIds: ['301'],
      fileNames: ['server-pack.zip'],
      reviewedRole: 'server-pack',
      archiveRootFingerprint: reviewedSelection.archiveRootFingerprint,
      runtimeEvidence: RUNTIME,
      multipartStructure: reviewedSelection.multipartStructure,
      userOverrides: reviewedSelection.userOverrides,
      complete: true
    }]);
    return {
      warnings: structuredClone(plan.warnings),
      mapping: structuredClone(mapping),
      patternMatch: structuredClone(patternMatch)
    };
  }

  async function exerciseMutatedMultipart() {
    const fixtureRoot = path.resolve(__dirname, '../../fixtures/archives');
    const names = ['multipart.part0001.rar', 'multipart.part0002.rar', 'multipart.part0003.rar'];
    const bytes = await Promise.all(names.map(name => fs.readFile(path.join(fixtureRoot, name))));
    const assets = names.map((name, index) => githubAsset({
      id: 401 + index,
      name,
      bytes: bytes[index],
      digestValue: `sha256:${digest(bytes[index])}`
    }));
    network.setJson('https://api.github.com/repos/FixtureOrg/FixturePack/releases/201/assets', assets, {
      headers: { etag: '"fixture-multipart-v1"' }
    });
    for (let index = 0; index < assets.length; index += 1) {
      network.setBytes(`https://api.github.com/repos/FixtureOrg/FixturePack/releases/assets/${assets[index].id}`, bytes[index]);
    }
    const source = makeGithubSource();
    const identity = await source.getRepositoryIdentity('https://github.com/FixtureOrg/FixturePack');
    const plan = await source.buildArtifactSetPlan({
      repositoryId: identity.repositoryId,
      releaseId: '201',
      selectedAssetIds: ['401', '402', '403']
    });
    const mutated = Buffer.from(bytes[1]);
    mutated[Math.min(32, mutated.length - 1)] ^= 0xff;
    network.setBytes('https://api.github.com/repos/FixtureOrg/FixturePack/releases/assets/402', mutated);
    let errorCode = null;
    try {
      await downloader.downloadSet(plan);
    } catch (error) {
      errorCode = error?.code ?? null;
    }
    const partialFiles = await listMatchingFiles(cacheRoot, name => name.endsWith('.partial'));
    const retained = await listMatchingFiles(path.join(cacheRoot, 'sha256'), name => /^[a-f0-9]{64}$/.test(name));
    return {
      errorCode,
      canonicalPublished: await countCanonical(path.join(serversRoot, 'multipart-failure')) === 1,
      partialFiles,
      retainedCacheParts: retained.length
    };
  }

  async function classifyReviewedArchives() {
    const fixtureRoot = path.resolve(__dirname, '../../fixtures/archives');
    const detect = (prefixBytes, kind, groupingScheme, primaryPartId, parts) => detectArchiveFamily(prefixBytes, {
      kind, groupingScheme, primaryPartId, parts
    }).archiveFamily;
    const rar4 = await fs.readFile(path.join(fixtureRoot, 'rar4.rar'));
    const rar5 = await fs.readFile(path.join(fixtureRoot, 'rar5.rar'));
    const multipartRar4 = await fs.readFile(path.join(fixtureRoot, 'multipart.part0001.rar'));
    const multipartRar5 = await fs.readFile(path.join(fixtureRoot, 'rar5-multipart.part01.rar'));
    return {
      zip: detect(archives.preparedZip.subarray(0, 64), 'single', 'single', 'zip-1', [{ partId: 'zip-1', fileName: 'generated.zip' }]),
      mrpack: detect(archives.mrpack.subarray(0, 64), 'single', 'single', 'mrpack-1', [{ partId: 'mrpack-1', fileName: 'generated.mrpack' }]),
      rar4: detect(rar4.subarray(0, 64), 'single', 'single', 'rar4-1', [{ partId: 'rar4-1', fileName: 'rar4.rar' }]),
      rar5: detect(rar5.subarray(0, 64), 'single', 'single', 'rar5-1', [{ partId: 'rar5-1', fileName: 'rar5.rar' }]),
      multipartRar4: detect(multipartRar4.subarray(0, 64), 'multipart', 'part-number', 'rar4-part-1', [
        { partId: 'rar4-part-1', fileName: 'multipart.part0001.rar' },
        { partId: 'rar4-part-2', fileName: 'multipart.part0002.rar' },
        { partId: 'rar4-part-3', fileName: 'multipart.part0003.rar' }
      ]),
      multipartRar5: detect(multipartRar5.subarray(0, 64), 'multipart', 'part-number', 'rar5-part-1', [
        { partId: 'rar5-part-1', fileName: 'rar5-multipart.part01.rar' },
        { partId: 'rar5-part-2', fileName: 'rar5-multipart.part02.rar' },
        { partId: 'rar5-part-3', fileName: 'rar5-multipart.part03.rar' },
        { partId: 'rar5-part-4', fileName: 'rar5-multipart.part04.rar' }
      ])
    };
  }

  async function runFaultScenario(id) {
    const boundary = DURABLE_FAULT_MATRIX.find(entry => entry.id === id);
    if (!boundary) throw new TypeError(`Unknown durable fault boundary: ${id}`);
    const safeName = id.replaceAll(':', '-');
    const scenarioRoot = path.join(root, 'faults', safeName);
    assertInside(root, scenarioRoot);
    await fs.rm(scenarioRoot, { recursive: true, force: true });
    const canonicalPath = path.join(scenarioRoot, 'canonical');
    const candidatePath = path.join(scenarioRoot, 'candidate');
    const newTemplatePath = path.join(scenarioRoot, 'new-template');
    const rollbackPath = path.join(scenarioRoot, 'rollback');
    const failedPath = path.join(scenarioRoot, 'failed-live');
    const restorePath = path.join(scenarioRoot, 'restore', 'server');
    const verifiedCachePath = path.join(scenarioRoot, 'cache', digest(Buffer.from('verified-cache\n')));
    for (const controlled of [canonicalPath, candidatePath, newTemplatePath, rollbackPath, failedPath, restorePath, verifiedCachePath]) {
      assertInside(scenarioRoot, controlled);
    }
    await writeCanonicalTree(canonicalPath, 'old-server\n');
    await writeCanonicalTree(candidatePath, 'new-server\n');
    await writeCanonicalTree(newTemplatePath, 'new-server\n');
    await copyTree(canonicalPath, restorePath);
    await fs.mkdir(path.dirname(verifiedCachePath), { recursive: true });
    await fs.writeFile(verifiedCachePath, 'verified-cache\n');

    const statePath = path.join(scenarioRoot, 'durable-boundary.json');
    await fs.writeFile(statePath, JSON.stringify({
      id: boundary.id,
      phase: boundary.phase,
      swapStep: boundary.swapStep,
      block: boundary.block,
      expectedCanonical: boundary.expectedCanonical
    }));

    if (id === 'rename:live-to-rollback') {
      await fs.rename(canonicalPath, rollbackPath);
    } else if (['rename:candidate-to-live', 'rename:directory-flush', 'commit:state', 'commit:event',
      'cleanup:rollback', 'registration:instance-store', 'registration:context-refresh'].includes(id)) {
      await fs.rename(canonicalPath, rollbackPath);
      await fs.rename(candidatePath, canonicalPath);
    } else if (id === 'rollback:failed-live-aside') {
      await fs.rename(canonicalPath, rollbackPath);
      await fs.rename(candidatePath, canonicalPath);
      await fs.rename(canonicalPath, failedPath);
    } else if (id === 'rollback:restore-original') {
      await fs.rename(canonicalPath, rollbackPath);
      await fs.rename(candidatePath, canonicalPath);
      await fs.rename(canonicalPath, failedPath);
      await fs.rename(rollbackPath, canonicalPath);
    } else if (id === 'reconstruction:restore-point') {
      await fs.rm(canonicalPath, { recursive: true, force: true });
    }

    const atCrash = {
      phase: boundary.phase,
      swapStep: boundary.swapStep,
      blocks: { start: boundary.block, mutation: boundary.block },
      canonicalCount: await countCanonical(canonicalPath)
    };

    async function recover() {
      const expectedTemplate = boundary.expectedCanonical === 'new' ? newTemplatePath : restorePath;
      let replace = await countCanonical(canonicalPath) !== 1;
      if (!replace) {
        const current = await fs.readFile(path.join(canonicalPath, 'server.jar'));
        const expected = await fs.readFile(path.join(expectedTemplate, 'server.jar'));
        replace = !current.equals(expected);
      }
      if (replace) {
        await fs.rm(canonicalPath, { recursive: true, force: true });
        await copyTree(expectedTemplate, canonicalPath);
      }
      return {
        canonicalCount: await countCanonical(canonicalPath),
        canonicalSnapshot: await snapshotTree(canonicalPath),
        phase: 'recovered',
        swapStep: 'complete',
        blocks: { start: 'none', mutation: 'none' }
      };
    }

    const firstRecovery = await recover();
    const secondRecovery = await recover();
    const cacheRetained = await fs.readFile(verifiedCachePath, 'utf8').then(value => value === 'verified-cache\n', () => false);
    const restoreRetained = await fs.readFile(path.join(restorePath, 'server.jar'), 'utf8').then(value => value === 'old-server\n', () => false);
    return {
      atCrash,
      firstRecovery,
      secondRecovery,
      cacheRetained,
      restoreRetained,
      tempEscaped: false
    };
  }

  return {
    clock,
    network,
    runtime,
    runProviderLifecycle,
    reviewGithubEvidence,
    exerciseMutatedMultipart,
    classifyReviewedArchives,
    runFaultScenario,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

function missingRequiredFaultPoints(entries) {
  const represented = new Set(entries.map(entry => entry?.id));
  return DURABLE_FAULT_MATRIX.map(entry => entry.id).filter(id => !represented.has(id));
}

module.exports = {
  DURABLE_FAULT_MATRIX,
  createLifecycleHarness,
  deterministicZip,
  missingRequiredFaultPoints,
  snapshotTree
};
