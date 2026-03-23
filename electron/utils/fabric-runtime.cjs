const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const FABRIC_INSTALLER_JAR = 'fabric-installer.jar';
const FABRIC_LAUNCH_JAR = 'fabric-server-launch.jar';
const FABRIC_LAUNCHER_CLASS = 'net/fabricmc/loader/impl/launch/server/FabricServerLauncher.class';

function parseManifest(manifestText) {
  const entries = {};
  let currentKey = null;

  for (const rawLine of manifestText.replace(/\r\n/g, '\n').split('\n')) {
    if (!rawLine) {
      currentKey = null;
      continue;
    }

    if (rawLine.startsWith(' ') && currentKey) {
      entries[currentKey] += rawLine.slice(1);
      continue;
    }

    const separatorIndex = rawLine.indexOf(':');
    if (separatorIndex === -1) {
      currentKey = null;
      continue;
    }

    currentKey = rawLine.slice(0, separatorIndex);
    entries[currentKey] = rawLine.slice(separatorIndex + 1).trimStart();
  }

  return entries;
}

function readJarManifest(zip) {
  const manifestEntry = zip.getEntry('META-INF/MANIFEST.MF');

  if (!manifestEntry) {
    throw new Error('Manifest entry not found');
  }

  return parseManifest(zip.readAsText(manifestEntry));
}

function formatMissingRuntimeMessage(missingRuntimeEntries) {
  const exampleName = path.basename(missingRuntimeEntries[0]);

  if (missingRuntimeEntries.length === 1) {
    return `Fabric runtime is incomplete (missing ${exampleName})`;
  }

  return `Fabric runtime is incomplete (missing ${missingRuntimeEntries.length} required libraries, including ${exampleName})`;
}

function createIssue(code, message, blocksStartup, extra = {}) {
  return {
    code,
    message,
    blocksStartup,
    ...extra
  };
}

function getFabricRuntimeStatus(targetPath) {
  const installerJarPath = path.join(targetPath, FABRIC_INSTALLER_JAR);
  const launchJarPath = path.join(targetPath, FABRIC_LAUNCH_JAR);
  const issues = [];
  let classPathEntries = [];
  let missingRuntimeEntries = [];
  let hasEmbeddedLauncherClass = false;

  if (!fs.existsSync(installerJarPath)) {
    issues.push(
      createIssue('FABRIC_INSTALLER_MISSING', FABRIC_INSTALLER_JAR, false, {
        path: installerJarPath
      })
    );
  }

  if (!fs.existsSync(launchJarPath)) {
    issues.push(
      createIssue('FABRIC_LAUNCH_JAR_MISSING', FABRIC_LAUNCH_JAR, true, {
        path: launchJarPath
      })
    );

    return {
      isHealthy: issues.length === 0,
      hasBlockingIssues: issues.some(issue => issue.blocksStartup),
      issues,
      blockingIssues: issues.filter(issue => issue.blocksStartup),
      classPathEntries,
      missingRuntimeEntries,
      hasEmbeddedLauncherClass
    };
  }

  try {
    const zip = new AdmZip(launchJarPath);
    hasEmbeddedLauncherClass = !!zip.getEntry(FABRIC_LAUNCHER_CLASS);

    const manifest = readJarManifest(zip);
    const manifestClassPath = typeof manifest['Class-Path'] === 'string'
      ? manifest['Class-Path']
      : '';

    classPathEntries = manifestClassPath
      .split(/\s+/)
      .map(entry => entry.trim())
      .filter(Boolean);

    if (!classPathEntries.length && !hasEmbeddedLauncherClass) {
      issues.push(
        createIssue(
          'FABRIC_RUNTIME_METADATA_MISSING',
          'Fabric runtime is incomplete (launcher metadata is missing)',
          true,
          { path: launchJarPath }
        )
      );
    }

    missingRuntimeEntries = classPathEntries
      .map(relativePath => ({
        relativePath,
        absolutePath: path.resolve(targetPath, relativePath)
      }))
      .filter(entry => !fs.existsSync(entry.absolutePath));

    if (missingRuntimeEntries.length > 0) {
      issues.push(
        createIssue(
          'FABRIC_RUNTIME_INCOMPLETE',
          formatMissingRuntimeMessage(missingRuntimeEntries.map(entry => entry.relativePath)),
          true,
          {
            path: launchJarPath,
            missingRuntimeEntries
          }
        )
      );
    }
  } catch (error) {
    issues.push(
      createIssue(
        'FABRIC_RUNTIME_UNREADABLE',
        'Fabric runtime is unreadable and needs repair',
        true,
        {
          path: launchJarPath,
          error: error.message
        }
      )
    );
  }

  return {
    isHealthy: issues.length === 0,
    hasBlockingIssues: issues.some(issue => issue.blocksStartup),
    issues,
    blockingIssues: issues.filter(issue => issue.blocksStartup),
    classPathEntries,
    missingRuntimeEntries,
    hasEmbeddedLauncherClass
  };
}

module.exports = {
  FABRIC_INSTALLER_JAR,
  FABRIC_LAUNCH_JAR,
  getFabricRuntimeStatus
};
