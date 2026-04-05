const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { setMaxListeners } = require('node:events');
const { 
  installTask,
  getVersionList
} = require('@xmcl/installer');
const utils = require('./utils.cjs');
const {
  installClientLoader,
  getLoaderVersions,
  normalizeLoader: normalizeLoaderName
} = require('../loader-install-service.cjs');

// XMCL Configuration - Optimized to prevent stuck downloads
const XMCL_CONFIG = {
  // Network configuration - Balanced between speed and reliability
  connectionTimeout: 45000, // 45s for very slow connections and large asset files
  maxRetries: 2, // Reduce retries to fail faster on truly stuck files
  retryDelay: 3000, // Start with 3s delay
  maxRetryDelay: 15000, // Max 15s delay for exponential backoff
  
  // Concurrency limits - Conservative to prevent overwhelming slow connections
  maxConcurrentDownloads: 3, // Further reduced for stability
  maxAssetConcurrency: 2, // Keep asset downloads conservative
  
  // Memory management
  maxEventListeners: 50, // Increased limit for multiple downloads
  
  // Progress reporting throttling - Slightly slower to reduce overhead
  progressThrottleMs: 500 // Update progress every 500ms to reduce noise
};

// Set environment variables for XMCL's internal HTTP client
process.env.UNDICI_CONNECT_TIMEOUT = XMCL_CONFIG.connectionTimeout.toString();
process.env.UNDICI_HEADERS_TIMEOUT = XMCL_CONFIG.connectionTimeout.toString();
process.env.UNDICI_BODY_TIMEOUT = XMCL_CONFIG.connectionTimeout.toString();

try {
  setMaxListeners(XMCL_CONFIG.maxEventListeners, AbortSignal.prototype);
} catch {
  // Ignore listener-limit tuning failures and keep downloads working.
}

async function removePathWithRetries(targetPath, { recursive = false } = {}) {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return false;
  }

  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.promises.rm(targetPath, {
        recursive,
        force: true,
        maxRetries: 6,
        retryDelay: 200
      });

      if (!fs.existsSync(targetPath)) {
        return true;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }

  if (fs.existsSync(targetPath)) {
    throw lastError || new Error(`Failed to remove ${targetPath}`);
  }

  return true;
}

async function clearForgeLibraryArtifacts(clientPath, minecraftVersion) {
  const forgeRoot = path.join(clientPath, 'libraries', 'net', 'minecraftforge', 'forge');
  if (!fs.existsSync(forgeRoot)) {
    return [];
  }

  const clearedItems = [];
  const entries = await fs.promises.readdir(forgeRoot, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (!entry.name.startsWith(`${minecraftVersion}-`)) {
      continue;
    }

    const targetPath = path.join(forgeRoot, entry.name);
    await removePathWithRetries(targetPath, { recursive: true });
    clearedItems.push(`Forge runtime ${entry.name}`);
  }

  return clearedItems;
}

/**
 * XMCL-based Minecraft Client Downloader
 * Replaces the complex manual implementation with the professional @xmcl/installer library
 * Maintains compatibility with existing UI events and progress system
 */
class XMCLClientDownloader {
  constructor(javaManager, eventEmitter, legacyClientDownloader = null) {
    this.javaManager = javaManager;
    this.emitter = eventEmitter;
    this.legacyClientDownloader = legacyClientDownloader;
    this.versionCache = null;
    
    // Apply improved memory management configuration
    if (this.emitter && this.emitter.setMaxListeners) {
      this.emitter.setMaxListeners(XMCL_CONFIG.maxEventListeners);
    }
    
    // Also increase for process if needed
    if (process.setMaxListeners) {
      process.setMaxListeners(XMCL_CONFIG.maxEventListeners);
    }
    
    // Progress throttling state
    this.lastProgressUpdate = 0;
    
    // Download phase tracking
    this.currentPhase = 0;
    this.totalPhases = 0;
    this.phaseNames = [];
    
    // Progress monitoring for stuck detection
    this.lastProgressTime = Date.now();
    this.lastProgressValue = 0;
    this.stuckDetectionTimeout = 60000; // 60 seconds without progress = stuck
    
    // Note: MaxListenersExceededWarning for AbortSignal during downloads is expected
    // XMCL library creates many AbortSignal instances for concurrent downloads
    // These warnings are harmless and don't affect functionality
  }

  _normalizeFabricProfileName(fabricIdentifier, minecraftVersion) {
    if (!fabricIdentifier || !minecraftVersion) {
      return null;
    }

    const identifier = String(fabricIdentifier);

    if (identifier.startsWith('fabric-loader-')) {
      return identifier;
    }

    return `fabric-loader-${identifier}-${minecraftVersion}`;
  }

  /**
   * Get cached version list or fetch if not available
   */
  async getVersionList() {
    if (!this.versionCache) {
      try {
        this.versionCache = await getVersionList();
      } catch (error) {
        throw new Error(`Failed to fetch Minecraft version list: ${error.message}`);
      }
    }
    return this.versionCache;
  }

  /**
   * Extract clean version from fabric profile name if needed
   */
  extractVersionFromProfileName(versionString) {
    if (!versionString) return 'latest';
    
    // If already a clean version (just numbers and dots), return as-is
    if (/^\d+\.\d+\.\d+$/.test(versionString)) {
      return versionString;
    }
    
    // If it's a fabric profile name like "fabric-loader-0.16.14-1.21.1", extract just the loader version
    if (versionString.startsWith('fabric-loader-')) {
      const parts = versionString.split('-');
      // fabric-loader-X.Y.Z-MC_VERSION -> extract X.Y.Z
      if (parts.length >= 3) {
        return parts[2]; // The loader version part
      }
    }
    
    // Otherwise return as-is
    return versionString;
  }

  /**
   * Resolve Fabric loader version (handle 'latest' keyword)
   */
  async resolveFabricVersion(requestedVersion) {
    // First clean the version in case it's a profile name
    const cleanVersion = this.extractVersionFromProfileName(requestedVersion);
    
    if (cleanVersion === 'latest') {
      try {
        // Fetch from Fabric Meta API directly
        const response = await fetch('https://meta.fabricmc.net/v2/versions/loader');
        const loaders = await response.json();
        if (loaders && loaders.length > 0 && loaders[0].version) {
          return loaders[0].version;
        }
        return '0.15.11'; // Fallback to known stable version
      } catch {
        return '0.15.11'; // Fallback
      }
    }
    return cleanVersion;
  }

