'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { resolveSystemPowerShellRuntime, encodePowerShellCommand } = require('../../watchdog/app-watchdog.cjs');

const MAX_PROCESSES = 16384;
const MAX_COMMAND_LINE = 32768;
const POWERSHELL_INSPECT_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $cimModule = [Environment]::GetEnvironmentVariable('MC_CORE_CLIENT_CIM_MODULE', 'Process')
  if ([string]::IsNullOrWhiteSpace($cimModule)) { exit 31 }
  Import-Module -Name $cimModule -Force -ErrorAction Stop
  $items = @(CimCmdlets\Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  if ($items.Count -gt 16384) { exit 32 }
  $rows = @($items | ForEach-Object {
    [pscustomobject]@{
      pid = [int]$_.ProcessId
      parentPid = [int]$_.ParentProcessId
      name = [string]$_.Name
      creationTime = $(if ($null -eq $_.CreationDate) { $null } else { ([datetime]$_.CreationDate).ToUniversalTime().ToString('o') })
      executablePath = $_.ExecutablePath
      commandLine = $_.CommandLine
    }
  })
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject ([pscustomobject]@{ complete = $true; processes = $rows }) -Compress -Depth 4))
} catch { exit 33 }
`;

function validIdentity(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Number.isSafeInteger(value.pid) && value.pid > 0 &&
    Number.isSafeInteger(value.parentPid) && value.parentPid >= 0 &&
    ['creationTime', 'executablePath', 'commandLine'].every(key =>
      typeof value[key] === 'string' && value[key].trim().length > 0 && value[key].length <= MAX_COMMAND_LINE && !value[key].includes('\0'));
}

function validateProcessSnapshot(value) {
  if (!value || value.complete !== true || !Array.isArray(value.processes) || value.processes.length > MAX_PROCESSES) {
    throw new Error('Client process inspection is incomplete');
  }
  const ids = new Set();
  const processes = value.processes.map(entry => {
    // Only the kernel pseudo-processes are omitted. Protected process visibility
    // is retained for the guard to evaluate against its owner/Java scope.
    if ((entry?.pid === 0 || entry?.pid === 4) && Number.isSafeInteger(entry.parentPid)) return null;
    const name = entry?.name || (typeof entry?.executablePath === 'string' ? path.win32.basename(entry.executablePath) : null);
    if (!entry || !Number.isSafeInteger(entry.pid) || entry.pid <= 0 || !Number.isSafeInteger(entry.parentPid) || entry.parentPid < 0 ||
        typeof name !== 'string' || !name.trim() || name.length > 260 || /[\0\\/]/u.test(name) || ids.has(entry.pid) ||
        ['creationTime', 'executablePath', 'commandLine'].some(key => entry[key] !== null &&
          (typeof entry[key] !== 'string' || entry[key].length > MAX_COMMAND_LINE || entry[key].includes('\0')))) throw new Error('Client process identity is unavailable');
    ids.add(entry.pid);
    return Object.freeze({ pid: entry.pid, parentPid: entry.parentPid, name,
      creationTime: entry.creationTime, executablePath: entry.executablePath, commandLine: entry.commandLine });
  }).filter(Boolean);
  return Object.freeze({ complete: true, processes: Object.freeze(processes) });
}

function createClientProcessInspector({ platform = process.platform, env = process.env, execFileFn = execFile,
  resolveRuntime = resolveSystemPowerShellRuntime } = {}) {
  return async function inspectProcesses() {
    if (platform !== 'win32') throw new Error('Authoritative client process inspection is unavailable on this platform');
    const runtime = resolveRuntime({ env });
    if (!runtime) throw new Error('System process inspector is unavailable');
    const output = await new Promise((resolve, reject) => {
      execFileFn(runtime.executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(POWERSHELL_INSPECT_SOURCE)], {
        windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
        env: { SystemRoot: runtime.systemRoot, WINDIR: runtime.systemRoot, PSModulePath: runtime.modulePath,
          MC_CORE_CLIENT_CIM_MODULE: runtime.cimModule }
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    return validateProcessSnapshot(JSON.parse(output.replace(/^\uFEFF/u, '')));
  };
}

module.exports = { createClientProcessInspector, validateProcessSnapshot, validIdentity };
