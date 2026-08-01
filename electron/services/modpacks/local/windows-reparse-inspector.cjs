const { spawn } = require('node:child_process');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const MAX_INPUT_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 256;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_TIMEOUT_MS = 5_000;
const KILL_WAIT_MS = 1_000;

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$maximumInputBytes = 131072
$inputStream = [Console]::OpenStandardInput()
$memory = New-Object System.IO.MemoryStream
$buffer = New-Object byte[] 4096
$total = 0
try {
  while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
    $total += $read
    if ($total -gt $maximumInputBytes) { exit 64 }
    $memory.Write($buffer, 0, $read)
  }
  $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
  $json = $utf8.GetString($memory.ToArray())
  $payload = ConvertFrom-Json -InputObject $json
  $properties = @($payload.PSObject.Properties)
  if ($properties.Count -ne 1 -or $properties[0].Name -cne 'path' -or $payload.path -isnot [string] -or
      $payload.path.Length -lt 1 -or $payload.path.Length -gt 32767 -or -not [System.IO.Path]::IsPathRooted($payload.path)) { exit 65 }
  $attributes = [System.IO.File]::GetAttributes($payload.path)
  if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    $response = '{"version":1,"isReparsePoint":true}'
  } else {
    $response = '{"version":1,"isReparsePoint":false}'
  }
  $responseBytes = $utf8.GetBytes($response)
  $outputStream = [Console]::OpenStandardOutput()
  $outputStream.Write($responseBytes, 0, $responseBytes.Length)
  $outputStream.Flush()
} catch {
  exit 66
} finally {
  $memory.Dispose()
}
`;

const ENCODED_SCRIPT = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64');
const POWERSHELL_ARGS = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  ENCODED_SCRIPT
]);

function inspectionError() {
  const error = new Error('Windows reparse-point inspection failed');
  error.code = 'REPARSE_INSPECTION_FAILED';
  return error;
}

function abortError() {
  const error = new Error('Windows reparse-point inspection was cancelled');
  error.code = 'ABORT_ERR';
  return error;
}

function defaultPowerShellPath() {
  const systemRoot = typeof process.env.SystemRoot === 'string' && process.env.SystemRoot ? process.env.SystemRoot : 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function validPowerShellPath(value) {
  return typeof value === 'string' && path.win32.isAbsolute(value) &&
    /\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i.test(path.win32.normalize(value));
}

function isFullyQualifiedWindowsPath(value) {
  if (typeof value !== 'string') return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (/^\\\\\?\\[A-Za-z]:\\/.test(value)) return true;
  if (/^\\\\\?\\UNC\\[^\\]+\\[^\\]+(?:\\|$)/i.test(value)) return true;
  return /^\\\\(?![?.]\\)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function readSignal(options) {
  if (options === undefined) return undefined;
  if (!isPlainObject(options) || Object.keys(options).some(key => key !== 'signal')) throw inspectionError();
  const { signal } = options;
  if (signal === undefined) return undefined;
  if (!signal || typeof signal !== 'object' || typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') throw inspectionError();
  return signal;
}

function runBoundedPowerShell({ executable, spawnProcess, input, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(executable, [...POWERSHELL_ARGS], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      reject(inspectionError());
      return;
    }

    if (!child || typeof child.once !== 'function' || typeof child.kill !== 'function' ||
      !child.stdin || typeof child.stdin.end !== 'function' || !child.stdout || typeof child.stdout.on !== 'function' ||
      !child.stderr || typeof child.stderr.on !== 'function') {
      try { child?.kill?.(); } catch { /* fail closed below */ }
      reject(inspectionError());
      return;
    }

    let settled = false;
    let terminalError = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    let abortListener;
    let killWaitTimer;
    const timeoutTimer = setTimeout(() => fail(inspectionError()), timeoutMs);

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killWaitTimer) clearTimeout(killWaitTimer);
      if (abortListener) {
        try { signal.removeEventListener('abort', abortListener); } catch { /* error stays redacted */ }
      }
    };

    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };

    function fail(error) {
      if (settled) return;
      terminalError ??= error;
      try { child.kill(); } catch { /* bounded close wait still applies */ }
      if (!killWaitTimer) killWaitTimer = setTimeout(() => settle(terminalError), KILL_WAIT_MS);
    }

    child.stdout.on('data', chunk => {
      if (settled || terminalError) return;
      if (!Buffer.isBuffer(chunk)) {
        fail(inspectionError());
        return;
      }
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        fail(inspectionError());
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (settled || terminalError) return;
      if (!Buffer.isBuffer(chunk)) {
        fail(inspectionError());
        return;
      }
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) fail(inspectionError());
    });
    child.stdin.on?.('error', () => fail(inspectionError()));
    child.once('error', () => fail(inspectionError()));
    child.once('close', (code, closeSignal) => {
      if (terminalError) {
        settle(terminalError);
        return;
      }
      if (code !== 0 || closeSignal !== null) {
        settle(inspectionError());
        return;
      }
      settle(null, Buffer.concat(stdout));
    });

    if (signal) {
      abortListener = () => fail(abortError());
      try { signal.addEventListener('abort', abortListener, { once: true }); }
      catch { fail(inspectionError()); }
      if (signal.aborted) abortListener();
    }
    if (!terminalError) {
      try { child.stdin.end(input); }
      catch { fail(inspectionError()); }
    }
  });
}

class WindowsReparseInspector {
  constructor({
    platform = process.platform,
    powershellPath = defaultPowerShellPath(),
    spawnProcess = spawn,
    timeoutMs = MAX_TIMEOUT_MS
  } = {}) {
    if (typeof platform !== 'string' || typeof spawnProcess !== 'function' || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS || (platform === 'win32' && !validPowerShellPath(powershellPath))) {
      throw new TypeError('Windows reparse inspector dependencies are invalid');
    }
    this.platform = platform;
    this.powershellPath = powershellPath;
    this.spawnProcess = spawnProcess;
    this.timeoutMs = timeoutMs;
  }

  async isReparsePoint(filePath, options) {
    const signal = readSignal(options);
    if (signal?.aborted) throw abortError();
    if (this.platform !== 'win32' || !isFullyQualifiedWindowsPath(filePath) ||
      filePath.length < 1 || filePath.length > 32767 || filePath.includes('\0')) throw inspectionError();
    const input = Buffer.from(JSON.stringify({ path: filePath }), 'utf8');
    if (input.length > MAX_INPUT_BYTES) throw inspectionError();
    const output = await runBoundedPowerShell({
      executable: this.powershellPath,
      spawnProcess: this.spawnProcess,
      input,
      signal,
      timeoutMs: this.timeoutMs
    });
    let decoded;
    let response;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(output);
      response = JSON.parse(decoded);
    } catch {
      throw inspectionError();
    }
    if (!isPlainObject(response) || Object.keys(response).length !== 2 || response.version !== 1 ||
      typeof response.isReparsePoint !== 'boolean' || JSON.stringify(response) !== decoded) throw inspectionError();
    return response.isReparsePoint;
  }
}

module.exports = { WindowsReparseInspector };
