// Proper Minecraft launcher using @xmcl packages to fix LogUtils and other issues
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { LibraryInfo, MinecraftFolder, Version } = require('@xmcl/core');
const { installVersion, installAssets, installLibraries, installDependencies } = require('@xmcl/installer');
const { installClientLoader, normalizeLoader, getLoaderVersions } = require('../loader-install-service.cjs');

async function fetchMinecraftVersionMetadata(versionId) {
  const response = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  if (!response.ok) {
    throw new Error(`Failed to fetch Minecraft version manifest: ${response.status}`);
  }

  const manifest = await response.json();
  const versionInfo = Array.isArray(manifest?.versions)
    ? manifest.versions.find((entry) => entry.id === versionId)
    : null;

  if (!versionInfo?.url) {
    throw new Error(`Minecraft version metadata not found for ${versionId}`);
  }

  return versionInfo;
}

function mergeVersionArguments(parentArgs, childArgs) {
  const merged = [];
  const append = (value) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      merged.push(entry);
    }
  };
  append(parentArgs);
  append(childArgs);
  return merged;
}

function mergeVersionJson(parentJson, childJson) {
  const parentLibraries = Array.isArray(parentJson?.libraries) ? parentJson.libraries : [];
  const childLibraries = Array.isArray(childJson?.libraries) ? childJson.libraries : [];
  const childLibraryNames = new Set(childLibraries.map((library) => library?.name).filter(Boolean));
  const mergedLibraries = [
    ...parentLibraries.filter((library) => !library?.name || !childLibraryNames.has(library.name)),
    ...childLibraries
  ];

  return {
    ...parentJson,
    ...childJson,
    arguments: {
      jvm: mergeVersionArguments(parentJson?.arguments?.jvm, childJson?.arguments?.jvm),
      game: mergeVersionArguments(parentJson?.arguments?.game, childJson?.arguments?.game)
    },
    downloads: {
      ...(parentJson?.downloads || {}),
      ...(childJson?.downloads || {})
    },
    libraries: mergedLibraries,
    mainClass: childJson?.mainClass || parentJson?.mainClass,
    assetIndex: childJson?.assetIndex || parentJson?.assetIndex,
    javaVersion: childJson?.javaVersion || parentJson?.javaVersion,
    type: childJson?.type || parentJson?.type,
    inheritsFrom: childJson?.inheritsFrom || parentJson?.inheritsFrom,
    jar: childJson?.jar || parentJson?.jar
  };
}

function loadResolvedVersionJson(clientPath, versionId, visited = new Set()) {
  if (!versionId || visited.has(versionId)) {
    return null;
  }

  visited.add(versionId);
  const versionJsonPath = path.join(clientPath, 'versions', versionId, `${versionId}.json`);
  if (!fs.existsSync(versionJsonPath)) {
    return null;
  }

  const versionJson = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
  if (!versionJson?.inheritsFrom) {
    return versionJson;
  }

  const parentJson = loadResolvedVersionJson(clientPath, versionJson.inheritsFrom, visited);
  if (!parentJson) {
    return versionJson;
  }

  return mergeVersionJson(parentJson, versionJson);
}

