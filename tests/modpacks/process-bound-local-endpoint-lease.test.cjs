const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const leaseModule = require('../../electron/utils/process-bound-local-endpoint-lease.cjs');

test('a platform without a crash-released local endpoint primitive fails closed', () => {
  assert.throws(
    () => leaseModule.endpointFor({
      namespace: 'minecraft-core-workspace-test',
      leaseId: 'a'.repeat(64),
      platform: 'unsupported'
    }),
    error => error?.code === 'RECOVERY_REQUIRED'
  );
});

test('one process-bound endpoint lease excludes a competing owner until close', async t => {
  const leaseId = crypto.randomBytes(32).toString('hex');
  const request = { namespace: 'minecraft-core-workspace-test', leaseId };
  const first = await leaseModule.acquireProcessBoundLocalEndpointLease(request);
  t.after(() => first.close().catch(() => {}));

  assert.equal(first.assertHeld(), true);
  await assert.rejects(
    leaseModule.acquireProcessBoundLocalEndpointLease(request),
    error => error?.code === 'RECOVERY_REQUIRED'
  );
  assert.equal(first.assertHeld(), true);

  await first.close();
  const replacement = await leaseModule.acquireProcessBoundLocalEndpointLease(request);
  assert.equal(replacement.assertHeld(), true);
  await replacement.close();
});

function waitForLine(stream, expected, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('lease holder did not become ready')), timeoutMs);
    const onData = chunk => {
      text += String(chunk);
      if (!text.includes(expected)) return;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      resolve();
    };
    stream.on('data', onData);
  });
}

function waitForClose(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error('lease holder did not exit')), timeoutMs);
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

test('a hard-killed process releases its endpoint lease for exact crash reacquisition', async t => {
  const namespace = 'minecraft-core-workspace-crash-test';
  const leaseId = crypto.randomBytes(32).toString('hex');
  const fixture = path.join(__dirname, 'fixtures', 'process-bound-local-endpoint-lease-holder.cjs');
  const child = childProcess.spawn(process.execPath, [fixture, namespace, leaseId], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } });
  await waitForLine(child.stdout, 'ready\n');

  await assert.rejects(
    leaseModule.acquireProcessBoundLocalEndpointLease({ namespace, leaseId }),
    error => error?.code === 'RECOVERY_REQUIRED'
  );

  assert.equal(child.kill('SIGKILL'), true);
  await waitForClose(child);
  const recovered = await leaseModule.acquireProcessBoundLocalEndpointLease({ namespace, leaseId });
  assert.equal(recovered.assertHeld(), true);
  await recovered.close();
});
