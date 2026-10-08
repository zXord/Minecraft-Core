const childProcess = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REAL_SCRATCH_PREFIX = 'minecraft-core-real-';
const MAX_TREE_ENTRIES = 100_000;

const WINDOWS_REPARSE_SCAN = String.raw`
$ErrorActionPreference = 'Stop'
$inputJson = [Console]::In.ReadToEnd()
$payload = ConvertFrom-Json -InputObject $inputJson
$properties = @($payload.PSObject.Properties)
if ($properties.Count -ne 1 -or $properties[0].Name -cne 'path' -or
    $payload.path -isnot [string] -or -not [System.IO.Path]::IsPathRooted($payload.path)) { exit 65 }
$root = Get-Item -LiteralPath $payload.path -Force
$hasReparse = (($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
if (-not $hasReparse) {
  $found = Get-ChildItem -LiteralPath $payload.path -Force -Recurse -Attributes ReparsePoint |
    Select-Object -First 1
  $hasReparse = ($null -ne $found)
}
if ($hasReparse) { [Console]::Out.Write('1') } else { [Console]::Out.Write('0') }
`;
const WINDOWS_REPARSE_ARGS = Object.freeze([
  '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(WINDOWS_REPARSE_SCAN, 'utf16le').toString('base64')
]);

function normalizePath(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function samePath(left, right) {
  return normalizePath(left) === normalizePath(right);
}

function canonicalTempRoot() {
  const tempRoot = path.resolve(os.tmpdir());
  const info = fs.lstatSync(tempRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(fs.realpathSync.native(tempRoot), tempRoot)) {
    throw new TypeError('The real lifecycle Temp root is redirected');
  }
  return tempRoot;
}

function assertDirectScratchRoot(root) {
  const tempRoot = canonicalTempRoot();
  const resolved = path.resolve(root);
  if (path.dirname(normalizePath(resolved)) !== normalizePath(tempRoot) ||
      !path.basename(resolved).startsWith(REAL_SCRATCH_PREFIX)) {
    throw new TypeError('The real lifecycle cleanup root is outside the scratch area');
  }
  const info = fs.lstatSync(resolved);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(fs.realpathSync.native(resolved), resolved)) {
    throw new TypeError('The real lifecycle cleanup root is redirected');
  }
  return resolved;
}

function defaultPowerShellPath() {
  const systemRoot = typeof process.env.SystemRoot === 'string' && process.env.SystemRoot
    ? process.env.SystemRoot
    : 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function windowsTreeHasReparsePoint(root) {
  const result = childProcess.spawnSync(defaultPowerShellPath(), [...WINDOWS_REPARSE_ARGS], {
    input: JSON.stringify({ path: root }),
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 10_000,
    maxBuffer: 1024
  });
  if (result.error || result.signal || result.status !== 0 ||
      Buffer.byteLength(String(result.stderr || ''), 'utf8') > 8 * 1024) return true;
  return String(result.stdout || '') !== '0';
}

async function portableTreeHasReparsePoint(root) {
  const pending = [root];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop();
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_TREE_ENTRIES || entry.isSymbolicLink()) return true;
      const entryPath = path.join(directory, entry.name);
      const info = await fsp.lstat(entryPath);
      if (info.isSymbolicLink() || !samePath(await fsp.realpath(entryPath), entryPath)) return true;
      if (info.isDirectory()) pending.push(entryPath);
    }
  }
  return false;
}

async function assertNoNestedRedirects(root) {
  const resolved = assertDirectScratchRoot(root);
  const redirected = process.platform === 'win32'
    ? windowsTreeHasReparsePoint(resolved)
    : await portableTreeHasReparsePoint(resolved);
  if (redirected) throw new TypeError('The real lifecycle cleanup root contains a redirected entry');
  return assertDirectScratchRoot(resolved);
}

module.exports = {
  assertNoNestedRedirects
};