function resolveExistingLoaderProfile(clientPath, minecraftVersion, loaderType, loaderVersion) {
  const versionsDir = path.join(clientPath, 'versions');
  if (!fs.existsSync(versionsDir)) {
    return null;
  }

  const versionDirs = fs.readdirSync(versionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const normalizedLoader = normalizeLoader(loaderType);
  if (normalizedLoader === 'vanilla') {
    return versionDirs.includes(minecraftVersion) ? minecraftVersion : null;
  }

  if (normalizedLoader === 'forge') {
    const exactCandidates = [
      loaderVersion ? `${minecraftVersion}-forge-${loaderVersion}` : null,
      loaderVersion ? `forge-${minecraftVersion}-${loaderVersion}` : null
    ].filter(Boolean);
    for (const candidate of exactCandidates) {
      if (versionDirs.includes(candidate)) {
        return candidate;
      }
    }

    const prefix = `${minecraftVersion}-forge-`;
    const matches = versionDirs.filter((name) => name.startsWith(prefix));
    if (matches.length === 0) {
      return null;
    }

    if (loaderVersion) {
      const exactMatch = matches.find((name) => name === `${minecraftVersion}-forge-${loaderVersion}`);
      if (exactMatch) {
        return exactMatch;
      }
      const suffixMatch = matches.find((name) => name.includes(`-${loaderVersion}`));
      if (suffixMatch) {
        return suffixMatch;
      }
    }

    return matches.sort().reverse()[0] || null;
  }

  if (normalizedLoader === 'fabric') {
    const exactCandidates = [
      loaderVersion ? `fabric-loader-${loaderVersion}-${minecraftVersion}` : null,
      loaderVersion ? `${minecraftVersion}-fabric-${loaderVersion}` : null
    ].filter(Boolean);
    for (const candidate of exactCandidates) {
      if (versionDirs.includes(candidate)) {
        return candidate;
      }
    }

    const matches = versionDirs.filter((name) =>
      name.startsWith('fabric-loader-') && name.endsWith(`-${minecraftVersion}`)
    );
    if (matches.length === 0) {
      return null;
    }

    if (loaderVersion) {
      const exactMatch = matches.find((name) => name === `fabric-loader-${loaderVersion}-${minecraftVersion}`);
      if (exactMatch) {
        return exactMatch;
      }
      const middleMatch = matches.find((name) => name.includes(`-${loaderVersion}-`));
      if (middleMatch) {
        return middleMatch;
      }
    }

    return matches.sort().reverse()[0] || null;
  }

  return null;
}

function resolveLibraryArtifactPath(library) {
  if (!library || typeof library !== 'object') {
    return null;
  }

  if (typeof library.downloads?.artifact?.path === 'string' && library.downloads.artifact.path.trim()) {
    return library.downloads.artifact.path;
  }

  if (typeof library.name === 'string' && library.name.trim()) {
    try {
      return LibraryInfo.resolve(library.name).path;
    } catch {
      return null;
    }
  }

  return null;
}

function replaceLaunchPlaceholders(value, replacements) {
  let result = value;
  for (const [token, replacement] of Object.entries(replacements)) {
    result = result.replace(new RegExp(`\\$\\{${token}\\}`, 'g'), () => String(replacement));
  }
  return result;
}

function normalizeOsName() {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'osx';
    case 'linux':
      return 'linux';
    default:
      return process.platform;
  }
}

function isRuleMatch(rule = {}, featureState = {}) {
  if (!rule || typeof rule !== 'object') {
    return true;
  }

  if (rule.os && typeof rule.os === 'object') {
    if (rule.os.name && String(rule.os.name).toLowerCase() !== normalizeOsName()) {
      return false;
    }

    if (rule.os.arch) {
      const expectedArch = String(rule.os.arch).toLowerCase();
      const currentArch = process.arch === 'x64' ? 'x86_64' : process.arch.toLowerCase();
      if (expectedArch !== currentArch && expectedArch !== process.arch.toLowerCase()) {
        return false;
      }
    }
  }

  if (rule.features && typeof rule.features === 'object') {
    for (const [featureName, expectedValue] of Object.entries(rule.features)) {
      if (Boolean(featureState[featureName]) !== Boolean(expectedValue)) {
        return false;
      }
    }
  }

  return true;
}

function shouldIncludeArgument(entry, featureState = {}) {
  if (!entry || typeof entry !== 'object' || !Array.isArray(entry.rules) || entry.rules.length === 0) {
    return true;
  }

  let allowed = false;
  for (const rule of entry.rules) {
    const action = rule && typeof rule.action === 'string' ? rule.action.toLowerCase() : 'allow';
    if (isRuleMatch(rule, featureState)) {
      allowed = action === 'allow';
    }
  }

  return allowed;
}

