const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { Worker } = require('worker_threads');
const { assertSafeRemoteUrl, safeFilePath } = require('../../utils/security-boundaries.cjs');

// Cache extracted metadata by file signature so unchanged jars do not get reparsed.
const metadataCache = new Map();
const metadataCacheKeyByPath = new Map();
const metadataWorkerPath = path.join(__dirname, 'mod-metadata-worker.cjs');

function buildMetadataCacheKey(jarPath, stats) {
  return `${jarPath}::${stats.size}::${Math.trunc(stats.mtimeMs)}`;
}

function updateMetadataCacheKey(jarPath, cacheKey) {
  const previousKey = metadataCacheKeyByPath.get(jarPath);
  if (previousKey && previousKey !== cacheKey) {
    metadataCache.delete(previousKey);
  }
  metadataCacheKeyByPath.set(jarPath, cacheKey);
}

function invalidateMetadataCache(jarPath) {
  const previousKey = metadataCacheKeyByPath.get(jarPath);
  if (previousKey) {
    metadataCache.delete(previousKey);
    metadataCacheKeyByPath.delete(jarPath);
    return;
  }

  for (const key of Array.from(metadataCache.keys())) {
    if (key.startsWith(`${jarPath}::`)) {
      metadataCache.delete(key);
    }
  }
}

function isSystemDependencyId(id) {
  if (!id) return false;
  const canonical = String(id).toLowerCase().replace(/[^a-z]/g, '');
  return ['minecraft', 'java', 'javafml', 'forge', 'fabricloader', 'quiltloader'].includes(canonical);
}

function normalizeMetadataDependencyId(id) {
  if (!id) return '';
  const normalized = String(id).trim();
  const lower = normalized.toLowerCase();
  if (lower === 'fabric_api' || lower === 'fabricapi') {
    return 'fabric-api';
  }
  return normalized;
}

function normalizeDependencyType(type, mandatory = true) {
  if (typeof type === 'string') {
    const normalized = type.trim().toLowerCase();
    if (normalized === 'required' || normalized === 'depends') return 'required';
    if (normalized === 'optional' || normalized === 'recommends' || normalized === 'suggests') return 'optional';
    if (normalized === 'breaks' || normalized === 'conflicts') return 'incompatible';
  }

  return mandatory === false ? 'optional' : 'required';
}

