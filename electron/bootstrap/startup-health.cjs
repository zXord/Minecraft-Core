const fs = require('node:fs');

const STARTUP_STATUSES = Object.freeze(['starting', 'ready', 'degraded']);
const MODPACK_SERVICE_STATES = Object.freeze(['pending', 'ready', 'unavailable']);
const LEGACY_FALLBACK_STATES = Object.freeze(['active', 'inactive']);
const STARTUP_FAILURE_REASONS = Object.freeze([
  'archive-worker-missing',
  'archive-worker-blocked',
  'profile-on-network-share',
  'unexpected'
]);
const RECOVERY_GATE_BASES = Object.freeze(['boundary', 'no-recovery-records', 'read-only-scan', 'unreadable', 'unsettled']);
const MAX_STARTUP_ISSUES = 20;
const MAX_BLOCKED_SERVERS = 1000;
const MAX_CAUSE_DEPTH = 8;
const MAX_CAUSE_TEXT_LENGTH = 300;
const MAX_TECHNICAL_LENGTH = 2000;
const MAX_TEXT_LENGTH = 4000;
const MAX_STAGE_LENGTH = 200;
const BLOCKED_SPAWN_CODES = Object.freeze(['EACCES', 'EPERM']);

const FAILURE_TEXT = Object.freeze({
  'archive-worker-missing': Object.freeze({
    summary: 'Minecraft Core could not find its file safety helper, ArchiveWorker.exe.',
    hint: 'Antivirus software may have quarantined it. Restore ArchiveWorker.exe from quarantine or reinstall Minecraft Core, then start it again.'
  }),
  'archive-worker-blocked': Object.freeze({
    summary: 'Windows or antivirus software blocked Minecraft Core\'s file safety helper, ArchiveWorker.exe.',
    hint: 'Allow ArchiveWorker.exe in your antivirus software or reinstall Minecraft Core, then start it again.'
  }),
  'profile-on-network-share': Object.freeze({
    summary: 'Minecraft Core\'s data folder is on a network share, which its modpack features cannot use safely.',
    hint: 'Modpack features need the Minecraft Core data folder on a local drive. Ask whoever manages this PC whether AppData can stay on a local drive.'
  }),
  unexpected: Object.freeze({
    summary: 'Minecraft Core ran into an unexpected problem while starting.',
    hint: 'Check for updates, or open the log folder and send the newest log to the developer.'
  })
});

function readProperty(value, key) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function readString(value, key) {
  const property = readProperty(value, key);
  return typeof property === 'string' ? property : null;
}

function singleLine(value, limit) {
  const text = [...value.slice(0, limit * 4)]
    .map(character => {
      const code = character.codePointAt(0);
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function collectCauseChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (chain.length <= MAX_CAUSE_DEPTH && current !== undefined && current !== null) {
    if (typeof current === 'object' || typeof current === 'function') {
      if (seen.has(current)) break;
      seen.add(current);
    }
    chain.push(current);
    current = readProperty(current, 'cause');
  }
  return chain;
}

function describeCause(cause) {
  if (cause === null || (typeof cause !== 'object' && typeof cause !== 'function')) {
    return singleLine(String(cause), MAX_CAUSE_TEXT_LENGTH);
  }
  const name = readString(cause, 'name') || 'Error';
  const code = readString(cause, 'code');
  const message = readString(cause, 'message');
  const label = code ? `${name} ${code}` : name;
  return singleLine(message ? `${label}: ${message}` : label, MAX_CAUSE_TEXT_LENGTH);
}

function technicalText(chain) {
  const text = chain.map(describeCause).filter(Boolean).join(' <- ');
  if (!text) return 'Unknown startup error';
  return text.length > MAX_TECHNICAL_LENGTH ? `${text.slice(0, MAX_TECHNICAL_LENGTH - 1)}…` : text;
}

function isNetworkSharePath(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replace(/\//gu, '\\');
  if (!normalized.startsWith('\\\\')) return false;
  // \\?\C:\ and \\.\C:\ are local paths with a device prefix; \\?\UNC\ is a share.
  if (/^\\\\[?.]\\UNC\\/iu.test(normalized)) return true;
  return !/^\\\\[?.]\\/u.test(normalized);
}

function workerFileState(workerPath, existsSync) {
  if (typeof workerPath !== 'string' || !workerPath.trim()) return 'unknown';
  try {
    return existsSync(workerPath) ? 'present' : 'missing';
  } catch {
    return 'unknown';
  }
}

function classifyStartupFailure(chain, { userDataPath, workerPath, existsSync }) {
  const codes = chain.map(cause => readString(cause, 'code'));
  const extractorUnavailable = codes.includes('EXTRACTOR_UNAVAILABLE');
  const spawnCodes = chain
    .filter(cause => (readString(cause, 'syscall') || '').startsWith('spawn'))
    .map(cause => readString(cause, 'code'));
  if (extractorUnavailable || spawnCodes.includes('ENOENT')) {
    const worker = workerFileState(workerPath, existsSync);
    if (worker === 'missing' || (worker === 'unknown' && codes.includes('ENOENT'))) return 'archive-worker-missing';
  }
  if (extractorUnavailable || spawnCodes.some(code => BLOCKED_SPAWN_CODES.includes(code))) return 'archive-worker-blocked';
  if (isNetworkSharePath(userDataPath)) return 'profile-on-network-share';
  return 'unexpected';
}

/**
 * Turns a startup error into the plain-English failure the fatal dialog and the
 * degraded-mode banner show. It walks error.cause up to eight levels and never
 * throws, whatever was thrown.
 */
function describeStartupFailure(error, { userDataPath = null, workerPath = null, existsSync = fs.existsSync, stage = null } = {}) {
  const chain = collectCauseChain(error);
  const reason = classifyStartupFailure(chain, {
    userDataPath,
    workerPath,
    existsSync: typeof existsSync === 'function' ? existsSync : fs.existsSync
  });
  return Object.freeze({
    stage: typeof stage === 'string' && stage.trim() ? singleLine(stage, MAX_STAGE_LENGTH) : null,
    reason,
    summary: FAILURE_TEXT[reason].summary,
    hint: FAILURE_TEXT[reason].hint,
    technical: technicalText(chain)
  });
}

function invalid(message) {
  return new TypeError(`Startup health ${message}`);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireText(value, field, limit = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw invalid(`${field} is invalid`);
  return value;
}

function freezeDescription(value, field) {
  if (!isPlainObject(value)) throw invalid(`${field} is invalid`);
  if (!STARTUP_FAILURE_REASONS.includes(value.reason)) throw invalid(`${field} reason is invalid`);
  if (value.stage !== null && value.stage !== undefined) requireText(value.stage, `${field} stage`, MAX_STAGE_LENGTH);
  return Object.freeze({
    stage: value.stage ?? null,
    reason: value.reason,
    summary: requireText(value.summary, `${field} summary`),
    hint: requireText(value.hint, `${field} hint`),
    technical: requireText(value.technical, `${field} technical text`)
  });
}

function freezeBlockedServer(entry) {
  if (typeof entry === 'string') return requireText(entry, 'blocked server', 1000);
  if (!isPlainObject(entry)) throw invalid('blocked server is invalid');
  const copy = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw invalid('blocked server fields must be plain values');
    }
    if (typeof value === 'number' && !Number.isFinite(value)) throw invalid('blocked server fields must be finite');
    copy[key] = value;
  }
  return Object.freeze(copy);
}

function freezeRecoveryGate(value) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) throw invalid('recovery gate is invalid');
  if (!RECOVERY_GATE_BASES.includes(value.basis)) throw invalid('recovery gate basis is invalid');
  if (typeof value.globalBlock !== 'boolean') throw invalid('recovery gate global block is invalid');
  const blockedServers = value.blockedServers ?? [];
  if (!Array.isArray(blockedServers) || blockedServers.length > MAX_BLOCKED_SERVERS) {
    throw invalid('recovery gate blocked servers are invalid');
  }
  return Object.freeze({
    basis: value.basis,
    globalBlock: value.globalBlock,
    blockedServers: Object.freeze(blockedServers.map(freezeBlockedServer))
  });
}

