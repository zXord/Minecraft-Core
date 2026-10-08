const { acquireProcessBoundLocalEndpointLease } = require('../../../electron/utils/process-bound-local-endpoint-lease.cjs');

async function main() {
  const [namespace, leaseId] = process.argv.slice(2);
  const lease = await acquireProcessBoundLocalEndpointLease({ namespace, leaseId });
  lease.assertHeld();
  process.stdout.write('ready\n');
  setInterval(() => lease.assertHeld(), 1_000);
}

main().catch(error => {
  process.stderr.write(`${error?.code || 'ERROR'}\n`);
  process.exitCode = 1;
});
