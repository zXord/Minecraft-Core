'use strict';
// Release gates for .github/workflows/release.yml. Node built-ins only: the stage and publish jobs never
// install project dependencies.
//   node scripts/verify-release-artifacts.cjs <distRoot> <version>
//     the installer, its blockmap and latest.yml are exact regular files, and latest.yml binds the
//     installer's version, name, size and SHA-512 (what electron-updater checks before installing)
//   node scripts/verify-release-artifacts.cjs --app-update <appOutDir>
//     the packaged resources/app-update.yml still points installed apps at this repository's releases
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const INSTALLER_PATTERN = /^Minecraft-Core-Setup-.*\.exe$/iu;
const BLOCKMAP_PATTERN = /^Minecraft-Core-Setup-.*\.exe\.blockmap$/iu;
const YAML_TOP_LEVEL = /^([A-Za-z][A-Za-z0-9]*):(?: (.*))?$/u;
const YAML_MAPPING = /^([A-Za-z][A-Za-z0-9]*): (.*)$/u;
const YAML_LIST_ITEM = /^ {2}- ([A-Za-z][A-Za-z0-9]*): (.*)$/u;
const YAML_LIST_FIELD = /^ {4}([A-Za-z][A-Za-z0-9]*): (.*)$/u;
const LATEST_KEYS = Object.freeze(['version', 'files', 'path', 'sha512', 'releaseDate']);
const LATEST_FILE_KEYS = Object.freeze(['url', 'sha512', 'size']);
const EXPECTED_APP_UPDATE_CONFIG = Object.freeze({
  owner: 'zXord',
  repo: 'Minecraft-Core',
  provider: 'github',
  updaterCacheDirName: 'minecraft-core-updater'
});
const MAX_METADATA_BYTES = 64 * 1024;
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

function invalid(message) {
  const error = new Error(message);
  error.code = 'RELEASE_ARTIFACTS_INVALID';
  return error;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function exactDirectory(directory, label) {
  const absolute = path.resolve(directory);
  let info;
  try {
    info = fs.lstatSync(absolute);
  } catch {
    throw invalid(`${label} is missing.`);
  }
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(fs.realpathSync.native(absolute), absolute)) {
    throw invalid(`${label} is not an exact directory.`);
  }
  return absolute;
}

function exactRegularFile(directory, name) {
  const filePath = path.join(directory, name);
  let info;
  try {
    info = fs.lstatSync(filePath);
  } catch {
    throw invalid(`${name} is missing.`);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1) throw invalid(`${name} is not one exact regular file.`);
  if (!samePath(fs.realpathSync.native(filePath), filePath)) throw invalid(`${name} redirects elsewhere.`);
  if (!fs.readdirSync(directory).includes(name)) throw invalid(`${name} is not spelled exactly.`);
  return { filePath, size: info.size };
}