  /**
   * Extract the Fabric loader version from a profile name like
   * fabric-loader-0.16.0-1.21 (simple parser, no Unicode).
   */
  _extractLoaderVersionFromProfile(profileName) {
    if (!profileName || typeof profileName !== 'string') return null;
    const prefix = 'fabric-loader-';
    if (!profileName.startsWith(prefix)) return null;

    const remainder = profileName.slice(prefix.length);
    const dash = remainder.lastIndexOf('-');
    if (dash === -1) return remainder || null;
    const loader = remainder.slice(0, dash);
    return loader || null;
  }

  /**
   * Find the best matching Fabric profile for a given Minecraft version.
   */
  _getInstalledFabricProfile(clientPath, minecraftVersion) {
    try {
      const versionsDir = path.join(clientPath, 'versions');
      if (!fs.existsSync(versionsDir)) {
        return { profile: null, loaderVersion: null, detectedProfiles: [], versionsDirPath: versionsDir, versionsDirExists: false };
      }

      const targetMc = String(minecraftVersion || '').trim();
      const entries = fs.readdirSync(versionsDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name)
        .filter(name => name.startsWith('fabric-loader-'));

      const detectedProfiles = [...entries];
      const versionsDirEntries = fs.readdirSync(versionsDir, { withFileTypes: true }).map(d => d.name);
      const matching = entries.filter(name => targetMc && name.endsWith(`-${targetMc}`));
      const candidates = matching.length > 0 ? matching : entries;

      const parseLoader = (name) => this._extractLoaderVersionFromProfile(name);
      const compareVersions = (a, b) => {
        const toParts = (v) => {
          const [mainRaw, preRaw] = String(v || '').split('-', 2);
          const main = mainRaw.split('.').map(num => {
            const parsed = parseInt(num, 10);
            return Number.isNaN(parsed) ? 0 : parsed;
          });
          const pre = typeof preRaw === 'string'
            ? preRaw.split('.').map(id => {
              const parsed = parseInt(id, 10);
              return Number.isNaN(parsed) ? id : parsed;
            })
            : null;
          return { main, pre };
        };

        const ap = toParts(a);
        const bp = toParts(b);
        const len = Math.max(ap.main.length, bp.main.length);
        for (let i = 0; i < len; i++) {
          const ai = ap.main[i] ?? 0;
          const bi = bp.main[i] ?? 0;
          if (ai !== bi) return ai - bi;
        }

        const aPre = ap.pre;
        const bPre = bp.pre;
        if (aPre === null && bPre === null) return 0;
        if (aPre === null) return 1; // release beats prerelease
        if (bPre === null) return -1;

        const preLen = Math.max(aPre.length, bPre.length);
        for (let i = 0; i < preLen; i++) {
          const ai = aPre[i];
          const bi = bPre[i];
          if (ai === undefined) return -1;
          if (bi === undefined) return 1;
          if (ai === bi) continue;

          const aiNum = typeof ai === 'number';
          const biNum = typeof bi === 'number';
          if (aiNum && biNum) return ai - bi;
          if (aiNum !== biNum) return aiNum ? -1 : 1; // numeric identifiers sort lower than text
          return String(ai).localeCompare(String(bi));
        }

        return 0;
      };

      let bestProfile = null;
      let bestVersion = null;
      for (const candidate of candidates) {
        const v = parseLoader(candidate);
        if (!v) continue;
        if (!bestVersion || compareVersions(v, bestVersion) > 0) {
          bestProfile = candidate;
          bestVersion = v;
        }
      }

      return {
        profile: bestProfile,
        loaderVersion: bestVersion,
        detectedProfiles,
        versionsDirEntries,
        versionsDirPath: versionsDir,
        versionsDirExists: true
      };
    } catch {
      return { profile: null, loaderVersion: null, detectedProfiles: [], versionsDirEntries: [], versionsDirPath: null, versionsDirExists: true };
    }
  }

  normalizeLoaderType(loaderType) {
    const normalized = normalizeLoaderName(loaderType || 'vanilla');
    return normalized || 'vanilla';
  }