function parseTomlPrimitive(value) {
  const trimmed = String(value || '').trim();
  const quoted = trimmed.match(/^(['"])(.*)\1$/);
  if (quoted) return quoted[2];
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  return trimmed;
}

function parseForgeDependencies(content, ownerModId) {
  const dependencies = [];
  const lines = content.split(/\r?\n/);
  let current = null;
  let currentOwner = null;

  const flush = () => {
    if (!current) return;
    const depId = normalizeMetadataDependencyId(current.modId);
    if (
      depId &&
      depId !== ownerModId &&
      !isSystemDependencyId(depId)
    ) {
      dependencies.push({
        id: depId,
        dependency_type: normalizeDependencyType(null, current.mandatory),
        version_requirement: typeof current.versionRange === 'string' ? current.versionRange : null,
        source: 'META-INF/mods.toml'
      });
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[\[dependencies\.([^\]]+)\]\]$/);
    if (sectionMatch) {
      flush();
      currentOwner = sectionMatch[1];
      current = {};
      continue;
    }

    if (!current || !currentOwner || currentOwner !== ownerModId) {
      continue;
    }

    const match = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (match) {
      current[match[1]] = parseTomlPrimitive(match[2]);
    }
  }

  flush();
  return dependencies;
}

function parseForgeModMetadata(content) {
  const metadata = { loaderType: 'forge', authors: [], dependencies: [] };
  const lines = content.split(/\r?\n/);
  let inFirstModBlock = false;
  let foundFirstModBlock = false;
  let inDescription = false;
  let currentDescription = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === '[[mods]]') {
      if (foundFirstModBlock) {
        break;
      }
      foundFirstModBlock = true;
      inFirstModBlock = true;
      continue;
    }

    if (!inFirstModBlock) {
      continue;
    }

    if (inDescription) {
      if (line.endsWith('"""') && line !== '"""') {
        currentDescription.push(line.substring(0, line.length - 3));
        metadata.description = currentDescription.join('\n');
        inDescription = false;
        continue;
      }

      if (line === '"""') {
        metadata.description = currentDescription.join('\n');
        inDescription = false;
        continue;
      }

      currentDescription.push(line);
      continue;
    }

    if (line.startsWith('[')) {
      break;
    }

    if (line.startsWith('description="""') || line === 'description="""') {
      inDescription = true;
      currentDescription = [];
      if (line.length > 15) {
        currentDescription.push(line.substring(15));
      }
      continue;
    }

    const match = line.match(/^(\w+)\s*=\s*(['"])(.*)\2$/);
    if (match) {
      const [, key, , value] = match;
      metadata[key] = value;
    }
  }

  metadata.name = metadata.displayName || metadata.modId || 'Unknown';
  metadata.version = metadata.version || 'Unknown';
  metadata.projectId = metadata.modId || metadata.name;
  metadata.dependencies = parseForgeDependencies(content, metadata.modId);

  return metadata;
}

function normalizeMetadataDependencyList(metadata) {
  if (!metadata || typeof metadata !== 'object') return [];

  if (metadata.loaderType === 'forge') {
    return Array.isArray(metadata.dependencies) ? metadata.dependencies : [];
  }

  const dependencies = [];
  const addDependency = (id, type, requirement) => {
    const normalizedId = normalizeMetadataDependencyId(id);
    if (!normalizedId || normalizedId === metadata.id || isSystemDependencyId(normalizedId)) {
      return;
    }

    dependencies.push({
      id: normalizedId,
      dependency_type: normalizeDependencyType(type),
      version_requirement: typeof requirement === 'string' ? requirement : null,
      source: 'fabric.mod.json'
    });
  };

  const depends = metadata.depends || metadata.dependencies;
  if (depends && typeof depends === 'object') {
    if (Array.isArray(depends)) {
      for (const dep of depends) {
        if (typeof dep === 'string') {
          addDependency(dep, 'required', null);
        } else if (dep && typeof dep === 'object') {
          addDependency(dep.id || dep.modid || dep.project_id || dep.projectId, dep.dependency_type || dep.type || 'required', dep.version_requirement || dep.versionRequirement || dep.version);
        }
      }
    } else {
      for (const [id, requirement] of Object.entries(depends)) {
        addDependency(id, 'required', requirement);
      }
    }
  }

  for (const field of ['recommends', 'suggests']) {
    const optionalDeps = metadata[field];
    if (!optionalDeps || typeof optionalDeps !== 'object') continue;
    for (const [id, requirement] of Object.entries(optionalDeps)) {
      addDependency(id, 'optional', requirement);
    }
  }

  for (const field of ['breaks', 'conflicts']) {
    const conflictDeps = metadata[field];
    if (!conflictDeps || typeof conflictDeps !== 'object') continue;
    for (const [id, requirement] of Object.entries(conflictDeps)) {
      addDependency(id, 'incompatible', requirement);
    }
  }

  return dependencies;
}

function parseJarMetadataSync(jarPath) {
  let result = null;

  try {
    const zip = new (/** @type {any} */ (AdmZip))(jarPath);
    const zipEntries = zip.getEntries();

    // Try fabric.mod.json
    const fabricEntry = zipEntries.find(entry =>
      entry.entryName === 'fabric.mod.json' ||
      entry.entryName.endsWith('/fabric.mod.json')
    );

    if (fabricEntry) {
      const content = fabricEntry.getData().toString('utf8');
      try {
        const metadata = JSON.parse(content);
        metadata.loaderType = metadata.loaderType || 'fabric';
        metadata.projectId = metadata.projectId || metadata.id;
        metadata.authors = metadata.authors || (metadata.author ? [metadata.author] : (metadata.contributors ? Object.keys(metadata.contributors) : []));
        metadata.name = metadata.name || metadata.id;
        return metadata;
      } catch {
        return null;
      }
    }

    // Try META-INF/mods.toml (Forge)
    const forgeEntry = zipEntries.find(entry =>
      entry.entryName === 'META-INF/mods.toml' ||
      entry.entryName.endsWith('/META-INF/mods.toml')
    );

    if (forgeEntry) {
      const content = forgeEntry.getData().toString('utf8');
      try {
        return parseForgeModMetadata(content);
      } catch {
        return null;
      }
    }

    // Try quilt.mod.json
    const quiltEntry = zipEntries.find(entry =>
      entry.entryName === 'quilt.mod.json' ||
      entry.entryName.endsWith('/quilt.mod.json')
    );

    if (quiltEntry) {
      const content = quiltEntry.getData().toString('utf8');
      try {
        const quiltJson = JSON.parse(content);
        const qmd = quiltJson.quilt_loader || quiltJson;
        
        return {
          loaderType: 'quilt',
          id: qmd.id,
          version: qmd.version,
          name: (qmd.metadata && qmd.metadata.name) || qmd.id,
          description: (qmd.metadata && qmd.metadata.description) || '',
          authors: qmd.metadata && qmd.metadata.contributors
            ? Object.keys(qmd.metadata.contributors)
            : (quiltJson.contributors ? Object.keys(quiltJson.contributors) : []),
          projectId: qmd.id
        };
      } catch {
        return null;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function extractMetadataWithWorker(jarPath) {
  return new Promise((resolve) => {
    let settled = false;
    let worker = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (worker) {
        worker.removeAllListeners();
        worker.terminate().catch(() => {});
      }
      resolve(value);
    };

    try {
      worker = new Worker(metadataWorkerPath, {
        workerData: { jarPath }
      });

      worker.once('message', (message) => {
        finish(message?.metadata ?? null);
      });

      worker.once('error', () => {
        finish(parseJarMetadataSync(jarPath));
      });

      worker.once('exit', (code) => {
        if (!settled) {
          finish(code === 0 ? null : parseJarMetadataSync(jarPath));
        }
      });
    } catch {
      finish(parseJarMetadataSync(jarPath));
    }
  });
}

async function extractDependenciesFromJar(jarPath) {
  try {
    const stats = await fs.stat(jarPath);
    const cacheKey = buildMetadataCacheKey(jarPath, stats);
    updateMetadataCacheKey(jarPath, cacheKey);

    if (metadataCache.has(cacheKey)) {
      return metadataCache.get(cacheKey);
    }

    const extractionPromise = extractMetadataWithWorker(jarPath)
      .then((metadata) => {
        const resolvedMetadata = metadata ?? null;
        metadataCache.set(cacheKey, resolvedMetadata);
        return resolvedMetadata;
      })
      .catch(() => {
        metadataCache.set(cacheKey, null);
        return null;
      });

    metadataCache.set(cacheKey, extractionPromise);
    return extractionPromise;
  } catch {
    invalidateMetadataCache(jarPath);
    return null;
  }
}

async function extractDependencyListFromJar(jarPath) {
  const metadata = await extractDependenciesFromJar(jarPath);
  return normalizeMetadataDependencyList(metadata);
}

async function fetchModInfoFromUrl(url) {
  const safeUrl = assertSafeRemoteUrl(url, { allowedProtocols: ['https:'] });
  const tempFile = safeFilePath(os.tmpdir(), `mod-${Date.now()}.jar`, 'temporary mod file name', {
    allowedExtensions: ['.jar']
  });
  const maxJarBytes = 100 * 1024 * 1024;

  try {
    const response = await axios({
      url: safeUrl,
      method: 'GET',
      responseType: 'arraybuffer',
      timeout: 60000,
      maxContentLength: maxJarBytes,
      maxBodyLength: maxJarBytes,
      validateStatus: (status) => status >= 200 && status < 300
    });

    const contentLength = Number.parseInt(response.headers?.['content-length'] || '0', 10);
    if (contentLength > maxJarBytes || response.data.byteLength > maxJarBytes) {
      return [];
    }

    await fs.writeFile(tempFile, response.data);
    return await extractDependencyListFromJar(tempFile);
  } catch {
    return [];
  } finally {
    try {
      await fs.unlink(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function analyzeModFromUrl(url, modId) {
  void modId;
  return await fetchModInfoFromUrl(url);
}

module.exports = {
  extractDependenciesFromJar,
  extractDependencyListFromJar,
  fetchModInfoFromUrl,
  analyzeModFromUrl,
  invalidateMetadataCache,
  parseJarMetadataSync
};