function digestFile({ filePath, size }) {
  const sha256 = crypto.createHash('sha256');
  const sha512 = crypto.createHash('sha512');
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const descriptor = fs.openSync(filePath, 'r');
  let read = 0;
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      sha256.update(buffer.subarray(0, count));
      sha512.update(buffer.subarray(0, count));
      read += count;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  if (read !== size) throw invalid(`${path.basename(filePath)} changed while it was being verified.`);
  return { size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') };
}

function readMetadataText(file) {
  if (file.size > MAX_METADATA_BYTES) throw invalid(`${path.basename(file.filePath)} is too large.`);
  const bytes = fs.readFileSync(file.filePath);
  if (bytes.length !== file.size) throw invalid(`${path.basename(file.filePath)} changed while it was being verified.`);
  try {
    // ignoreBOM keeps a byte-order mark in the text, so the layout check refuses it instead of hiding it.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw invalid(`${path.basename(file.filePath)} is not UTF-8.`);
  }
}

function yamlScalar(raw, label) {
  if (raw.startsWith("'")) {
    const inner = raw.slice(1, -1);
    if (raw.length < 2 || !raw.endsWith("'") || inner.replaceAll("''", '').includes("'")) throw invalid(`${label} is not a valid quoted value.`);
    return inner.replaceAll("''", "'");
  }
  if (raw.startsWith('"')) {
    const inner = raw.slice(1, -1);
    if (raw.length < 2 || !raw.endsWith('"') || /["\\]/u.test(inner)) throw invalid(`${label} is not a valid quoted value.`);
    return inner;
  }
  if (raw.length === 0 || /^[-?:,[\]{}#&*!|>%@`]|\s$|:\s| #/u.test(raw)) throw invalid(`${label} is not a plain value.`);
  return raw;
}

function yamlLines(text, label) {
  if (text.includes('\r') || text.includes('\t') || !text.endsWith('\n')) throw invalid(`${label} must be LF-terminated YAML without tabs.`);
  return text.slice(0, -1).split('\n');
}

function exactKeys(map, keys, label) {
  const actual = [...map.keys()].sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalid(`${label} must hold exactly ${expected.join(', ')}; found ${actual.join(', ')}.`);
  }
}

// The exact electron-builder layout of latest.yml; anything else is refused rather than interpreted.
function parseLatestYml(text) {
  const top = new Map();
  const files = [];
  let inFiles = false;
  let current = null;
  for (const line of yamlLines(text, 'latest.yml')) {
    let match = YAML_TOP_LEVEL.exec(line);
    if (match) {
      const [, key, raw] = match;
      if (top.has(key)) throw invalid(`latest.yml repeats ${key}.`);
      inFiles = key === 'files';
      current = null;
      if (inFiles !== (raw === undefined)) throw invalid(`latest.yml ${key} has the wrong shape.`);
      top.set(key, inFiles ? files : yamlScalar(raw, `latest.yml ${key}`));
      continue;
    }
    match = inFiles ? YAML_LIST_ITEM.exec(line) : null;
    if (match) {
      current = new Map([[match[1], yamlScalar(match[2], `latest.yml files ${match[1]}`)]]);
      files.push(current);
      continue;
    }
    match = inFiles && current ? YAML_LIST_FIELD.exec(line) : null;
    if (match) {
      if (current.has(match[1])) throw invalid(`latest.yml files repeats ${match[1]}.`);
      current.set(match[1], yamlScalar(match[2], `latest.yml files ${match[1]}`));
      continue;
    }
    throw invalid('latest.yml has a line in an unexpected layout.');
  }
  exactKeys(top, LATEST_KEYS, 'latest.yml');
  if (files.length !== 1) throw invalid('latest.yml must list exactly one file.');
  exactKeys(files[0], LATEST_FILE_KEYS, 'latest.yml files');
  return {
    version: top.get('version'),
    path: top.get('path'),
    sha512: top.get('sha512'),
    releaseDate: top.get('releaseDate'),
    files: [Object.fromEntries(files[0])]
  };
}

function verifyReleaseArtifacts({ distRoot, version }) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) throw invalid('The release version is invalid.');
  const root = exactDirectory(distRoot, 'The release output folder');
  const installerName = `Minecraft-Core-Setup-${version}.exe`;
  const installerFile = exactRegularFile(root, installerName);
  const blockmapFile = exactRegularFile(root, `${installerName}.blockmap`);
  const latestFile = exactRegularFile(root, 'latest.yml');
  const entries = fs.readdirSync(root);
  if (entries.filter(name => INSTALLER_PATTERN.test(name)).length !== 1 || entries.filter(name => BLOCKMAP_PATTERN.test(name)).length !== 1) {
    throw invalid('The release output holds more than one installer or blockmap.');
  }
  const installer = digestFile(installerFile);
  const blockmap = digestFile(blockmapFile);
  const latestYml = digestFile(latestFile);
  const latest = parseLatestYml(readMetadataText(latestFile));
  const entry = latest.files[0];
  if (latest.version !== version || latest.path !== installerName || latest.sha512 !== installer.sha512 ||
      entry.url !== installerName || entry.sha512 !== installer.sha512 || entry.size !== String(installer.size)) {
    throw invalid('latest.yml does not bind the exact installer version, name, size and SHA-512.');
  }
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(latest.releaseDate) || Number.isNaN(Date.parse(latest.releaseDate))) {
    throw invalid('latest.yml has no valid releaseDate.');
  }
  return deepFreeze({
    version,
    installer: { name: installerName, size: installer.size, sha512: installer.sha512, sha256: installer.sha256 },
    blockmap: { name: `${installerName}.blockmap`, size: blockmap.size, sha256: blockmap.sha256 },
    latestYml: { name: 'latest.yml', size: latestYml.size, sha256: latestYml.sha256 }
  });
}

// electron-builder writes resources/app-update.yml only for the NSIS target, so this gate runs after `npm run dist`.
function verifyAppUpdateConfig({ appOutDir }) {
  const resources = exactDirectory(path.join(path.resolve(appOutDir), 'resources'), 'The packaged resources folder');
  const file = exactRegularFile(resources, 'app-update.yml');
  const config = new Map();
  for (const line of yamlLines(readMetadataText(file), 'app-update.yml')) {
    const match = YAML_MAPPING.exec(line);
    if (!match) throw invalid('app-update.yml has a line in an unexpected layout.');
    if (config.has(match[1])) throw invalid(`app-update.yml repeats ${match[1]}.`);
    config.set(match[1], yamlScalar(match[2], `app-update.yml ${match[1]}`));
  }
  exactKeys(config, Object.keys(EXPECTED_APP_UPDATE_CONFIG), 'app-update.yml');
  for (const [key, expected] of Object.entries(EXPECTED_APP_UPDATE_CONFIG)) {
    if (config.get(key) !== expected) {
      throw invalid(`app-update.yml ${key} is not ${expected}; installed apps would stop receiving updates from zXord/Minecraft-Core.`);
    }
  }
  return Object.freeze(Object.fromEntries(config));
}

function runCommand(args) {
  if (args.length === 2 && args[0] === '--app-update') {
    const config = verifyAppUpdateConfig({ appOutDir: args[1] });
    return `Verified resources/app-update.yml: ${config.provider} ${config.owner}/${config.repo}, cache ${config.updaterCacheDirName}`;
  }
  if (args.length === 2 && !args[0].startsWith('-')) {
    const [distRoot, version] = args;
    const packageVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
    if (version !== packageVersion) throw invalid(`Release version ${version} is not the package.json version ${packageVersion}.`);
    const result = verifyReleaseArtifacts({ distRoot, version });
    return `Verified ${result.installer.name} (${result.installer.size} bytes), its blockmap and latest.yml`;
  }
  throw invalid('Usage: node scripts/verify-release-artifacts.cjs <distRoot> <version> | --app-update <appOutDir>');
}

module.exports = {
  EXPECTED_APP_UPDATE_CONFIG,
  parseLatestYml,
  verifyAppUpdateConfig,
  verifyReleaseArtifacts
};

if (require.main === module) {
  try {
    process.stdout.write(`${runCommand(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