function expandVersionArguments(entries, replacements, featureState = {}) {
  const expanded = [];
  if (!Array.isArray(entries)) {
    return expanded;
  }

  const appendValue = (value) => {
    if (typeof value === 'string' && value.length > 0) {
      expanded.push(replaceLaunchPlaceholders(value, replacements));
    }
  };

  for (const entry of entries) {
    if (typeof entry === 'string') {
      appendValue(entry);
      continue;
    }

    if (!entry || typeof entry !== 'object' || !shouldIncludeArgument(entry, featureState)) {
      continue;
    }

    if (Array.isArray(entry.value)) {
      for (const value of entry.value) {
        appendValue(value);
      }
      continue;
    }

    appendValue(entry.value);
  }

  return expanded;
}

function buildLaunchReplacements({
  authData,
  clientPath,
  launchJson,
  launchVersion,
  minecraftVersion,
  nativesDir,
  classpathSeparator,
  classpathValue
}) {
  return {
    auth_playerName: authData?.name || '',
    auth_player_name: authData?.name || '',
    auth_uuid: authData?.uuid || '',
    auth_xuid: authData?.xuid || '',
    auth_accessToken: authData?.access_token || '',
    auth_access_token: authData?.access_token || '',
    auth_session: authData?.access_token || '',
    auth_userType: 'msa',
    auth_user_type: 'msa',
    clientid: authData?.client_token || authData?.clientToken || '',
    user_properties: '{}',
    version_name: launchVersion,
    game_directory: clientPath,
    assets_root: path.join(clientPath, 'assets'),
    assets_index_name: launchJson?.assetIndex?.id || minecraftVersion,
    version_type: launchJson?.type || 'release',
    launcher_name: 'minecraft-core',
    launcher_version: '1.0.0',
    natives_directory: nativesDir,
    library_directory: path.join(clientPath, 'libraries'),
    classpath_separator: classpathSeparator,
    classpath: classpathValue,
    quickPlayPath: '',
    quickPlaySingleplayer: '',
    quickPlayMultiplayer: '',
    quickPlayRealms: '',
    resolution_width: '',
    resolution_height: ''
  };
}

function appendProcessOutput(buffer, chunk, limit = 16000) {
  const next = `${buffer}${chunk}`;
  if (next.length <= limit) {
    return next;
  }
  return next.slice(next.length - limit);
}

function readTextFileIfExists(filePath) {
  if (!filePath) {
    return '';
  }

  try {
    if (!fs.existsSync(filePath)) {
      return '';
    }

    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function findNewestMatchingFile(directoryPath, matcher) {
  try {
    if (!directoryPath || !fs.existsSync(directoryPath)) {
      return null;
    }

    const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && matcher(entry.name))
      .map((entry) => {
        const filePath = path.join(directoryPath, entry.name);
        const stats = fs.statSync(filePath);
        return {
          filePath,
          mtimeMs: stats.mtimeMs || 0
        };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);

    return entries[0]?.filePath || null;
  } catch {
    return null;
  }
}

function extractTailLines(text, lineCount = 12) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lineCount);
}

function parseForgeDependencyDiagnostics(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const matches = Array.from(text.matchAll(
    /Mod ID:\s*'([^']+)'.*?Requested by:\s*'([^']+)'.*?Expected range:\s*'([^']+)'.*?Actual version:\s*'([^']+)'/gsi
  ));

  if (matches.length === 0) {
    return null;
  }

  const details = matches.map((match) => ({
    dependencyId: match[1],
    requestedBy: match[2],
    expectedRange: match[3],
    actualVersion: match[4],
    message: `${match[2]} requires ${match[1]} ${match[3]}, found ${match[4]}`
  }));

  const first = details[0];
  return {
    kind: 'forge_dependency_error',
    summary: `${first.requestedBy} requires ${first.dependencyId} ${first.expectedRange}, but ${first.actualVersion} is installed`,
    details,
    source: 'latest.log'
  };
}

