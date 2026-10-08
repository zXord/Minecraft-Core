const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  POWERSHELL_WATCHDOG_SOURCE,
  encodePowerShellCommand,
  resolveSystemPowerShell
} = require('../electron/watchdog/app-watchdog.cjs');
const { createAppWatchdogSupervisor } = require('../electron/watchdog/app-watchdog-supervisor.cjs');

const LEGACY_PATH = path.resolve(__dirname, '..', 'electron', 'watchdog', 'minecraft-watchdog.cjs');

test('packaged watchdog source has no legacy broad-kill or mutable PID-file authority', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(manifest.build.files.includes('electron/**/*'));
  assert.equal(fs.existsSync(LEGACY_PATH), false);
  const runtimeSource = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'utils', 'runtime-paths.cjs'), 'utf8');
  assert.doesNotMatch(runtimeSource, /watchdogPid|currentWatchdogPid|watchdog\.pid|current-watchdog/iu);
  for (const name of fs.readdirSync(path.resolve(__dirname, '..', 'electron', 'watchdog')).filter(value => value.endsWith('.cjs'))) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'watchdog', name), 'utf8');
    assert.doesNotMatch(source, /\bwmic(?:Terminate|ExecSync)?\b|\btaskkill\b|process\.kill\([^,]+,\s*0\)|watchdogPid/iu, name);
  }
});

test('persistent PowerShell pins target identity before ACK and never reacquires by PID after ACK', () => {
  const pin = POWERSHELL_WATCHDOG_SOURCE.indexOf('$pinnedHandle = $target.SafeHandle');
  const creation = POWERSHELL_WATCHDOG_SOURCE.indexOf('$cim.CreationDate');
  const token = POWERSHELL_WATCHDOG_SOURCE.indexOf('$cim.CommandLine');
  const ack = POWERSHELL_WATCHDOG_SOURCE.indexOf('[Console]::Out.WriteLine');
  const eof = POWERSHELL_WATCHDOG_SOURCE.indexOf('[Console]::In.ReadToEnd()');
  const kill = POWERSHELL_WATCHDOG_SOURCE.indexOf('$target.Kill()', eof);
  assert.ok(pin > 0 && creation > pin && token > creation && ack > token && eof > ack && kill > eof);
  assert.equal(POWERSHELL_WATCHDOG_SOURCE.indexOf('GetProcessById', ack), -1);
  assert.match(POWERSHELL_WATCHDOG_SOURCE, /\(\?:\^\|\\s\).*\(\?=\\s\|\$\)/u);
  assert.doesNotMatch(POWERSHELL_WATCHDOG_SOURCE, /-Command|taskkill|wmic/iu);
  assert.ok(Buffer.from(encodePowerShellCommand(), 'base64').toString('utf16le').includes('$target.SafeHandle'));
});

test('SystemRoot resolver accepts only canonical regular non-reparse PowerShell', () => {
  const executable = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const cimModule = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\CimCmdlets\\CimCmdlets.psd1';
  const validFs = {
    lstatSync(value) { assert.ok([executable, cimModule].includes(value)); return { isFile: () => true, isSymbolicLink: () => false }; },
    realpathSync: { native(value) { return value; } }
  };
  assert.equal(resolveSystemPowerShell({ env: { SystemRoot: 'C:\\Windows' }, fsApi: validFs }), executable);
  for (const SystemRoot of ['', 'Windows', '\\\\host\\share', 'C:\\Windows\\..\\Temp']) {
    assert.equal(resolveSystemPowerShell({ env: { SystemRoot }, fsApi: validFs }), null);
  }
  assert.equal(resolveSystemPowerShell({ env: { SystemRoot: 'C:\\Windows' }, fsApi: {
    ...validFs, lstatSync() { return { isFile: () => true, isSymbolicLink: () => true }; }
  } }), null);
});

test('real Windows arm ACK pins a harmless exact process and mismatch never touches it', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const operationId = `watchdog-integration-${Date.now()}`;
  const target = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `-Dminecraft.core.server.id=${operationId}`], {
    stdio: 'ignore', windowsHide: true
  });
  t.after(() => { try { target.kill('SIGKILL'); } catch {} });
  assert.ok(Number.isSafeInteger(target.pid) && target.pid > 0);

  const eventBus = new EventEmitter();
  const supervisor = createAppWatchdogSupervisor({ eventBus, warn() {} });
  supervisor.start();
  t.after(() => supervisor.dispose());
  const request = id => new Promise((resolve, reject) => {
    eventBus.emit('server-process-owned', {
      acknowledge(value) { value.ready.then(resolve, reject); },
      instanceId: 'watchdog-integration', operationId: id, pid: target.pid,
      onSupervisionFailure() {}
    });
  });

  await request(operationId);
  eventBus.emit('server-process-released', { instanceId: 'watchdog-integration', operationId, pid: target.pid });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(target.exitCode, null);

  await assert.rejects(request(`${operationId}-mismatch`));
  assert.equal(target.exitCode, null);
});
