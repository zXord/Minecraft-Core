const net = require('node:net');

const { ModpackError } = require('../services/modpacks/errors.cjs');

const LEASE_ID = /^[a-f0-9]{64}$/;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function recoveryRequired(cause) {
  return new ModpackError('RECOVERY_REQUIRED', 'The workspace root is already in use or unavailable', { cause });
}

function endpointFor({ namespace, leaseId, platform = process.platform } = {}) {
  if (typeof namespace !== 'string' || !NAMESPACE.test(namespace) ||
      typeof leaseId !== 'string' || !LEASE_ID.test(leaseId) || typeof platform !== 'string' || !platform) throw recoveryRequired();
  const name = `${namespace}-${leaseId}`;
  if (platform === 'win32') return `\\\\.\\pipe\\${name}`;
  if (platform === 'linux') return `\0${name}`;
  throw recoveryRequired();
}

async function acquireProcessBoundLocalEndpointLease(request = {}) {
  const endpoint = endpointFor(request);
  const server = net.createServer(socket => socket.destroy());
  server.unref();
  let closing = false;
  let closed = false;
  let lost = false;

  try {
    await new Promise((resolve, reject) => {
      const onError = error => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ path: endpoint, exclusive: true });
    });
  } catch (error) {
    try { server.close(); } catch { /* the competing endpoint remains authoritative */ }
    throw recoveryRequired(error);
  }

  server.on('error', () => { lost = true; });
  server.on('close', () => { if (!closing) lost = true; });

  return Object.freeze({
    assertHeld() {
      if (closed || lost || !server.listening) throw recoveryRequired();
      return true;
    },
    async close() {
      if (closed) return false;
      closing = true;
      try {
        if (server.listening) {
          await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
      } catch (error) {
        throw recoveryRequired(error);
      } finally {
        closed = true;
      }
      return true;
    }
  });
}

module.exports = { acquireProcessBoundLocalEndpointLease, endpointFor };
