const https = require('https');
const tls = require('tls');
const { createHash } = require('crypto');
const nodeCrypto = require('crypto');
const selfsigned = require('selfsigned');
const { cryptoProvider } = require('@peculiar/x509');
const appStore = require('./app-store.cjs');
const { packSecret, unpackSecret } = require('./secure-store.cjs');

const TLS_STORE_KEY = 'tls';
const MANAGEMENT_KEY = 'management';
const PANEL_KEY = 'browserPanel';

function normalizeFingerprint(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('sha256/')) {
    const raw = trimmed.slice(trimmed.indexOf('/') + 1).trim();
    if (raw) {
      const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
      try {
        const buf = Buffer.from(padded, 'base64');
        if (buf.length) {
          return buf.toString('hex').toLowerCase();
        }
      } catch {
        // Fall through to hex normalization
      }
    }
  }
  return trimmed.replace(/:/g, '').toLowerCase();
}

let cryptoProviderReady = false;

function ensureCryptoProvider() {
  if (cryptoProviderReady) return true;
  const webcrypto = nodeCrypto.webcrypto
    || (globalThis && globalThis.crypto && globalThis.crypto.subtle ? globalThis.crypto : null);
  if (!webcrypto || !webcrypto.subtle) {
    return false;
  }
  try {
    cryptoProvider.set(webcrypto);
    cryptoProviderReady = true;
    if (!globalThis.crypto) {
      try { globalThis.crypto = webcrypto; } catch { /* ignore assignment errors */ }
    }
    return true;
  } catch {
    return false;
  }
}

function getTlsStore() {
  return appStore.get(TLS_STORE_KEY) || {};
}

function setTlsStore(store) {
  appStore.set(TLS_STORE_KEY, store);
}

function safeGetTlsStore() {
  try {
    return getTlsStore();
  } catch {
    return {};
  }
}

function safeSetTlsStore(store) {
  try {
    setTlsStore(store);
  } catch {
    // Ignore persistence errors; in-memory config will still work for this session
  }
}

function getAltNames(extraHosts = []) {
  const hosts = new Set(['localhost', '127.0.0.1', '::1', ...extraHosts]);
  const altNames = [];
  for (const host of hosts) {
    if (!host) continue;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      altNames.push({ type: 7, ip: host });
    } else if (host === '::1') {
      altNames.push({ type: 7, ip: host });
    } else {
      altNames.push({ type: 2, value: host });
    }
  }
  return altNames;
}

async function generateCertificate(extraHosts = []) {
  if (!ensureCryptoProvider()) {
    throw new Error('WebCrypto is not available for certificate generation');
  }
  const attrs = [{ name: 'commonName', value: 'Minecraft Core' }];
  const options = {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: getAltNames(extraHosts) }]
  };
  return await selfsigned.generate(attrs, options);
}

function pemToDer(cert) {
  if (!cert || typeof cert !== 'string') return null;
  const stripped = cert
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  if (!stripped) return null;
  try {
    return Buffer.from(stripped, 'base64');
  } catch {
    return null;
  }
}

function getFingerprintForCert(cert) {
  if (!cert) return '';
  const der = pemToDer(cert);
  if (der && der.length) {
    return normalizeFingerprint(createHash('sha256').update(der).digest('hex'));
  }
  return normalizeFingerprint(createHash('sha256').update(String(cert)).digest('hex'));
}

async function getOrCreateTlsConfig(kind, extraHosts = []) {
  const store = safeGetTlsStore();
  const existing = store[kind];
  if (existing && existing.cert && existing.key) {
    try {
      const key = unpackSecret(existing.key);
      const computedFingerprint = getFingerprintForCert(existing.cert);
      const fingerprint = computedFingerprint || existing.fingerprint || '';
      if (computedFingerprint) {
        const storedFingerprint = normalizeFingerprint(existing.fingerprint || '');
        if (!storedFingerprint || storedFingerprint !== normalizeFingerprint(computedFingerprint)) {
          store[kind] = {
            ...existing,
            fingerprint: computedFingerprint
          };
          safeSetTlsStore(store);
        }
      }
      return { cert: existing.cert, key, fingerprint };
    } catch {
      // fall through to regenerate
    }
  }

  let generated;
  try {
    generated = await generateCertificate(extraHosts);
  } catch (error) {
    const message = error && error.message ? error.message : 'TLS certificate generation failed';
    throw new Error(message);
  }
  const cert = generated.cert;
  const key = generated.private;
  const fingerprint = getFingerprintForCert(cert);
  let packedKey = key;
  let keyEncrypted = false;
  try {
    packedKey = packSecret(key);
    keyEncrypted = true;
  } catch {
    packedKey = key;
  }
  store[kind] = {
    cert,
    key: packedKey,
    fingerprint,
    createdAt: new Date().toISOString(),
    keyEncrypted
  };
  safeSetTlsStore(store);
  return { cert, key, fingerprint };
}