function parseForgeLaunchDiagnostics(sources) {
  const orderedSources = [
    { name: 'latest.log', text: sources.latestLog || '' },
    { name: 'debug.log', text: sources.debugLog || '' },
    { name: 'crash-report', text: sources.crashReport || '' },
    { name: 'fml-report', text: sources.fmlReport || '' },
    { name: 'hs_err', text: sources.hsErr || '' }
  ];

  for (const source of orderedSources) {
    const dependencyDiagnostics = parseForgeDependencyDiagnostics(source.text);
    if (dependencyDiagnostics) {
      return {
        ...dependencyDiagnostics,
        source: source.name
      };
    }
  }

  for (const source of orderedSources) {
    const tailLines = extractTailLines(source.text);
    if (tailLines.length > 0) {
      return {
        kind: 'log_excerpt',
        summary: tailLines[tailLines.length - 1],
        details: tailLines.map((line) => ({ message: line })),
        source: source.name
      };
    }
  }

  return null;
}

function collectLaunchDiagnostics(clientPath) {
  const logsDir = path.join(clientPath, 'logs');
  const crashReportsDir = path.join(clientPath, 'crash-reports');
  const latestLogPath = path.join(logsDir, 'latest.log');
  const debugLogPath = path.join(logsDir, 'debug.log');
  const crashReportPath = findNewestMatchingFile(crashReportsDir, (name) => /\.txt$/i.test(name));
  const fmlReportPath = findNewestMatchingFile(clientPath, (name) => /^fml.*\.txt$/i.test(name));
  const hsErrPath = findNewestMatchingFile(clientPath, (name) => /^hs_err.*\.(?:log|txt)$/i.test(name));

  const parsed = parseForgeLaunchDiagnostics({
    latestLog: readTextFileIfExists(latestLogPath),
    debugLog: readTextFileIfExists(debugLogPath),
    crashReport: readTextFileIfExists(crashReportPath),
    fmlReport: readTextFileIfExists(fmlReportPath),
    hsErr: readTextFileIfExists(hsErrPath)
  });

  if (!parsed) {
    return null;
  }

  return {
    ...parsed,
    latestLogPath: fs.existsSync(latestLogPath) ? latestLogPath : null,
    debugLogPath: fs.existsSync(debugLogPath) ? debugLogPath : null,
    crashReportPath,
    fmlReportPath,
    hsErrPath
  };
}

class ProperMinecraftLauncher extends EventEmitter {
  constructor() {
    super();
    this.isLaunching = false;
    this.client = null;
    this.authData = null;
    this.clientPath = null;
  }

  setAuthData(authData) {
    this.authData = authData;
  }

