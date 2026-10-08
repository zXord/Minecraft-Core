const { spawn } = require('node:child_process');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const MAX_INPUT_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 256;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_TIMEOUT_MS = 5_000;
const MAX_STARTUP_TIMEOUT_MS = 30_000;
const KILL_WAIT_MS = 1_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5_000;
const RETRYABLE_WORKER_EXIT = Symbol('retryable-worker-exit');

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$maximumInputBytes = 131072
$probeSource = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class MinecraftCoreReparseProbe
{
    private const uint FileReadAttributes = 0x00000080;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint FileShareDelete = 0x00000004;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const uint IoReparseTagNameSurrogate = 0x20000000;
    private const int FileAttributeTagInfo = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct FileAttributeTagInformation
    {
        internal uint FileAttributes;
        internal uint ReparseTag;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        internal uint FileAttributes;
        internal long CreationTime;
        internal long LastAccessTime;
        internal long LastWriteTime;
        internal uint VolumeSerialNumber;
        internal uint FileSizeHigh;
        internal uint FileSizeLow;
        internal uint NumberOfLinks;
        internal uint FileIndexHigh;
        internal uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int informationClass,
        out FileAttributeTagInformation information, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out ByHandleFileInformation information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint length, uint flags);

    public static bool IsNameSurrogate(string value)
    {
        string expected = Path.GetFullPath(value);
        using (SafeFileHandle handle = CreateFile(expected, FileReadAttributes, FileShareRead | FileShareWrite | FileShareDelete,
            IntPtr.Zero, OpenExisting, FileFlagOpenReparsePoint | FileFlagBackupSemantics, IntPtr.Zero))
        {
            if (handle.IsInvalid) throw new IOException("Reparse handle unavailable");
            FileAttributeTagInformation beforeTag;
            FileAttributeTagInformation afterTag;
            ByHandleFileInformation beforeIdentity;
            ByHandleFileInformation afterIdentity;
            if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, out beforeTag, (uint)Marshal.SizeOf(typeof(FileAttributeTagInformation))) ||
                !GetFileInformationByHandle(handle, out beforeIdentity)) throw new IOException("Reparse identity unavailable");
            bool hasReparse = (beforeTag.FileAttributes & FileAttributeReparsePoint) != 0;
            if (hasReparse != (beforeTag.ReparseTag != 0)) throw new InvalidDataException("Reparse tag invalid");
            var finalPath = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(handle, finalPath, (uint)finalPath.Capacity, 0);
            if (length == 0 || length >= finalPath.Capacity) throw new IOException("Reparse final path unavailable");
            string actual = finalPath.ToString();
            if (actual.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("UNC path rejected");
            if (actual.StartsWith(@"\\?\", StringComparison.Ordinal)) actual = actual.Substring(4);
            if (!string.Equals(expected, Path.GetFullPath(actual), StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Reparse path redirected");
            if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, out afterTag, (uint)Marshal.SizeOf(typeof(FileAttributeTagInformation))) ||
                !GetFileInformationByHandle(handle, out afterIdentity)) throw new IOException("Reparse identity unavailable");
            bool hasReparseAfter = (afterTag.FileAttributes & FileAttributeReparsePoint) != 0;
            if (hasReparseAfter != (afterTag.ReparseTag != 0)) throw new InvalidDataException("Reparse tag invalid");
            if (hasReparse != hasReparseAfter || beforeTag.ReparseTag != afterTag.ReparseTag ||
                beforeIdentity.VolumeSerialNumber != afterIdentity.VolumeSerialNumber ||
                beforeIdentity.FileIndexHigh != afterIdentity.FileIndexHigh || beforeIdentity.FileIndexLow != afterIdentity.FileIndexLow)
                throw new InvalidDataException("Reparse identity changed");
            return (beforeTag.ReparseTag & IoReparseTagNameSurrogate) != 0;
        }
    }
}
'@
Add-Type -TypeDefinition $probeSource -Language CSharp
function Exit-ReparseProbeFailure($errorRecord) {
  $exception = $errorRecord.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  if ($exception -is [System.IO.InvalidDataException]) { exit 67 }
  exit 66
}
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
  if ([MinecraftCoreReparseProbe]::IsNameSurrogate($payload.path)) {
    $response = '{"version":1,"isReparsePoint":true}'
  } else {
    $response = '{"version":1,"isReparsePoint":false}'
  }
  $responseBytes = $utf8.GetBytes($response)
  $outputStream = [Console]::OpenStandardOutput()
  $outputStream.Write($responseBytes, 0, $responseBytes.Length)
  $outputStream.Flush()
} catch {
  Exit-ReparseProbeFailure $_
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

const PERSISTENT_INPUT_MARKER = '$inputStream = [Console]::OpenStandardInput()';
const persistentInputOffset = POWERSHELL_SCRIPT.indexOf(PERSISTENT_INPUT_MARKER);
if (persistentInputOffset < 0) throw new Error('Windows reparse probe source is incomplete');
const PERSISTENT_POWERSHELL_SCRIPT = `${POWERSHELL_SCRIPT.slice(0, persistentInputOffset)}${String.raw`
$utf8 = [System.Text.UTF8Encoding]::new($false, $true)
$inputStream = [Console]::OpenStandardInput()
$outputStream = [Console]::OpenStandardOutput()
$reader = New-Object System.IO.StreamReader($inputStream, $utf8, $false, 4096, $true)
try {
  while (($line = $reader.ReadLine()) -ne $null) {
    $lineBytes = $utf8.GetByteCount($line)
    if ($lineBytes -lt 2 -or $lineBytes -gt $maximumInputBytes) { exit 64 }
    $payload = ConvertFrom-Json -InputObject $line
    $properties = @($payload.PSObject.Properties)
    $validIdType = $payload.id -is [int] -or $payload.id -is [long]
    if ($properties.Count -ne 2 -or $properties[0].Name -cne 'id' -or $properties[1].Name -cne 'path' -or
        -not $validIdType -or $payload.id -lt 1 -or $payload.id -gt 2147483647 -or
        $payload.path -isnot [string] -or $payload.path.Length -lt 1 -or $payload.path.Length -gt 32767 -or
        -not [System.IO.Path]::IsPathRooted($payload.path)) { exit 65 }
    $result = [MinecraftCoreReparseProbe]::IsNameSurrogate($payload.path)
    $response = if ($result) {
      '{"id":' + [string]$payload.id + ',"version":1,"isReparsePoint":true}'
    } else {
      '{"id":' + [string]$payload.id + ',"version":1,"isReparsePoint":false}'
    }
    $responseBytes = $utf8.GetBytes($response)
    $outputStream.Write($responseBytes, 0, $responseBytes.Length)
    $outputStream.WriteByte(10)
    $outputStream.Flush()
  }
} catch {
  Exit-ReparseProbeFailure $_
} finally {
  $reader.Dispose()
}
`}`;
const PERSISTENT_ENCODED_SCRIPT = Buffer.from(PERSISTENT_POWERSHELL_SCRIPT, 'utf16le').toString('base64');
const PERSISTENT_POWERSHELL_ARGS = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  PERSISTENT_ENCODED_SCRIPT
]);

