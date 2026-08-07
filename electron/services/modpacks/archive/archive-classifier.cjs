const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { buildMrpackServerPlan, listOptionalFileChoices } = require('../mrpack/mrpack-file-plan.cjs');
const { parseMrpackManifest } = require('../mrpack/mrpack-parser.cjs');
const { canonicalWindowsArchivePath } = require('./archive-entry-policy.cjs');

const MRPACK_READ_LIMIT = 2 * 1024 * 1024;
const CONFIG_READ_LIMIT = 64 * 1024;
const LOADERS = new Set(['vanilla', 'fabric', 'forge', 'neoforge', 'quilt']);

function invalid(field) {
  throw new ModpackError('INVALID_REQUEST', 'Archive classification request is invalid', {
    details: field ? { field } : undefined
  });
}

function extractorFailed(cause) {
  return new ModpackError('EXTRACTOR_FAILED', 'Archive evidence could not be read', { cause });
}

function normalizedEntries(entries, selectedRoot) {
  if (!Array.isArray(entries) || typeof selectedRoot !== 'string' && selectedRoot !== null && selectedRoot !== undefined) invalid('entries');
  let selectedCanonical = null;
  let selectedDirectoryFound = false;
  if (selectedRoot) {
    selectedCanonical = canonicalWindowsArchivePath(selectedRoot);
    if (selectedCanonical.includes('/')) invalid('selectedRoot');
  }
  const result = [];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || !['file', 'directory'].includes(entry.type) ||
        typeof entry.path !== 'string' || typeof entry.size !== 'string') invalid(`entries.${index}`);
    const canonical = canonicalWindowsArchivePath(entry.path);
    let relative = entry.path;
    let relativeCanonical = canonical;
    if (selectedCanonical) {
      if (canonical === selectedCanonical) {
        if (entry.type !== 'directory') invalid('selectedRoot');
        selectedDirectoryFound = true;
        relative = '';
        relativeCanonical = '';
      } else if (canonical.startsWith(`${selectedCanonical}/`)) {
        const firstSlash = entry.path.replaceAll('\\', '/').indexOf('/');
        relative = entry.path.replaceAll('\\', '/').slice(firstSlash + 1);
        relativeCanonical = canonical.slice(selectedCanonical.length + 1);
      } else return;
    }
    if (relative !== '') result.push({ source: entry, relative, canonical: relativeCanonical });
  });
  if (selectedCanonical && !selectedDirectoryFound) invalid('selectedRoot');
  return result;
}

function boundedEvidence(evidence) {
  return evidence.slice(0, 64).map(item => ({ ...item }));
}

async function readEvidence(readEntry, entry, purpose, maxBytes) {
  if (typeof readEntry !== 'function' || entry.source.type !== 'file') invalid('readEntry');
  let bytes;
  try { bytes = await readEntry(entry.source.path, { purpose, maxBytes }); }
  catch (error) {
    if (error instanceof ModpackError) throw error;
    throw extractorFailed(error);
  }
  if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes || BigInt(bytes.length) !== BigInt(entry.source.size)) throw extractorFailed();
  return bytes;
}

function runtime(loaderFamily, minecraftVersion = null, loaderVersion = null) {
  return { minecraftVersion, loaderFamily, loaderVersion };
}

function manifestRuntime(dependencies) {
  const loaderKey = Object.keys(dependencies).find(key => key !== 'minecraft');
  if (!loaderKey) return runtime('vanilla', dependencies.minecraft, dependencies.minecraft);
  const loaderFamily = loaderKey === 'fabric-loader' ? 'fabric' : loaderKey === 'quilt-loader' ? 'quilt' : loaderKey;
  return runtime(loaderFamily, dependencies.minecraft, dependencies[loaderKey]);
}