  getLoaderDisplayName(loaderType) {
    const normalized = this.normalizeLoaderType(loaderType);
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  normalizeLoaderVersion(loaderType, loaderVersion, minecraftVersion = '') {
    const normalizedLoader = this.normalizeLoaderType(loaderType);
    if (loaderVersion === null || loaderVersion === undefined) {
      return null;
    }

    const rawVersion = String(loaderVersion).trim();
    if (!rawVersion) {
      return null;
    }

    if (normalizedLoader !== 'forge') {
      return rawVersion;
    }

    const normalizedMinecraftVersion = typeof minecraftVersion === 'string'
      ? minecraftVersion.trim()
      : '';

    if (normalizedMinecraftVersion && rawVersion.startsWith(`${normalizedMinecraftVersion}-`)) {
      return rawVersion.slice(normalizedMinecraftVersion.length + 1);
    }

    const prefixedForgeMatch = rawVersion.match(/^(\d+\.\d+(?:\.\d+)?)-(.+)$/);
    if (prefixedForgeMatch) {
      const [, detectedMinecraftVersion, forgeVersion] = prefixedForgeMatch;
      if (!normalizedMinecraftVersion || detectedMinecraftVersion === normalizedMinecraftVersion) {
        return forgeVersion;
      }
    }

    return rawVersion;
  }

  areLoaderVersionsEquivalent(loaderType, leftVersion, rightVersion, minecraftVersion = '') {
    const left = this.normalizeLoaderVersion(loaderType, leftVersion, minecraftVersion);
    const right = this.normalizeLoaderVersion(loaderType, rightVersion, minecraftVersion);

    if (!left || !right) {
      return left === right;
    }

    return left === right;
  }

  compareVersions(a, b) {
    const toParts = (value) => {
      const [mainRaw, preRaw] = String(value || '').split('-', 2);
      const main = mainRaw.split('.').map((num) => {
        const parsed = parseInt(num, 10);
        return Number.isNaN(parsed) ? 0 : parsed;
      });
      const pre = typeof preRaw === 'string'
        ? preRaw.split('.').map((id) => {
          const parsed = parseInt(id, 10);
          return Number.isNaN(parsed) ? id : parsed;
        })
        : null;
      return { main, pre };
    };

    const ap = toParts(a);
    const bp = toParts(b);
    const len = Math.max(ap.main.length, bp.main.length);
    for (let i = 0; i < len; i += 1) {
      const ai = ap.main[i] ?? 0;
      const bi = bp.main[i] ?? 0;
      if (ai !== bi) return ai - bi;
    }

    const aPre = ap.pre;
    const bPre = bp.pre;
    if (aPre === null && bPre === null) return 0;
    if (aPre === null) return 1;
    if (bPre === null) return -1;

    const preLen = Math.max(aPre.length, bPre.length);
    for (let i = 0; i < preLen; i += 1) {
      const ai = aPre[i];
      const bi = bPre[i];
      if (ai === undefined) return -1;
      if (bi === undefined) return 1;
      if (ai === bi) continue;

      const aiNum = typeof ai === 'number';
      const biNum = typeof bi === 'number';
      if (aiNum && biNum) return ai - bi;
      if (aiNum !== biNum) return aiNum ? -1 : 1;
      return String(ai).localeCompare(String(bi));
    }

    return 0;
  }

  async resolveRequestedLoaderVersion(loaderType, requestedVersion, minecraftVersion) {
    const normalizedLoader = this.normalizeLoaderType(loaderType);
    if (normalizedLoader === 'vanilla') {
      return null;
    }

    const requested = requestedVersion ? String(requestedVersion).trim() : '';
    if (requested && requested.toLowerCase() !== 'latest') {
      return this.normalizeLoaderVersion(normalizedLoader, requested, minecraftVersion);
    }

    try {
      const versions = await getLoaderVersions(normalizedLoader, minecraftVersion);
      return this.normalizeLoaderVersion(
        normalizedLoader,
        versions[0] || requested || null,
        minecraftVersion
      );
    } catch {
      return this.normalizeLoaderVersion(normalizedLoader, requested || null, minecraftVersion);
    }
  }

  extractLoaderMetadata(versionJson = {}, versionId = '') {
    const libraries = Array.isArray(versionJson.libraries) ? versionJson.libraries : [];
    for (const library of libraries) {
      const name = typeof library?.name === 'string' ? library.name : '';
      if (!name) continue;

      if (name.startsWith('net.fabricmc:fabric-loader:')) {
        return {
          loaderType: 'fabric',
          loaderVersion: name.split(':')[2] || null
        };
      }

      if (name.startsWith('net.minecraftforge:fmlloader:')) {
        const rawVersion = name.split(':')[2] || null;
        const baseVersion = versionJson.inheritsFrom || versionId || '';
        return {
          loaderType: 'forge',
          loaderVersion: this.normalizeLoaderVersion('forge', rawVersion, baseVersion)
        };
      }

      if (name.startsWith('net.minecraftforge:forge:')) {
        const rawVersion = name.split(':')[2] || '';
        const baseVersion = versionJson.inheritsFrom || versionId || '';
        return {
          loaderType: 'forge',
          loaderVersion: this.normalizeLoaderVersion('forge', rawVersion, baseVersion)
        };
      }
    }

    return {
      loaderType: 'vanilla',
      loaderVersion: null
    };
  }

  readInstalledVersionProfile(clientPath, versionId) {
    try {
      const versionJsonPath = path.join(clientPath, 'versions', versionId, `${versionId}.json`);
      if (!fs.existsSync(versionJsonPath)) {
        return null;
      }

      const versionJson = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
      const loaderMetadata = this.extractLoaderMetadata(versionJson, versionId);
      const baseVersion = versionJson.inheritsFrom || versionId;

      return {
        profileId: versionId,
        baseVersion,
        loaderType: loaderMetadata.loaderType,
        loaderVersion: loaderMetadata.loaderVersion,
        isLoaderProfile: loaderMetadata.loaderType !== 'vanilla' || !!versionJson.inheritsFrom,
        versionJson
      };
    } catch {
      return null;
    }
  }

  scanInstalledLoaderProfiles(clientPath, minecraftVersion, requestedLoaderType = 'vanilla', requestedLoaderVersion = null) {
    const versionsDir = path.join(clientPath, 'versions');
    if (!fs.existsSync(versionsDir)) {
      return {
        profiles: [],
        detectedProfiles: [],
        bestMatch: null,
        versionsDirPath: versionsDir,
        versionsDirExists: false,
        versionsDirEntries: []
      };
    }

    try {
      const entries = fs.readdirSync(versionsDir, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);

      const profiles = entries
        .map((entry) => this.readInstalledVersionProfile(clientPath, entry))
        .filter(Boolean);

      const matchingBase = profiles.filter((profile) => profile.baseVersion === minecraftVersion || profile.profileId === minecraftVersion);
      const requestedLoader = this.normalizeLoaderType(requestedLoaderType);
      const loaderProfiles = matchingBase.filter((profile) => profile.loaderType !== 'vanilla');
      const preferredProfiles = requestedLoader === 'vanilla'
        ? loaderProfiles
        : loaderProfiles.filter((profile) => profile.loaderType === requestedLoader);

      const rankedProfiles = (preferredProfiles.length > 0 ? preferredProfiles : loaderProfiles).slice().sort((a, b) => {
        if (!!requestedLoaderVersion) {
          const aMatches = this.areLoaderVersionsEquivalent(
            requestedLoader,
            a.loaderVersion,
            requestedLoaderVersion,
            minecraftVersion
          ) ? 1 : 0;
          const bMatches = this.areLoaderVersionsEquivalent(
            requestedLoader,
            b.loaderVersion,
            requestedLoaderVersion,
            minecraftVersion
          ) ? 1 : 0;
          if (aMatches !== bMatches) {
            return aMatches - bMatches;
          }
        }
        return this.compareVersions(a.loaderVersion || '0', b.loaderVersion || '0');
      });

      return {
        profiles,
        detectedProfiles: loaderProfiles.map((profile) => ({
          profileId: profile.profileId,
          loaderType: profile.loaderType,
          loaderVersion: profile.loaderVersion,
          baseVersion: profile.baseVersion
        })),
        bestMatch: rankedProfiles.length > 0 ? rankedProfiles[rankedProfiles.length - 1] : null,
        versionsDirPath: versionsDir,
        versionsDirExists: true,
        versionsDirEntries: entries
      };
    } catch {
      return {
        profiles: [],
        detectedProfiles: [],
        bestMatch: null,
        versionsDirPath: versionsDir,
        versionsDirExists: true,
        versionsDirEntries: []
      };
    }
  }

  /**
   * Main download method - replaces the complex downloadMinecraftClientSimple
   */
  async downloadMinecraftClientSimple(clientPath, minecraftVersion, options = {}) {
    this.javaManager.setClientPath(clientPath);

    this.emitter.emit('client-download-start', { version: minecraftVersion });
    
    const { 
      requiredMods = [], 
      serverInfo = null 
    } = options;
    
    const loaderType = this.normalizeLoaderType(
      serverInfo?.loaderType || serverInfo?.loader || (serverInfo?.fabric ? 'fabric' : 'vanilla')
    );
    const loaderRequired = loaderType !== 'vanilla';
    const requestedLoaderVersion = serverInfo?.loaderVersion || serverInfo?.fabric || null;
    let resolvedLoaderVersion = null;
    
            const maxRetries = XMCL_CONFIG.maxRetries;
        let retryCount = 0;
        
        while (retryCount < maxRetries) {
      try {
        if (retryCount > 0) {
          this.emitter.emit('client-download-progress', {
            type: 'Retrying',
            task: `Retry attempt ${retryCount + 1}/${maxRetries}...`,
            total: 1,
            current: 0
          });
          const retryDelay = Math.min(XMCL_CONFIG.retryDelay * retryCount, XMCL_CONFIG.maxRetryDelay);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }

        // Step 1: Ensure Java is available
        const { requiredJavaVersion } = await utils.resolveRequiredJavaVersion(minecraftVersion);
        
        this.emitter.emit('client-download-progress', {
          type: 'Java',
          task: `Checking Java ${requiredJavaVersion}...`,
          total: 1
        });
        
        const javaResult = await this.javaManager.ensureJava(requiredJavaVersion, (progress) => {
          this.emitter.emit('client-download-progress', {
            type: progress.type,
            task: progress.task,
            total: progress.totalMB || 0,
            current: progress.downloadedMB || 0
          });
        });
        
        if (!javaResult.success) {
          throw new Error(`Failed to obtain Java ${requiredJavaVersion}: ${javaResult.error}`);
        }

        // Step 2: Get version info
        this.emitter.emit('client-download-progress', {
          type: 'Preparing',
          task: 'Fetching version information...',
          total: 1
        });

        const versionList = await this.getVersionList();
        const versionInfo = versionList.versions.find(v => v.id === minecraftVersion);
        
        if (!versionInfo) {
          throw new Error(`Minecraft version ${minecraftVersion} not found`);
        }

        // Step 3: Calculate total phases and start download
        this.setupDownloadPhases(loaderType);
        
        this.emitter.emit('client-download-progress', {
          type: 'Progress',
          task: 'Downloading Minecraft client, libraries, and assets...',
          total: 100,
          current: 0,
          phase: `Preparing (0/${this.totalPhases})`
        });

        const installTaskInstance = await this.createRobustInstallTask(versionInfo, clientPath);
        
        // Track if download is cancelled to prevent memory leaks
        let isCancelled = false;
        
        // Start progress monitoring for stuck detection
        const progressMonitor = setInterval(() => {
          if (isCancelled) {
            clearInterval(progressMonitor);
            return;
          }
          
          if (this.isDownloadStuck()) {
            // TODO: Add proper logging - Download appears stuck
            this.emitter.emit('client-download-progress', {
              type: 'Warning',
              task: 'Download seems slow, please wait or try "Clear All & Re-download"...',
              total: 100,
              current: this.lastProgressValue,
              phase: this.getCurrentPhaseInfo()
            });
          }
        }, 30000); // Check every 30 seconds
        
        try {
          // Monitor installation progress with improved error handling and timeout
          const downloadPromise = installTaskInstance.startAndWait({
            onStart: (task) => {
              if (isCancelled) return;
              
              // Convert XMCL task path to user-friendly message with phase progress
              const taskMessage = this.getTaskDisplayName(task);
              const phaseInfo = this.getCurrentPhaseInfo();
              this.throttledProgressUpdate({
                type: 'Progress',
                task: taskMessage,
                total: 100,
                current: Math.round((installTaskInstance.progress / installTaskInstance.total) * 100),
                phase: phaseInfo
              });
            },
            onUpdate: (task) => {
              if (isCancelled) return;
              
              // Update progress based on overall installation progress
              const overallProgress = Math.round((installTaskInstance.progress / installTaskInstance.total) * 100);
              const taskMessage = this.getTaskDisplayName(task);
              const phaseInfo = this.getCurrentPhaseInfo();
              
              this.throttledProgressUpdate({
                type: 'Progress',
                task: taskMessage,
                total: 100,
                current: overallProgress,
                phase: phaseInfo
              });
            },
            onFailed: () => {
              if (!isCancelled) {
                // TODO: Add proper logging - Task failed, will retry
              }
            },
            onSucceed: (task) => {
              if (isCancelled) return;
              
              // Task completed successfully
              const overallProgress = Math.round((installTaskInstance.progress / installTaskInstance.total) * 100);
              const taskMessage = this.getTaskDisplayName(task);
              const phaseInfo = this.getCurrentPhaseInfo();
              this.throttledProgressUpdate({
                type: 'Progress',
                task: taskMessage,
                total: 100,
                current: overallProgress,
                phase: phaseInfo
              });
            }
          });

          // Add overall timeout to prevent indefinite hanging
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
              reject(new Error('Download timeout: Operation took too long to complete. Network may be slow or some files are unavailable.'));
            }, 600000); // 10 minute total timeout
          });

          // Race between download completion and timeout
          await Promise.race([downloadPromise, timeoutPromise]);
          
        } catch (error) {
          // Enhanced error handling - try to recover from common issues
          isCancelled = true;
          clearInterval(progressMonitor);
          
          // Enhanced error detection for stuck downloads
          if (error.message && error.message.includes('timeout')) {
            throw new Error('Download timed out. This often happens with slow connections or during peak hours. Please try "Clear All & Re-download" for a fresh start.');
          }
          
          if (error.message && error.message.includes('ENOTFOUND')) {
            throw new Error('Network connection failed. Please check your internet connection and try again.');
          } else if (error.message && (error.message.includes('timeout') || error.message.includes('ConnectTimeoutError') || error.message.includes('took too long'))) {
            throw new Error('Download timed out due to slow connection or stuck assets. This is common with large asset downloads. Please try "Clear All & Re-download" for a fresh start.');
          } else if (error.message && error.message.includes('checksum')) {
            throw new Error('Download verification failed - some files were incomplete. Please use "Clear All & Re-download" to fix this issue.');
          } else if (error.message && error.message.includes('resources.download.minecraft.net')) {
            throw new Error('Minecraft asset servers are experiencing issues. Please try again later or use "Clear All & Re-download" for a fresh start.');
          } else {
            throw error; // Re-throw original error if we can't handle it
          }
        }