  async ensureMinecraftClient(clientPath, version) {
    this.clientPath = clientPath;

    const versionsDir = path.join(clientPath, 'versions');
    const librariesDir = path.join(clientPath, 'libraries');
    const assetsDir = path.join(clientPath, 'assets');

    for (const dir of [versionsDir, librariesDir, assetsDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    const versionManifestEntry = await fetchMinecraftVersionMetadata(version);
    await installVersion(versionManifestEntry, clientPath, {
      side: 'client'
    });

    const versionJsonPath = path.join(versionsDir, version, `${version}.json`);
    if (!fs.existsSync(versionJsonPath)) {
      throw new Error(`Version JSON not found after installation: ${versionJsonPath}`);
    }

    const installableVersion = await Version.parse(MinecraftFolder.from(clientPath), version);
    installableVersion.minecraftDirectory = clientPath;
    const installOptions = {
      minecraftDirectory: clientPath
    };

    await installLibraries(installableVersion, installOptions);
    await installAssets(installableVersion, installOptions);
    await installDependencies(installableVersion, installOptions);

    return { success: true };
  }

  async launchMinecraft(options) {
    try {
      const {
        clientPath,
        minecraftVersion,
        serverIp,
        serverPort,
        maxMemory = 4096,
        loaderType = 'vanilla',
        loaderVersion = null,
        javaPath = null,
        showDebugTerminal = false
      } = options;

      if (this.isLaunching) {
        throw new Error('Minecraft is already launching');
      }

      if (!this.authData) {
        throw new Error('No authentication data available');
      }

      this.isLaunching = true;
      await this.ensureMinecraftClient(clientPath, minecraftVersion);

      const normalizedLoader = normalizeLoader(loaderType);
      let effectiveLoaderVersion = loaderVersion;
      if (
        normalizedLoader !== 'vanilla' &&
        (!effectiveLoaderVersion || String(effectiveLoaderVersion).trim().toLowerCase() === 'latest')
      ) {
        const availableVersions = await getLoaderVersions(normalizedLoader, minecraftVersion);
        effectiveLoaderVersion = availableVersions[0] || effectiveLoaderVersion;
      }

      let launchVersion = minecraftVersion;
      if (normalizedLoader !== 'vanilla') {
        const existingProfileId = resolveExistingLoaderProfile(
          clientPath,
          minecraftVersion,
          normalizedLoader,
          effectiveLoaderVersion
        );

        if (existingProfileId) {
          launchVersion = existingProfileId;
        } else {
          const loaderResult = await installClientLoader({
            clientPath,
            minecraftVersion,
            loader: normalizedLoader,
            loaderVersion: effectiveLoaderVersion,
            javaPath
          });

          launchVersion = loaderResult.profileId ||
            resolveExistingLoaderProfile(clientPath, minecraftVersion, normalizedLoader, effectiveLoaderVersion) ||
            minecraftVersion;
        }
      }

      const launchJson = loadResolvedVersionJson(clientPath, launchVersion);
      if (!launchJson) {
        throw new Error(`Launch profile not found: ${launchVersion}`);
      }

      const classpathEntries = [];
      const classpathSet = new Set();
      const addClasspathEntry = (entryPath) => {
        if (!entryPath || !fs.existsSync(entryPath) || classpathSet.has(entryPath)) {
          return;
        }
        classpathSet.add(entryPath);
        classpathEntries.push(entryPath);
      };

      const primaryVersionId = launchJson.jar || launchJson.inheritsFrom || minecraftVersion;
      const launchVersionJar = path.join(clientPath, 'versions', launchVersion, `${launchVersion}.jar`);
      const primaryVersionJar = path.join(clientPath, 'versions', primaryVersionId, `${primaryVersionId}.jar`);
      addClasspathEntry(launchVersionJar);
      addClasspathEntry(primaryVersionJar);

      const launchLibraries = Array.isArray(launchJson.libraries) ? launchJson.libraries : [];
      for (const library of launchLibraries) {
        const artifactPath = resolveLibraryArtifactPath(library);
        if (!artifactPath) {
          continue;
        }
        addClasspathEntry(path.join(clientPath, 'libraries', artifactPath));
      }

      if (classpathEntries.length === 0) {
        throw new Error(`No launch classpath entries were resolved for ${launchVersion}`);
      }

      const nativesDir = path.join(clientPath, 'versions', launchVersion, 'natives');
      if (!fs.existsSync(nativesDir)) {
        fs.mkdirSync(nativesDir, { recursive: true });
      }

      const classpathSeparator = process.platform === 'win32' ? ';' : ':';
      const classpathValue = classpathEntries.join(classpathSeparator);
      const featureState = {
        is_demo_user: false,
        has_custom_resolution: false,
        has_quick_plays_support: false,
        is_quick_play_singleplayer: false,
        is_quick_play_multiplayer: false,
        is_quick_play_realms: false
      };
      const replacements = buildLaunchReplacements({
        authData: this.authData,
        clientPath,
        launchJson,
        launchVersion,
        minecraftVersion,
        nativesDir,
        classpathSeparator,
        classpathValue
      });

      const versionJvmArgs = expandVersionArguments(launchJson.arguments?.jvm, replacements, featureState);
      const versionProvidesClasspath = versionJvmArgs.some((arg, index) =>
        (arg === '-cp' || arg === '-classpath') && typeof versionJvmArgs[index + 1] === 'string'
      );

      const jvmArgs = [
        `-Xmx${maxMemory}M`,
        '-Xms1024M',
        '-XX:+UseG1GC',
        '-XX:+ParallelRefProcEnabled',
        '-XX:MaxGCPauseMillis=200',
        '-XX:+UnlockExperimentalVMOptions',
        '-XX:+DisableExplicitGC',
        '-XX:+AlwaysPreTouch',
        '-XX:G1NewSizePercent=30',
        '-XX:G1MaxNewSizePercent=40',
        '-XX:G1HeapRegionSize=8M',
        '-XX:G1ReservePercent=20',
        '-XX:G1HeapWastePercent=5',
        '-XX:G1MixedGCCountTarget=4',
        '-XX:InitiatingHeapOccupancyPercent=15',
        '-XX:G1MixedGCLiveThresholdPercent=90',
        '-XX:G1RSetUpdatingPauseTimePercent=5',
        '-XX:SurvivorRatio=32',
        '-XX:+PerfDisableSharedMem',
        '-XX:MaxTenuringThreshold=1',
        `-Djava.library.path=${nativesDir}`
      ];

      if (!versionProvidesClasspath) {
        jvmArgs.push('-cp', classpathValue);
      }

      jvmArgs.push(...versionJvmArgs);

      const gameArgs = expandVersionArguments(launchJson.arguments?.game, replacements, featureState);

      if (gameArgs.length === 0 && typeof launchJson.minecraftArguments === 'string') {
        for (const arg of launchJson.minecraftArguments.split(/\s+/).filter(Boolean)) {
          gameArgs.push(replaceLaunchPlaceholders(arg, replacements));
        }
      }

      if (!gameArgs.includes('--username')) {
        gameArgs.push(
          '--username', this.authData.name || '',
          '--version', launchVersion,
          '--gameDir', clientPath,
          '--assetsDir', path.join(clientPath, 'assets'),
          '--assetIndex', launchJson.assetIndex?.id || minecraftVersion,
          '--uuid', this.authData.uuid || '',
          '--accessToken', this.authData.access_token || '',
          '--userType', 'msa',
          '--versionType', launchJson.type || 'release',
          '--userProperties', '{}'
        );
      }

      if (serverIp && serverPort) {
        gameArgs.push('--server', serverIp, '--port', String(serverPort));
      }

      const javaCommand = javaPath || (process.platform === 'win32' ? 'javaw' : 'java');
      let debugJavaPath = javaCommand;
      const allArgs = [
        ...jvmArgs,
        launchJson.mainClass || 'net.minecraft.client.main.Main',
        ...gameArgs
      ];

      const spawnOptions = {
        cwd: clientPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      };

      let debugWindow = null;
      if (showDebugTerminal) {
        if (process.platform === 'win32') {
          debugJavaPath = javaCommand.replace(/javaw\.exe$/i, 'java.exe');
          spawnOptions.windowsHide = true;
        }

        try {
          const { BrowserWindow } = require('electron');
          debugWindow = new BrowserWindow({
            width: 800,
            height: 500,
            title: `Minecraft Debug Console - ${launchVersion}`,
            backgroundColor: '#1a1a1a',
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              preload: path.join(__dirname, '../../preload.cjs'),
              sandbox: true
            },
            icon: path.join(__dirname, '../../icon.png'),
            show: false,
            resizable: true,
            minimizable: true,
            maximizable: true
          });

          debugWindow.loadFile(path.join(__dirname, '../../debug-console.html'));
          debugWindow.once('ready-to-show', () => {
            debugWindow.show();
            if (debugWindow && !debugWindow.isDestroyed()) {
              debugWindow.webContents.send('debug-log', {
                type: 'header',
                message: `========================================
MINECRAFT DEBUG CONSOLE
========================================

Java Executable: ${debugJavaPath}
Working Directory: ${clientPath}
Launch Version: ${launchVersion}

========================================
Starting Minecraft with console output...
========================================
`
              });
            }
          });
        } catch {
          debugWindow = null;
        }
      }

      const child = spawn(showDebugTerminal ? debugJavaPath : javaCommand, allArgs, spawnOptions);
      this.client = { child };
      if (!showDebugTerminal) {
        child.unref();
      } else if (debugWindow) {
        this.debugWindow = debugWindow;
        debugWindow.on('closed', () => {
          this.debugWindow = null;
        });
      }

      let launchStdout = '';
      let launchStderr = '';
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        launchStdout = appendProcessOutput(launchStdout, text);
        if (debugWindow && !debugWindow.isDestroyed()) {
          debugWindow.webContents.send('debug-log', {
            type: 'info',
            message: text
          });
        }
      });
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        launchStderr = appendProcessOutput(launchStderr, text);
        if (debugWindow && !debugWindow.isDestroyed()) {
          debugWindow.webContents.send('debug-log', {
            type: 'error',
            message: text
          });
        }
      });

      child.on('close', () => {
        this.isLaunching = false;
        this.client = null;
        if (debugWindow && !debugWindow.isDestroyed()) {
          debugWindow.webContents.send('debug-log', {
            type: child.exitCode === 0 ? 'success' : 'error',
            message: `\n========================================\nMinecraft process ended with code: ${child.exitCode}\n========================================\n`
          });
        }
        this.emit('minecraft-stopped');
      });

      child.on('error', () => {
        this.isLaunching = false;
        this.client = null;
        this.emit('minecraft-stopped');
      });

      await new Promise((resolve) => setTimeout(resolve, 3000));

      if (child.killed || child.exitCode !== null) {
        const combinedOutput = `${launchStdout}\n${launchStderr}`.trim();
        const outputSuffix = combinedOutput
          ? `\n${combinedOutput.slice(-4000)}`
          : '';
        const diagnostics = collectLaunchDiagnostics(clientPath);

        return {
          success: false,
          error: `Minecraft failed to start. Exit code: ${child.exitCode}${outputSuffix}`,
          message: `Failed to launch Minecraft: process exited early with code ${child.exitCode}`,
          diagnostics
        };
      }

      return {
        success: true,
        message: `Minecraft ${launchVersion} launched successfully with XMCL`,
        pid: child.pid,
        version: launchVersion,
        vanillaVersion: minecraftVersion,
        loaderType: normalizedLoader,
        loaderVersion: effectiveLoaderVersion
      };
    } catch (error) {
      this.isLaunching = false;
      this.client = null;
      const diagnostics = this.clientPath ? collectLaunchDiagnostics(this.clientPath) : null;

      return {
        success: false,
        error: error.message,
        message: `Failed to launch Minecraft: ${error.message}`,
        diagnostics
      };
    }
  }

  async stopMinecraft() {
    if (this.client?.child) {
      this.client.child.kill('SIGTERM');
      setTimeout(() => {
        if (this.client?.child && !this.client.child.killed) {
          this.client.child.kill('SIGKILL');
        }
      }, 3000);
    }

    this.isLaunching = false;
    this.client = null;
    this.emit('minecraft-stopped');

    return { success: true, message: 'Minecraft stopped' };
  }

  getStatus() {
    let isRunning = false;
    if (this.client?.child) {
      try {
        process.kill(this.client.child.pid, 0);
        isRunning = true;
      } catch {
        this.client = null;
        isRunning = false;
      }
    }

    return {
      isAuthenticated: !!this.authData,
      isLaunching: this.isLaunching,
      isRunning,
      username: this.authData?.name || null,
      clientPath: this.clientPath
    };
  }
}

module.exports = {
  ProperMinecraftLauncher,
  buildLaunchReplacements,
  collectLaunchDiagnostics,
  expandVersionArguments,
  parseForgeLaunchDiagnostics,
  replaceLaunchPlaceholders
};