/**
 * Builds the frozen startup health model:
 * {status, modpackServices, legacyFallbacks, failure, recoveryGate, issues}.
 * A degraded start always names its failure and has modpack services
 * unavailable; any other status has neither.
 */
function createStartupHealth(input = {}) {
  if (!isPlainObject(input)) throw invalid('input is invalid');
  const {
    status = 'starting',
    modpackServices = 'pending',
    legacyFallbacks = 'inactive',
    failure = null,
    recoveryGate = null,
    issues = []
  } = input;
  if (!STARTUP_STATUSES.includes(status)) throw invalid('status is invalid');
  if (!MODPACK_SERVICE_STATES.includes(modpackServices)) throw invalid('modpack service state is invalid');
  if (!LEGACY_FALLBACK_STATES.includes(legacyFallbacks)) throw invalid('legacy fallback state is invalid');
  const degraded = status === 'degraded';
  if (degraded !== (failure !== null && failure !== undefined)) throw invalid('failure must accompany a degraded start only');
  if (degraded !== (modpackServices === 'unavailable')) throw invalid('modpack services are unavailable exactly when degraded');
  if (!Array.isArray(issues) || issues.length > MAX_STARTUP_ISSUES) throw invalid('issues are invalid');
  return Object.freeze({
    status,
    modpackServices,
    legacyFallbacks,
    failure: degraded ? freezeDescription(failure, 'failure') : null,
    recoveryGate: freezeRecoveryGate(recoveryGate),
    issues: Object.freeze(issues.map(issue => freezeDescription(issue, 'issue')))
  });
}

/**
 * Holds the live startup health for one process. Every change publishes a new
 * frozen snapshot; a degraded start is final and keeps its first failure.
 */
function createStartupHealthTracker({ userDataPath = null, workerPath = null, existsSync = fs.existsSync } = {}) {
  const context = { userDataPath, workerPath, existsSync };
  let current = createStartupHealth();
  const publish = changes => {
    current = createStartupHealth({ ...current, ...changes });
    return current;
  };
  return Object.freeze({
    snapshot() {
      return current;
    },
    markReady({ recoveryGate = current.recoveryGate } = {}) {
      if (current.status === 'degraded') return current;
      return publish({ status: 'ready', modpackServices: 'ready', recoveryGate });
    },
    markDegraded({ stage = null, error, recoveryGate = current.recoveryGate } = {}) {
      if (current.status === 'degraded') return current;
      return publish({
        status: 'degraded',
        modpackServices: 'unavailable',
        legacyFallbacks: 'active',
        failure: describeStartupFailure(error, { ...context, stage }),
        recoveryGate
      });
    },
    recordIssue(stage, error) {
      if (current.issues.length >= MAX_STARTUP_ISSUES) return current;
      return publish({ issues: [...current.issues, describeStartupFailure(error, { ...context, stage })] });
    }
  });
}

module.exports = {
  LEGACY_FALLBACK_STATES,
  MAX_STARTUP_ISSUES,
  MODPACK_SERVICE_STATES,
  RECOVERY_GATE_BASES,
  STARTUP_FAILURE_REASONS,
  STARTUP_STATUSES,
  createStartupHealth,
  createStartupHealthTracker,
  describeStartupFailure
};