        let finalVersion = minecraftVersion;

        // Step 4: Install the requested loader profile if needed
        if (loaderRequired) {
          this.currentPhase = this.totalPhases; // Move to Fabric phase
          const phaseInfo = this.getCurrentPhaseInfo();
          const loaderLabel = this.getLoaderDisplayName(loaderType);
          this.emitter.emit('client-download-progress', {
            type: loaderLabel,
            task: `Downloading ${loaderLabel} loader ${requestedLoaderVersion || 'latest'} - ${phaseInfo}...`,
            total: 100,
            current: 90,
            phase: phaseInfo
          });

          try {
            resolvedLoaderVersion = await this.resolveRequestedLoaderVersion(loaderType, requestedLoaderVersion, minecraftVersion);
            if (!resolvedLoaderVersion) {
              throw new Error(`${loaderLabel} loader version could not be resolved for Minecraft ${minecraftVersion}`);
            }

            const loaderResult = await installClientLoader({
              clientPath,
              minecraftVersion,
              loader: loaderType,
              loaderVersion: resolvedLoaderVersion,
              javaPath: javaResult.javaPath || null
            });

            finalVersion = loaderResult.profileId || minecraftVersion;

            this.emitter.emit('client-download-progress', {
              type: loaderLabel,
              task: `✅ ${loaderLabel} ${resolvedLoaderVersion} ready - ${phaseInfo}`,
              total: 100,
              current: 95,
              phase: phaseInfo
            });
          } catch (loaderError) {
            if (loaderType === 'fabric' && this.legacyClientDownloader) {
              const cleanFabricVersion = this.extractVersionFromProfileName(requestedLoaderVersion || 'latest');
              const legacyFabricResult = await this.legacyClientDownloader.installFabricLoader(clientPath, minecraftVersion, cleanFabricVersion);

              if (!legacyFabricResult.success) {
                throw new Error(`Fabric installation failed: ${legacyFabricResult.error || loaderError.message}`);
              }

              resolvedLoaderVersion = legacyFabricResult.loaderVersion;
              finalVersion = legacyFabricResult.profileName;
              this.emitter.emit('client-download-progress', {
                type: 'Fabric',
                task: `✅ Fabric ${resolvedLoaderVersion} ready - ${phaseInfo}`,
                total: 100,
                current: 95,
                phase: phaseInfo
              });
            } else {
              throw loaderError;
            }
          }
        }