function inspectionError() {
  const error = new Error('Windows reparse-point inspection failed');
  error.code = 'REPARSE_INSPECTION_FAILED';
  return error;
}

function unexpectedWorkerExitError(exitCode) {
  const error = inspectionError();
  if (exitCode === 66) Object.defineProperty(error, RETRYABLE_WORKER_EXIT, { value: true });
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

class PersistentPowerShellProbe {
  constructor({ executable, spawnProcess, timeoutMs, startupTimeoutMs, idleTimeoutMs }) {
    this.executable = executable;
    this.spawnProcess = spawnProcess;
    this.timeoutMs = timeoutMs;
    this.startupTimeoutMs = startupTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.worker = null;
    this.requestTail = Promise.resolve();
    this.nextRequestId = 1;
  }

  inspect(filePath, signal) {
    const execute = async () => {
      if (signal?.aborted) throw abortError();
      try {
        return await this.#request(filePath, signal);
      } catch (error) {
        if (!error?.[RETRYABLE_WORKER_EXIT] || signal?.aborted) throw error;
        return this.#request(filePath, signal);
      }
    };
    const pending = this.requestTail.then(execute, execute);
    this.requestTail = pending.catch(() => {});
    return pending;
  }

  close() {
    if (this.worker) this.#terminate(this.worker, inspectionError(), true);
  }

  #spawnWorker() {
    let child;
    try {
      child = this.spawnProcess(this.executable, [...PERSISTENT_POWERSHELL_ARGS], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      throw inspectionError();
    }
    if (!child || typeof child.once !== 'function' || typeof child.kill !== 'function' ||
        !child.stdin || typeof child.stdin.write !== 'function' || !child.stdout || typeof child.stdout.on !== 'function' ||
        !child.stderr || typeof child.stderr.on !== 'function') {
      try { child?.kill?.(); } catch { /* fail closed below */ }
      throw inspectionError();
    }
    const worker = {
      child,
      current: null,
      stdout: Buffer.alloc(0),
      stderrBytes: 0,
      idleTimer: null,
      terminating: false
    };
    this.worker = worker;
    child.stdout.on('data', chunk => this.#handleStdout(worker, chunk));
    child.stderr.on('data', chunk => this.#handleStderr(worker, chunk));
    child.stdin.on?.('error', () => this.#terminate(worker, inspectionError()));
    child.once('error', () => this.#terminate(worker, inspectionError()));
    child.once('close', (code, closeSignal) => {
      if (this.worker !== worker) return;
      this.worker = null;
      clearTimeout(worker.idleTimer);
      const current = worker.current;
      worker.current = null;
      if (current) {
        current.cleanup();
        const error = unexpectedWorkerExitError(code);
        current.reject(error);
      }
      if (!worker.terminating && (code !== 0 || closeSignal !== null)) worker.terminating = true;
    });
    child.unref?.();
    child.stdin.unref?.();
    child.stdout.unref?.();
    child.stderr.unref?.();
    return worker;
  }

  #request(filePath, signal) {
    return new Promise((resolve, reject) => {
      let worker;
      const coldStart = !this.worker;
      try { worker = this.worker || this.#spawnWorker(); }
      catch (error) { reject(error); return; }
      if (worker.current || worker.terminating) {
        this.#terminate(worker, inspectionError());
        reject(inspectionError());
        return;
      }
      clearTimeout(worker.idleTimer);
      worker.idleTimer = null;
      const id = this.nextRequestId;
      this.nextRequestId = id >= 2147483647 ? 1 : id + 1;
      const input = Buffer.from(`${JSON.stringify({ id, path: filePath })}\n`, 'utf8');
      if (input.length > MAX_INPUT_BYTES) {
        reject(inspectionError());
        return;
      }
      let abortListener = null;
      const timeoutTimer = setTimeout(
        () => this.#terminate(worker, inspectionError()),
        coldStart ? this.startupTimeoutMs : this.timeoutMs
      );
      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (abortListener) {
          try { signal.removeEventListener('abort', abortListener); } catch { /* error stays redacted */ }
        }
      };
      worker.current = { id, resolve, reject, cleanup };
      if (signal) {
        abortListener = () => this.#terminate(worker, abortError());
        try { signal.addEventListener('abort', abortListener, { once: true }); }
        catch {
          this.#terminate(worker, inspectionError());
          return;
        }
        if (signal.aborted) {
          abortListener();
          return;
        }
      }
      try { worker.child.stdin.write(input); }
      catch { this.#terminate(worker, inspectionError()); }
    });
  }

  #handleStdout(worker, chunk) {
    if (this.worker !== worker || worker.terminating) return;
    if (!Buffer.isBuffer(chunk) || !worker.current) {
      this.#terminate(worker, inspectionError());
      return;
    }
    worker.stdout = Buffer.concat([worker.stdout, chunk]);
    if (worker.stdout.length > MAX_OUTPUT_BYTES) {
      this.#terminate(worker, inspectionError());
      return;
    }
    const newline = worker.stdout.indexOf(0x0a);
    if (newline === -1) return;
    if (newline < 1 || newline !== worker.stdout.length - 1) {
      this.#terminate(worker, inspectionError());
      return;
    }
    const responseBytes = worker.stdout.subarray(0, newline);
    worker.stdout = Buffer.alloc(0);
    let decoded;
    let response;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(responseBytes);
      response = JSON.parse(decoded);
    } catch {
      this.#terminate(worker, inspectionError());
      return;
    }
    const current = worker.current;
    if (!isPlainObject(response) || Object.keys(response).length !== 3 ||
        response.id !== current.id || response.version !== 1 || typeof response.isReparsePoint !== 'boolean' ||
        JSON.stringify(response) !== decoded) {
      this.#terminate(worker, inspectionError());
      return;
    }
    worker.current = null;
    worker.stderrBytes = 0;
    current.cleanup();
    worker.idleTimer = setTimeout(() => this.#terminate(worker, inspectionError(), true), this.idleTimeoutMs);
    worker.idleTimer.unref?.();
    current.resolve(response.isReparsePoint);
  }

  #handleStderr(worker, chunk) {
    if (this.worker !== worker || worker.terminating) return;
    if (!Buffer.isBuffer(chunk)) {
      this.#terminate(worker, inspectionError());
      return;
    }
    worker.stderrBytes += chunk.length;
    if (worker.stderrBytes > MAX_STDERR_BYTES) this.#terminate(worker, inspectionError());
  }

  #terminate(worker, error, expected = false) {
    if (!worker || worker.terminating) return;
    worker.terminating = true;
    clearTimeout(worker.idleTimer);
    if (this.worker === worker) this.worker = null;
    const current = worker.current;
    worker.current = null;
    if (current) {
      current.cleanup();
      current.reject(error);
    }
    try { worker.child.kill(); } catch { /* bounded escalation below remains authoritative */ }
    const escalation = setTimeout(() => {
      try { worker.child.kill('SIGKILL'); } catch { /* the process is already detached from requests */ }
    }, KILL_WAIT_MS);
    escalation.unref?.();
    if (expected) return;
  }
}

class WindowsReparseInspector {
  constructor({
    platform = process.platform,
    powershellPath = defaultPowerShellPath(),
    spawnProcess = spawn,
    timeoutMs = MAX_TIMEOUT_MS,
    startupTimeoutMs = MAX_STARTUP_TIMEOUT_MS,
    persistent = spawnProcess === spawn,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS
  } = {}) {
    if (typeof platform !== 'string' || typeof spawnProcess !== 'function' || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS || typeof persistent !== 'boolean' ||
      !Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > MAX_STARTUP_TIMEOUT_MS ||
      !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > 60_000 ||
      (platform === 'win32' && !validPowerShellPath(powershellPath))) {
      throw new TypeError('Windows reparse inspector dependencies are invalid');
    }
    this.platform = platform;
    this.powershellPath = powershellPath;
    this.spawnProcess = spawnProcess;
    this.timeoutMs = timeoutMs;
    this.persistentProbe = persistent
      ? new PersistentPowerShellProbe({
          executable: powershellPath,
          spawnProcess,
          timeoutMs,
          startupTimeoutMs,
          idleTimeoutMs
        })
      : null;
  }

  async isReparsePoint(filePath, options) {
    const signal = readSignal(options);
    if (signal?.aborted) throw abortError();
    if (this.platform !== 'win32' || !isFullyQualifiedWindowsPath(filePath) ||
      filePath.length < 1 || filePath.length > 32767 || filePath.includes('\0')) throw inspectionError();
    if (this.persistentProbe) return this.persistentProbe.inspect(filePath, signal);
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

  close() {
    this.persistentProbe?.close();
  }
}

module.exports = { WindowsReparseInspector };