function getTlsFingerprint(kind) {
  const store = safeGetTlsStore();
  const entry = store[kind];
  if (!entry) return '';
  const computed = entry.cert ? getFingerprintForCert(entry.cert) : '';
  if (computed) {
    const storedFingerprint = normalizeFingerprint(entry.fingerprint || '');
    if (!storedFingerprint || storedFingerprint !== normalizeFingerprint(computed)) {
      store[kind] = {
        ...entry,
        fingerprint: computed
      };
      safeSetTlsStore(store);
    }
    return normalizeFingerprint(computed);
  }
  if (!entry.fingerprint) return '';
  return normalizeFingerprint(entry.fingerprint);
}

function buildHttpsAgent(cert) {
  if (!cert) return null;
  return new https.Agent({
    ca: cert,
    rejectUnauthorized: true,
    checkServerIdentity: () => null
  });
}

function getPeerFingerprint(peer) {
  if (!peer) return '';
  const direct = normalizeFingerprint(peer.fingerprint256 || peer.fingerprint || '');
  if (direct) return direct;
  if (peer.raw && Buffer.isBuffer(peer.raw)) {
    return normalizeFingerprint(createHash('sha256').update(peer.raw).digest('hex'));
  }
  return '';
}

const pinnedAgentCache = new Map();

async function fetchPeerFingerprint(host, port) {
  if (!host) return '';
  const targetPort = port ? Number(port) : 443;
  return await new Promise((resolve) => {
    const socket = tls.connect(
      {
        host,
        port: targetPort,
        servername: host,
        rejectUnauthorized: false
      },
      () => {
        try {
          const cert = socket.getPeerCertificate(true);
          const fingerprint = getPeerFingerprint(cert);
          resolve(fingerprint);
        } catch {
          resolve('');
        } finally {
          socket.end();
        }
      }
    );
    socket.setTimeout(8000, () => {
      try { socket.destroy(); } catch { /* noop */ }
      resolve('');
    });
    socket.on('error', () => resolve(''));
  });
}

async function getPinnedHttpsAgent(host, port, expectedFingerprint) {
  const normalized = normalizeFingerprint(expectedFingerprint || '');
  if (!host || !normalized) return null;
  const targetPort = port ? Number(port) : 443;
  const cacheKey = `${host}:${targetPort}:${normalized}`;
  if (pinnedAgentCache.has(cacheKey)) {
    return pinnedAgentCache.get(cacheKey);
  }

  const agent = new https.Agent({
    keepAlive: true,
    createConnection: (options, callback) => {
      const socket = tls.connect(
        {
          ...options,
          host,
          port: targetPort,
          servername: host,
          rejectUnauthorized: false
        },
        () => {
          try {
            const cert = socket.getPeerCertificate(true);
            const actualFingerprint = getPeerFingerprint(cert);
            if (!actualFingerprint || actualFingerprint !== normalized) {
              const err = new Error('Pinned certificate fingerprint mismatch');
              socket.destroy(err);
              callback(err);
              return;
            }
            callback(null, socket);
          } catch (err) {
            socket.destroy(err);
            callback(err);
          }
        }
      );
      socket.on('error', (err) => callback(err));
      return socket;
    }
  });
  pinnedAgentCache.set(cacheKey, agent);
  return agent;
}

async function getManagementTlsConfig(extraHosts = []) {
  return getOrCreateTlsConfig(MANAGEMENT_KEY, extraHosts);
}

async function getBrowserPanelTlsConfig(extraHosts = []) {
  return getOrCreateTlsConfig(PANEL_KEY, extraHosts);
}

async function getManagementHttpsAgent() {
  const cfg = await getOrCreateTlsConfig(MANAGEMENT_KEY);
  return buildHttpsAgent(cfg.cert);
}

async function getBrowserPanelHttpsAgent() {
  const cfg = await getOrCreateTlsConfig(PANEL_KEY);
  return buildHttpsAgent(cfg.cert);
}

module.exports = {
  MANAGEMENT_KEY,
  PANEL_KEY,
  normalizeFingerprint,
  getManagementTlsConfig,
  getBrowserPanelTlsConfig,
  getManagementHttpsAgent,
  getBrowserPanelHttpsAgent,
  getTlsFingerprint,
  getPinnedHttpsAgent,
  fetchPeerFingerprint
};