        // Step 5: Final verification (now with correct finalVersion)
        this.emitter.emit('client-download-progress', {
          type: 'Verifying',
          task: 'Verifying installation...',
          total: 100,
          current: 98
        });

        // Use the XMCL verifier directly to avoid any legacy version resolution issues
        const verificationResult = await this.verifyInstallation(clientPath, finalVersion);
        
        if (!verificationResult.success) {
          throw new Error(`Installation verification failed: ${verificationResult.error}`);
        }

        // Step 6: Success!
        const clientType = loaderRequired ? `${this.getLoaderDisplayName(loaderType)} ${resolvedLoaderVersion}` : 'Vanilla';
        const successMessage = loaderRequired ? 
          `✅ Minecraft ${minecraftVersion} with ${clientType} installation completed successfully` :
          `✅ Minecraft ${minecraftVersion} (${clientType}) installation completed successfully`;
          
        this.emitter.emit('client-download-progress', {
          type: 'Complete',
          task: successMessage,
          total: 100,
          current: 100
        });

        // Step 7: Automatic cleanup of old versions
        this.emitter.emit('client-download-progress', {
          type: 'Cleanup',
          task: '🗑️ Cleaning up old versions...',
          total: 100,
          current: 100
        });

        const cleanupResult = await this.cleanupOldVersions(clientPath, minecraftVersion, {
          profileId: loaderRequired ? finalVersion : null,
          loaderType,
          loaderVersion: resolvedLoaderVersion
        });
        if (cleanupResult.success) {
          // Cleanup successful
        } else {
          // TODO: Add proper logging - Cleanup warning
        }

        // Clean up progress monitor
        clearInterval(progressMonitor);
        
        this.emitter.emit('client-download-complete', {
          success: true,
          version: finalVersion,
          minecraftVersion: minecraftVersion,
          loaderType,
          loaderVersion: loaderRequired ? resolvedLoaderVersion : null,
          fabricVersion: loaderType === 'fabric' ? resolvedLoaderVersion : null,
          path: clientPath,
          cleanup: cleanupResult
        });