function preparedEvidence(files) {
  const candidates = [];
  const fabricLauncher = files.get('fabric-server-launch.jar');
  const fabricLibrary = [...files.values()].find(entry => /^libraries\/net\/fabricmc\/fabric-loader\/([^/]+)\/fabric-loader-\1\.jar$/.test(entry.canonical));
  if (fabricLauncher || fabricLibrary) {
    const match = fabricLibrary && /^libraries\/net\/fabricmc\/fabric-loader\/([^/]+)\//.exec(fabricLibrary.canonical);
    candidates.push({
      family: 'fabric', complete: Boolean(fabricLauncher && fabricLibrary),
      runtime: runtime('fabric', null, match?.[1] ?? null),
      evidence: [fabricLauncher && { kind: 'fabric-launcher', entryName: fabricLauncher.source.path }, fabricLibrary && { kind: 'fabric-loader-library', entryName: fabricLibrary.source.path }].filter(Boolean)
    });
  }

  const quiltLauncher = files.get('quilt-server-launch.jar');
  const quiltLibrary = [...files.values()].find(entry => /^libraries\/org\/quiltmc\/quilt-loader\/([^/]+)\/quilt-loader-\1\.jar$/.test(entry.canonical));
  if (quiltLauncher || quiltLibrary) {
    const match = quiltLibrary && /^libraries\/org\/quiltmc\/quilt-loader\/([^/]+)\//.exec(quiltLibrary.canonical);
    candidates.push({
      family: 'quilt', complete: Boolean(quiltLauncher && quiltLibrary),
      runtime: runtime('quilt', null, match?.[1] ?? null),
      evidence: [quiltLauncher && { kind: 'quilt-launcher', entryName: quiltLauncher.source.path }, quiltLibrary && { kind: 'quilt-loader-library', entryName: quiltLibrary.source.path }].filter(Boolean)
    });
  }

  for (const definition of [
    { family: 'forge', prefix: 'libraries/net/minecraftforge/forge/', artifact: 'forge' },
    { family: 'neoforge', prefix: 'libraries/net/neoforged/neoforge/', artifact: 'neoforge' }
  ]) {
    const argument = [...files.values()].find(entry => entry.canonical.startsWith(definition.prefix) && entry.canonical.endsWith('/win_args.txt'));
    if (!argument) continue;
    const version = argument.canonical.slice(definition.prefix.length, -'/win_args.txt'.length);
    const universal = files.get(`${definition.prefix}${version}/${definition.artifact}-${version}-universal.jar`);
    candidates.push({
      family: definition.family,
      complete: Boolean(universal),
      runtime: runtime(definition.family, definition.family === 'forge' ? version.split('-')[0] : null, version),
      evidence: [
        { kind: `${definition.family}-arguments`, entryName: argument.source.path },
        universal && { kind: `${definition.family}-library`, entryName: universal.source.path }
      ].filter(Boolean)
    });
  }
  return candidates;
}

function installerEvidence(files) {
  for (const entry of files.values()) {
    let match = /^forge-([0-9]+(?:\.[0-9]+){1,2})-([0-9][0-9A-Za-z._-]*)-installer\.jar$/.exec(entry.canonical);
    if (match) return { runtime: runtime('forge', match[1], match[2]), evidence: { kind: 'forge-installer', entryName: entry.source.path } };
    match = /^neoforge-([0-9][0-9A-Za-z._-]*)-installer\.jar$/.exec(entry.canonical);
    if (match) return { runtime: runtime('neoforge', null, match[1]), evidence: { kind: 'neoforge-installer', entryName: entry.source.path } };
    if (/^fabric-installer(?:-[0-9A-Za-z._-]+)?\.jar$/.test(entry.canonical)) return { runtime: runtime('fabric'), evidence: { kind: 'fabric-installer', entryName: entry.source.path } };
    if (/^quilt-installer(?:-[0-9A-Za-z._-]+)?\.jar$/.test(entry.canonical)) return { runtime: runtime('quilt'), evidence: { kind: 'quilt-installer', entryName: entry.source.path } };
  }
  return null;
}

function scriptsAndWrappers(files) {
  const scripts = [];
  const wrappers = [];
  for (const entry of files.values()) {
    if (/\.(?:bat|cmd|ps1|sh|exe)$/.test(entry.canonical)) scripts.push({ kind: 'convenience-script', entryName: entry.source.path });
    if (/\.(?:jar)$/.test(entry.canonical) && /(?:custom|wrapper|bootstrap)/.test(entry.canonical)) wrappers.push({ kind: 'custom-wrapper', entryName: entry.source.path });
  }
  return { scripts, wrappers };
}

