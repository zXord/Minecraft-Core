'use strict';

const fs = require('node:fs');
const path = require('node:path');

const POWERSHELL_WATCHDOG_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $pidText = [Environment]::GetEnvironmentVariable('MC_CORE_WATCHDOG_PID', 'Process')
  $instanceId = [Environment]::GetEnvironmentVariable('MC_CORE_WATCHDOG_INSTANCE', 'Process')
  $operationId = [Environment]::GetEnvironmentVariable('MC_CORE_WATCHDOG_OPERATION', 'Process')
  $nonce = [Environment]::GetEnvironmentVariable('MC_CORE_WATCHDOG_NONCE', 'Process')
  $cimModule = [Environment]::GetEnvironmentVariable('MC_CORE_WATCHDOG_CIM_MODULE', 'Process')
  $targetPid = 0
  if (-not [int]::TryParse($pidText, [ref]$targetPid) -or $targetPid -le 0) { exit 21 }
  $idPattern = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  if ($instanceId -notmatch $idPattern -or $operationId -notmatch $idPattern -or $nonce -notmatch '^[a-f0-9]{64}$') { exit 22 }
  $target = [System.Diagnostics.Process]::GetProcessById($targetPid)
  $pinnedHandle = $target.SafeHandle
  $null = $pinnedHandle.DangerousGetHandle()
  if ($target.HasExited) { exit 23 }
  $processStart = $target.StartTime.ToUniversalTime()
  if ([string]::IsNullOrWhiteSpace($cimModule)) { exit 30 }
  Import-Module -Name $cimModule -Force -ErrorAction Stop
  $cim = CimCmdlets\Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = {0}' -f $targetPid) -ErrorAction Stop
  if ($null -eq $cim -or [int]$cim.ProcessId -ne $targetPid) { exit 24 }
  $cimStart = ([datetime]$cim.CreationDate).ToUniversalTime()
  if ([math]::Abs(($processStart - $cimStart).TotalSeconds) -gt 2) { exit 25 }
  $expectedToken = '-Dminecraft.core.server.id=' + $operationId
  $tokenPattern = '(?:^|\s)' + [regex]::Escape($expectedToken) + '(?=\s|$)'
  if (-not [regex]::IsMatch([string]$cim.CommandLine, $tokenPattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant)) { exit 26 }
  if ($target.HasExited) { exit 27 }
  [Console]::Out.WriteLine(('MCWD1|{0}|{1}|{2}|{3}' -f $nonce, $instanceId, $targetPid, $operationId))
  [Console]::Out.Flush()
  $null = [Console]::In.ReadToEnd()
  if (-not $target.HasExited) {
    $target.Kill()
    $target.WaitForExit(10000) | Out-Null
    if (-not $target.HasExited) { exit 28 }
  }
  exit 0
} catch {
  exit 29
}
`;

function encodePowerShellCommand(source = POWERSHELL_WATCHDOG_SOURCE) {
  return Buffer.from(source, 'utf16le').toString('base64');
}

function resolveSystemPowerShellRuntime({ env = process.env, fsApi = fs } = {}) {
  const systemRoot = env?.SystemRoot;
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\/u.test(systemRoot) ||
      /[\u0000-\u001f]/u.test(systemRoot) || systemRoot.split(/[\\/]+/u).includes('..')) return null;
  const normalizedRoot = path.win32.normalize(systemRoot);
  if (!path.win32.isAbsolute(normalizedRoot) || !/^[A-Za-z]:\\/u.test(normalizedRoot)) return null;
  const executable = path.win32.join(normalizedRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const modulePath = path.win32.join(normalizedRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  const cimModule = path.win32.join(modulePath, 'CimCmdlets', 'CimCmdlets.psd1');
  try {
    const rootReal = fsApi.realpathSync.native(normalizedRoot);
    const executableReal = fsApi.realpathSync.native(executable);
    const modulePathReal = fsApi.realpathSync.native(modulePath);
    const cimModuleReal = fsApi.realpathSync.native(cimModule);
    const executableStat = fsApi.lstatSync(executableReal);
    const cimModuleStat = fsApi.lstatSync(cimModuleReal);
    if (!executableStat.isFile() || executableStat.isSymbolicLink() ||
        !cimModuleStat.isFile() || cimModuleStat.isSymbolicLink()) return null;
    if (path.win32.normalize(rootReal).toLowerCase() !== normalizedRoot.toLowerCase()) return null;
    if (path.win32.normalize(executableReal).toLowerCase() !== executable.toLowerCase()) return null;
    if (path.win32.normalize(modulePathReal).toLowerCase() !== modulePath.toLowerCase()) return null;
    if (path.win32.normalize(cimModuleReal).toLowerCase() !== cimModule.toLowerCase()) return null;
    return Object.freeze({
      cimModule: cimModuleReal,
      executable: executableReal,
      modulePath: modulePathReal,
      systemRoot: rootReal
    });
  } catch {
    return null;
  }
}

function resolveSystemPowerShell(options) {
  return resolveSystemPowerShellRuntime(options)?.executable || null;
}

module.exports = {
  POWERSHELL_WATCHDOG_SOURCE,
  encodePowerShellCommand,
  resolveSystemPowerShell,
  resolveSystemPowerShellRuntime
};