        return {
          success: true,
          version: finalVersion,
          minecraftVersion: minecraftVersion,
          loaderType,
          loaderVersion: loaderRequired ? resolvedLoaderVersion : null,
          fabricVersion: loaderType === 'fabric' ? resolvedLoaderVersion : null,
          cleanup: cleanupResult
        };

      } catch (error) {
        // TODO: Add proper logging - Download attempt failed
        
        retryCount++;
        if (retryCount >= maxRetries) {
          this.emitter.emit('client-download-error', {
            error: error.message,
            version: minecraftVersion,
            attempt: retryCount
          });
          
          throw new Error(`Download failed after ${maxRetries} attempts: ${error.message}`);
        }
      }
    }
  }

  /**
   * Create a robust install task with improved error handling and retry logic
   */
  async createRobustInstallTask(versionInfo, clientPath) {
    // Create XMCL install task with environment variables set for timeouts
    const task = installTask(versionInfo, clientPath);
    
    return task;
  }

  /**
   * Throttled progress update to prevent event flooding and detect stuck downloads
   */
  throttledProgressUpdate(progressData) {
    const now = Date.now();
    
    // Check if progress has actually changed (not stuck)
    if (progressData.current !== this.lastProgressValue) {
      this.lastProgressTime = now;
      this.lastProgressValue = progressData.current;
    }
    
    // Only emit progress updates at specified intervals
    if (now - this.lastProgressUpdate >= XMCL_CONFIG.progressThrottleMs) {
      this.emitter.emit('client-download-progress', progressData);
      this.lastProgressUpdate = now;
    }
  }

  /**
   * Check if download appears to be stuck
   */
  isDownloadStuck() {
    const timeSinceLastProgress = Date.now() - this.lastProgressTime;
    return timeSinceLastProgress > this.stuckDetectionTimeout;
  }

  /**
   * Setup download phases for progress tracking
   */
  setupDownloadPhases(loaderType) {
    this.phaseNames = [
      'Minecraft JAR',
      'Game Libraries', 
      'Game Assets'
    ];
    
    const normalizedLoader = this.normalizeLoaderType(loaderType);
    if (normalizedLoader !== 'vanilla') {
      this.phaseNames.push(`${this.getLoaderDisplayName(normalizedLoader)} Loader`);
    }
    
    this.totalPhases = this.phaseNames.length;
    this.currentPhase = 0;
  }

  /**
   * Get current phase info for progress display
   */
  getCurrentPhaseInfo() {
    if (this.currentPhase > 0 && this.currentPhase <= this.totalPhases) {
      const phaseName = this.phaseNames[this.currentPhase - 1];
      return `${phaseName} (${this.currentPhase}/${this.totalPhases})`;
    }
    return `Preparing (0/${this.totalPhases})`;
  }

  /**
   * Convert XMCL task path to user-friendly display name with phase progress
   */
  getTaskDisplayName(task) {
    const path = task.path || '';
    const taskName = task.name || '';
    
    // Update current phase based on what's being downloaded
    if (path.includes('install.version.json') || path.includes('install.version.jar')) {
      this.currentPhase = 1; // Minecraft JAR phase
    } else if (path.includes('install.dependencies.libraries') || path.includes('install.libraries')) {
      this.currentPhase = 2; // Libraries phase
    } else if (path.includes('install.dependencies.assets') || path.includes('install.assets')) {
      this.currentPhase = 3; // Assets phase
    }
    
    const phaseInfo = this.getCurrentPhaseInfo();
    
    // Convert technical task paths to user-friendly messages
    if (path.includes('install.version.json')) {
      return `Downloading version manifest - ${phaseInfo}...`;
    } else if (path.includes('install.version.jar')) {
      return `Downloading Minecraft ${taskName} JAR - ${phaseInfo}...`;
    } else if (path.includes('install.dependencies.assets') || path.includes('install.assets')) {
      return `Downloading game assets - ${phaseInfo}...`;
    } else if (path.includes('install.dependencies.libraries') || path.includes('install.libraries')) {
      return `Downloading game libraries - ${phaseInfo}...`;
    } else if (path.includes('install.dependencies')) {
      return `Downloading dependencies - ${phaseInfo}...`;
    } else if (taskName && taskName !== 'install') {
      return `Downloading ${taskName} - ${phaseInfo}...`;
    } else {
      return `Downloading Minecraft client - ${phaseInfo}...`;
    }
  }

  /**
   * Verify the completed installation
   */
  async verifyInstallation(clientPath, version) {
    try {
      const versionsDir = path.join(clientPath, 'versions');
      const versionDir = path.join(versionsDir, version);
      const versionJson = path.join(versionDir, `${version}.json`);

      // Check if version directory exists
      if (!fs.existsSync(versionDir)) {
        return { success: false, error: `Version directory not found: ${versionDir}` };
      }

      // Check if version JSON exists
      if (!fs.existsSync(versionJson)) {
        return { success: false, error: `Version JSON not found: ${versionJson}` };
      }

      const profileJson = JSON.parse(fs.readFileSync(versionJson, 'utf8'));
      const loaderMetadata = this.extractLoaderMetadata(profileJson, version);
      const isLoaderProfile = loaderMetadata.loaderType !== 'vanilla' || !!profileJson.inheritsFrom;

      if (isLoaderProfile) {
        const baseVersion = profileJson.inheritsFrom || version;
        const baseVersionDir = path.join(versionsDir, baseVersion);
        const baseVersionJar = path.join(baseVersionDir, `${baseVersion}.jar`);
        
        if (!fs.existsSync(baseVersionJar)) {
          return { success: false, error: `Base Minecraft JAR not found for loader profile: ${baseVersionJar}` };
        }
        
        const jarStats = fs.statSync(baseVersionJar);
        if (jarStats.size < 1024 * 1024) {
          return { success: false, error: `Base Minecraft JAR appears to be incomplete: ${baseVersionJar}` };
        }
        
        if (!profileJson.mainClass) {
          return { success: false, error: 'Loader profile appears to be incomplete: missing mainClass' };
        }
      } else {
        const versionJar = path.join(versionDir, `${version}.jar`);
        
        if (!fs.existsSync(versionJar)) {
          return { success: false, error: `Client JAR not found for version: ${versionJar}` };
        }
        
        const jarStats = fs.statSync(versionJar);
        if (jarStats.size < 1024 * 1024) {
          return { success: false, error: `Client JAR file appears to be incomplete: ${versionJar}` };
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: `Verification failed: ${error.message}` };
    }
  }

  /**
   * Legacy method compatibility - check if client is synchronized
   */
  async checkMinecraftClient(clientPath, version, options = {}) {
    try {
      const { requiredMods = [], serverInfo = null } = options;
      const loaderType = this.normalizeLoaderType(
        serverInfo?.loaderType || serverInfo?.loader || (serverInfo?.fabric ? 'fabric' : 'vanilla')
      );
      const loaderRequired = loaderType !== 'vanilla';
      const requestedLoaderVersion = serverInfo?.loaderVersion || serverInfo?.fabric || null;
      const resolvedLoaderVersion = await this.resolveRequestedLoaderVersion(loaderType, requestedLoaderVersion, version);
      const versionKey = loaderRequired
        ? `${version}|${loaderType}|${resolvedLoaderVersion || requestedLoaderVersion || 'latest'}`
        : version;

      // Check if version has changed since last check
      const versionChangeDetected = await this._checkForVersionChange(clientPath, versionKey);
      if (versionChangeDetected) {
        // Clean up old versions when server version changes
        await this._cleanupOldVersionsOnChange(clientPath, version);
      }

      const loaderDetection = this.scanInstalledLoaderProfiles(clientPath, version, loaderType, resolvedLoaderVersion);
      const versionsDirPath = loaderDetection.versionsDirPath;
      const versionsDirExists = loaderDetection.versionsDirExists;
      const versionsDirEntries = loaderDetection.versionsDirEntries || [];
      const detectedLoaderProfiles = loaderDetection.detectedProfiles || [];
      const installedLoaderProfile = loaderDetection.bestMatch?.profileId || null;
      const installedLoaderType = loaderDetection.bestMatch?.loaderType || null;
      const installedLoaderVersion = loaderDetection.bestMatch?.loaderVersion || null;

      let targetVersion = version;
      if (loaderRequired && installedLoaderProfile) {
        targetVersion = installedLoaderProfile;
      }

      const verification = await this.verifyInstallation(clientPath, targetVersion);
      let synchronized = verification.success;
      let reason = verification.error || 'Client is properly installed';

      if (loaderRequired) {
        const loaderMismatch =
          installedLoaderVersion &&
          resolvedLoaderVersion &&
          !this.areLoaderVersionsEquivalent(loaderType, installedLoaderVersion, resolvedLoaderVersion, version);
        const loaderMissing = !installedLoaderVersion || installedLoaderType !== loaderType;
        if (loaderMissing || loaderMismatch) {
          synchronized = false;
          if (loaderMissing) {
            reason = `${this.getLoaderDisplayName(loaderType)} loader not detected for this client`;
          } else {
            reason = `${this.getLoaderDisplayName(loaderType)} loader mismatch: client has ${installedLoaderVersion}, server requires ${resolvedLoaderVersion}`;
          }
        }
      }

      const result = {
        success: true,
        synchronized,
        reason,
        loaderScanAttempted: loaderRequired,
        loaderType: loaderRequired ? loaderType : 'vanilla',
        loaderVersion: loaderRequired ? resolvedLoaderVersion : null,
        installedLoaderType,
        installedLoaderVersion,
        installedLoaderProfile,
        targetVersion,
        detectedLoaderProfiles,
        versionsDirPath,
        versionsDirExists,
        versionsDirEntries
      };

      if (loaderType === 'fabric') {
        result.fabricScanAttempted = result.loaderScanAttempted;
        result.fabricVersion = result.loaderVersion;
        result.installedFabricVersion = result.installedLoaderVersion;
        result.installedFabricProfile = result.installedLoaderProfile;
        result.fabricProfileName = result.targetVersion;
        result.detectedFabricProfiles = detectedLoaderProfiles
          .filter((profile) => profile.loaderType === 'fabric')
          .map((profile) => profile.profileId);
      }

      return {
        ...result
      };
    } catch (error) {
      return {
        success: false,
        synchronized: false,
        reason: `Check failed: ${error.message}`
      };
    }
  }

  /**
   * Check if the server version has changed since the last client check
   */
  async _checkForVersionChange(clientPath, requiredVersion) {
    try {
      const lastVersionFile = path.join(clientPath, '.last-server-version');
      
      if (!fs.existsSync(lastVersionFile)) {
        // First time check - save the version and no cleanup needed
        fs.writeFileSync(lastVersionFile, requiredVersion, 'utf8');
        return false;
      }
      
      const lastVersion = fs.readFileSync(lastVersionFile, 'utf8').trim();
      
      if (lastVersion !== requiredVersion) {
        // Version changed - update the file
        fs.writeFileSync(lastVersionFile, requiredVersion, 'utf8');
        
        return true;
      }
      
      return false;
    } catch {
      // TODO: Add proper logging - Failed to check version change
      return false;
    }
  }

  /**
   * Clean up old versions when server version changes
   */
  async _cleanupOldVersionsOnChange(clientPath, currentVersion) {
    try {
      const versionsDir = path.join(clientPath, 'versions');
      if (!fs.existsSync(versionsDir)) {
        return { success: true, message: 'No versions directory to clean up' };
      }

      const versionDirs = fs.readdirSync(versionsDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      let cleanedVersions = [];

      for (const versionDir of versionDirs) {
        // Keep only the current version - remove all others
        if (versionDir === currentVersion) {
          continue; // Keep current vanilla version
        }
        
        // For Fabric profiles, keep only those matching the current version
        if (versionDir.startsWith('fabric-loader-') && versionDir.endsWith(`-${currentVersion}`)) {
          continue; // Keep current Fabric profile
        }

        // Remove everything else
        const versionPath = path.join(versionsDir, versionDir);
        try {
          fs.rmSync(versionPath, { recursive: true, force: true });
          cleanedVersions.push(versionDir);
          // TODO: Add proper logging - Cleaned up old version
        } catch {
          // TODO: Add proper logging - Failed to remove version directory
        }
      }

      

      return {
        success: true,
        message: `Cleaned up ${cleanedVersions.length} old versions due to version change`,
        cleanedVersions
      };

    } catch (error) {
      // TODO: Add proper logging - Version change cleanup failed
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Clean up old Minecraft versions after successful download
   */
  async cleanupOldVersions(clientPath, currentVersion, currentLoaderProfile = null) {
    try {
      const versionsDir = path.join(clientPath, 'versions');
      if (!fs.existsSync(versionsDir)) {
        return { success: true, message: 'No versions directory to clean up' };
      }

      const versionDirs = fs.readdirSync(versionsDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      let cleanedVersions = [];
      let protectedVersions = [];

      for (const versionDir of versionDirs) {
        const shouldKeep = this.shouldKeepVersion(versionDir, currentVersion, currentLoaderProfile);
        
        if (shouldKeep.keep) {
          protectedVersions.push(versionDir);
          continue;
        }

        // Remove old version directory
        const versionPath = path.join(versionsDir, versionDir);
        try {
          fs.rmSync(versionPath, { recursive: true, force: true });
          cleanedVersions.push(versionDir);
          // TODO: Add proper logging - Cleaned up old version
        } catch {
          // TODO: Add proper logging - Failed to remove version directory
        }
      }

      this.emitter.emit('client-download-progress', {
        type: 'Cleanup',
        task: `🗑️ Cleaned up ${cleanedVersions.length} old versions`,
        total: 100,
        current: 100
      });

      return {
        success: true,
        message: `Cleaned up ${cleanedVersions.length} old versions`,
        cleanedVersions,
        protectedVersions
      };

    } catch (error) {
      // TODO: Add proper logging - Cleanup failed
      return {
        success: false,
        error: error.message
      };
    }
  }
  /**
   * Determine if a version should be kept or cleaned up
   */
  shouldKeepVersion(versionDir, currentVersion, currentLoaderProfile = null) {
    // Only keep the current vanilla version
    if (versionDir === currentVersion) {
      return { keep: true, reason: 'Current vanilla version' };
    }

    const normalizedLoaderProfile = typeof currentLoaderProfile === 'string'
      ? { profileId: currentLoaderProfile, loaderType: 'fabric', loaderVersion: null }
      : (currentLoaderProfile || null);

    if (normalizedLoaderProfile?.profileId && versionDir === normalizedLoaderProfile.profileId) {
      return { keep: true, reason: 'Current loader profile' };
    }

    if (normalizedLoaderProfile?.loaderType === 'fabric') {
      if (
        versionDir.startsWith('fabric-loader-') &&
        versionDir.endsWith(`-${currentVersion}`)
      ) {
        return { keep: true, reason: 'Current Fabric version' };
      }
      if (versionDir.startsWith(`${currentVersion}-fabric`)) {
        return { keep: true, reason: 'Current Fabric version' };
      }
    }

    if (normalizedLoaderProfile?.loaderType === 'forge') {
      if (versionDir.startsWith(`${currentVersion}-forge-`)) {
        return { keep: true, reason: 'Current Forge version' };
      }
    }

    // Remove everything else - no exceptions
    return { keep: false, reason: 'Old version - cleaning up' };
  }

  // Clear Minecraft client files for re-download (smart repair - only core files)
  async clearMinecraftClient(clientPath, minecraftVersion) {
    try {
      const versionsDir = path.join(clientPath, 'versions');
      let clearedItems = [];
      
      // Remove specific version directory
      if (minecraftVersion) {
        const versionDir = path.join(versionsDir, minecraftVersion);
        if (fs.existsSync(versionDir)) {
          await removePathWithRetries(versionDir, { recursive: true });
          clearedItems.push(`${minecraftVersion} core files`);
        }
        
        // Also remove loader profiles for this version
        if (fs.existsSync(versionsDir)) {
          const allVersions = fs.readdirSync(versionsDir);
          for (const version of allVersions) {
            if (
              (version.includes('fabric-loader-') && version.endsWith(`-${minecraftVersion}`)) ||
              version.startsWith(`${minecraftVersion}-fabric`) ||
              version.startsWith(`${minecraftVersion}-forge-`)
            ) {
              const fabricDir = path.join(versionsDir, version);
              if (fs.existsSync(fabricDir)) {
                await removePathWithRetries(fabricDir, { recursive: true });
                clearedItems.push(`${version} loader profile`);
              }
            }
          }
        }

        const clearedForgeArtifacts = await clearForgeLibraryArtifacts(clientPath, minecraftVersion);
        if (clearedForgeArtifacts.length > 0) {
          clearedItems.push(...clearedForgeArtifacts);
        }
      }
      
      const message = clearedItems.length > 0 ? 
        `Cleared: ${clearedItems.join(', ')}` : 
        'No files needed clearing';
        
      return { success: true, message, clearedItems };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Full clear - removes EVERYTHING including libraries and assets
  async clearMinecraftClientFull(clientPath, minecraftVersion) {
    try {
      let clearedItems = [];
      
      // Clear core client files first
      const coreResult = await this.clearMinecraftClient(clientPath, minecraftVersion);
      if (coreResult.success && coreResult.clearedItems) {
        clearedItems.push(...coreResult.clearedItems);
      }
      
      // Clear libraries directory
      const librariesDir = path.join(clientPath, 'libraries');
      if (fs.existsSync(librariesDir)) {
        await removePathWithRetries(librariesDir, { recursive: true });
        clearedItems.push('all libraries');
      }
      
      // Clear assets directory  
      const assetsResult = await this.clearAssets(clientPath);
      if (assetsResult.success) {
        clearedItems.push('all assets');
      }
      
      const message = clearedItems.length > 0 ? 
        `Full clear completed: ${clearedItems.join(', ')}` : 
        'No files needed clearing';
        
      return { success: true, message, clearedItems, fullClear: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Clear assets directory
  async clearAssets(clientPath) {
    try {
      const assetsDir = path.join(clientPath, 'assets');
      if (fs.existsSync(assetsDir)) {
        await removePathWithRetries(assetsDir, { recursive: true });
      }
      return { success: true, message: 'Cleared assets directory' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = XMCLClientDownloader;