async function classifyArchive({ entries, readEntry, selectedRoot = null } = {}) {
  const normalized = normalizedEntries(entries, selectedRoot);
  const files = new Map(normalized.filter(entry => entry.source.type === 'file').map(entry => [entry.canonical, entry]));
  const evidence = [];

  const mrpack = files.get('modrinth.index.json');
  if (mrpack) {
    const manifest = parseMrpackManifest(await readEvidence(readEntry, mrpack, 'mrpack-manifest', MRPACK_READ_LIMIT));
    try {
      const plan = buildMrpackServerPlan({
        manifest,
        archiveEntries: normalized.map(entry => ({ path: entry.relative, type: entry.source.type }))
      });
      return deepFreeze({
        kind: 'mrpack-server', confidence: 'exact', blocked: false,
        runtime: { ...plan.runtime },
        manifest: { versionId: manifest.versionId, name: manifest.name },
        planFingerprint: crypto.createHash('sha256').update(JSON.stringify(plan), 'utf8').digest('hex'),
        downloadCount: plan.downloads.filter(item => item.selected).length,
        optionalFiles: listOptionalFileChoices(manifest),
        overrideCount: plan.finalOverrides.length,
        evidence: [{ kind: 'modrinth-manifest', entryName: mrpack.source.path }]
      });
    } catch (error) {
      if (!(error instanceof ModpackError) || error.code !== 'CLIENT_ONLY_PACK') throw error;
      return deepFreeze({
        kind: 'mrpack-client-only', confidence: 'exact', blocked: true,
        runtime: manifestRuntime(manifest.dependencies),
        evidence: [{ kind: 'modrinth-server-incompatible', entryName: mrpack.source.path }]
      });
    }
  }

  const state = files.get('.minecraft-core.json');
  if (state && (files.has('server.properties') || [...files.keys()].some(name => name.startsWith('world/')))) {
    try {
      const bytes = await readEvidence(readEntry, state, 'minecraft-core-state', CONFIG_READ_LIMIT);
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.version === 'string' &&
          LOADERS.has(value.loader) && typeof value.loaderVersion === 'string') {
        return deepFreeze({
          kind: 'backup-archive', confidence: 'exact', blocked: true,
          runtime: runtime(value.loader, value.version, value.loaderVersion),
          evidence: [
            { kind: 'minecraft-core-state', entryName: state.source.path },
            { kind: files.has('server.properties') ? 'server-properties' : 'world-state', entryName: files.has('server.properties') ? files.get('server.properties').source.path : [...files.values()].find(entry => entry.canonical.startsWith('world/')).source.path }
          ]
        });
      }
    } catch (error) {
      if (error instanceof ModpackError) throw error;
    }
  }

  const loaderCandidates = preparedEvidence(files);
  if (loaderCandidates.length > 1) {
    return deepFreeze({
      kind: 'ambiguous-or-unknown', confidence: 'conflicting', blocked: true,
      candidates: loaderCandidates.map(candidate => ({ loaderFamily: candidate.family, complete: candidate.complete })),
      evidence: boundedEvidence(loaderCandidates.flatMap(candidate => candidate.evidence))
    });
  }

  const { scripts, wrappers } = scriptsAndWrappers(files);
  if (loaderCandidates.length === 1 && loaderCandidates[0].complete) {
    const candidate = loaderCandidates[0];
    return deepFreeze({
      kind: 'prepared-server-pack', confidence: 'exact', blocked: false,
      runtime: candidate.runtime,
      evidence: boundedEvidence([...candidate.evidence, ...scripts])
    });
  }

  const serverJar = files.get('server.jar');
  if (serverJar && loaderCandidates.length === 0) {
    return deepFreeze({
      kind: 'prepared-server-pack', confidence: 'exact', blocked: false,
      runtime: runtime('vanilla'),
      evidence: boundedEvidence([{ kind: 'server-jar', entryName: serverJar.source.path }, ...scripts])
    });
  }

  const installer = installerEvidence(files);
  if (installer) {
    return deepFreeze({
      kind: 'loader-installer-bundle', confidence: 'exact', blocked: false,
      runtime: installer.runtime,
      suppliedInstallerExecuted: false,
      evidence: boundedEvidence([installer.evidence, ...scripts])
    });
  }

  if (scripts.length || wrappers.length) {
    return deepFreeze({
      kind: 'unsupported-runtime-layout', confidence: 'exact', blocked: true,
      reasonCode: 'custom-bootstrap-required',
      evidence: boundedEvidence([...wrappers, ...scripts])
    });
  }

  const nestedCandidates = [...files.values()]
    .filter(entry => /(?:^|\/)server\.jar$/.test(entry.canonical) || /(?:^|\/)(?:fabric|quilt)-server-launch\.jar$/.test(entry.canonical))
    .map(entry => ({ kind: 'nested-runtime-candidate', entryName: entry.source.path }));
  evidence.push(...nestedCandidates);
  return deepFreeze({
    kind: 'ambiguous-or-unknown', confidence: nestedCandidates.length > 1 ? 'multiple-roots' : 'insufficient', blocked: true,
    candidates: boundedEvidence(nestedCandidates),
    evidence: boundedEvidence(evidence)
  });
}

module.exports = { classifyArchive };
