const crypto = require('node:crypto');
const path = require('node:path');

const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'Startup recovery dependencies are invalid', { cause });
}

function recoveryRequired(cause) {
  if (cause instanceof ModpackError && cause.code === 'RECOVERY_REQUIRED') return cause;
  return new ModpackError('RECOVERY_REQUIRED', 'Startup recovery could not establish a safe launch boundary', { cause });
}

function requireMethod(value, method) {
  if (!value || typeof value[method] !== 'function') throw invalid();
  return value;
}

function pathKey(value) {
  if (typeof value !== 'string' || (!path.isAbsolute(value) && !path.win32.isAbsolute(value))) throw invalid();
  return path.win32.normalize(value.replaceAll('/', '\\')).normalize('NFC').toLocaleLowerCase('en-US');
}

function targetPathHash(value) {
  return crypto.createHash('sha256').update(pathKey(value), 'utf8').digest('hex');
}

function selectorKey(selector) {
  return `${selector.instanceId || ''}\0${selector.serverPath ? pathKey(selector.serverPath) : ''}`;
}

function findRecordForBlock(scan, block) {
  const candidates = scan.records.filter(record => record?.jobId === block.jobId);
  if (candidates.length !== 1) return null;
  const record = candidates[0];
  const stableServerId = record.target?.stableServerId || null;
  const serverPath = record.target?.path || null;
  if (block.stableServerId && stableServerId !== block.stableServerId) return null;
  if (serverPath && block.targetPathHash && targetPathHash(serverPath) !== block.targetPathHash) return null;
  return record;
}

function mapScanBlocks(scan) {
  if (!scan || typeof scan !== 'object' || !Array.isArray(scan.records) || !Array.isArray(scan.corrupt) ||
      !Array.isArray(scan.blocks) || typeof scan.globalBlock !== 'boolean') throw invalid();
  const mapped = [];
  let requiresGlobalBlock = scan.globalBlock;
  const selectorOwners = new Map();
  for (const block of scan.blocks) {
    if (!block || typeof block !== 'object' || typeof block.jobId !== 'string') {
      requiresGlobalBlock = true;
      continue;
    }
    const record = findRecordForBlock(scan, block);
    const instanceId = record?.target?.stableServerId || block.stableServerId || null;
    const serverPath = record?.target?.path || null;
    if (!instanceId && !serverPath) {
      requiresGlobalBlock = true;
      continue;
    }
    const selector = Object.freeze({
      ...(instanceId ? { instanceId } : {}),
      ...(serverPath ? { serverPath } : {})
    });
    const key = selectorKey(selector);
    const owner = selectorOwners.get(key);
    if (owner && owner !== block.jobId) {
      requiresGlobalBlock = true;
      continue;
    }
    selectorOwners.set(key, block.jobId);
    if (!mapped.some(item => item.operationId === block.jobId && selectorKey(item.selector) === key)) {
      mapped.push(Object.freeze({ operationId: block.jobId, selector }));
    }
  }
  return Object.freeze({ blocks: Object.freeze(mapped), requiresGlobalBlock });
}

async function verifyRuntime(runtimeVerifier) {
  const result = typeof runtimeVerifier === 'function'
    ? await runtimeVerifier()
    : await requireMethod(runtimeVerifier, 'verifyBeforeRecovery').verifyBeforeRecovery();
  if (!result || typeof result !== 'object' || result.quiescent !== true) throw recoveryRequired();
  return result;
}

async function initializeStartupRecovery({ coordinator, registry, recoveryService, runtimeVerifier } = {}) {
  requireMethod(coordinator, 'beginStartupRecovery');
  requireMethod(coordinator, 'installRecoveryBlocks');
  requireMethod(coordinator, 'completeStartupRecovery');
  requireMethod(registry, 'initialize');
  requireMethod(recoveryService, 'recoverAll');
  if (!runtimeVerifier) throw invalid();

  coordinator.beginStartupRecovery();
  await verifyRuntime(runtimeVerifier);
  const initialScan = await registry.initialize();
  const initialMapping = mapScanBlocks(initialScan);
  if (initialMapping.blocks.length > 0) coordinator.installRecoveryBlocks(initialMapping.blocks);
  const recoveryResult = await recoveryService.recoverAll(initialScan);
  if (!recoveryResult || !Array.isArray(recoveryResult.recovered) || !Array.isArray(recoveryResult.unresolved)) {
    throw recoveryRequired();
  }

  const finalScan = await registry.initialize();
  const finalMapping = mapScanBlocks(finalScan);
  const installed = new Map();
  for (const item of initialMapping.blocks) installed.set(`${item.operationId}\0${selectorKey(item.selector)}`, item);
  const newlyDiscovered = [];
  for (const item of finalMapping.blocks) {
    const key = `${item.operationId}\0${selectorKey(item.selector)}`;
    if (!installed.has(key)) {
      installed.set(key, item);
      newlyDiscovered.push(item);
    }
  }
  if (newlyDiscovered.length > 0) coordinator.installRecoveryBlocks(newlyDiscovered);

  const unresolvedKeys = new Set(finalMapping.blocks.map(item => `${item.operationId}\0${selectorKey(item.selector)}`));
  const outcomes = [...installed].map(([key, item]) => Object.freeze({
    selector: item.selector,
    resolved: !unresolvedKeys.has(key)
  }));
  const globalBlock = Boolean(initialMapping.requiresGlobalBlock || finalMapping.requiresGlobalBlock);
  coordinator.completeStartupRecovery(outcomes, { globalBlock });

  const unresolved = [...new Set([
    ...finalScan.blocks.map(block => block.jobId).filter(value => typeof value === 'string'),
    ...finalScan.corrupt.map(item => item.jobId).filter(value => typeof value === 'string'),
    ...recoveryResult.unresolved.filter(value => typeof value === 'string' &&
      finalScan.blocks.some(block => block.jobId === value))
  ])].sort((left, right) => left.localeCompare(right, 'en-US'));
  const recovered = [...new Set(recoveryResult.recovered.filter(value =>
    typeof value === 'string' && !unresolved.includes(value)))].sort((left, right) => left.localeCompare(right, 'en-US'));
  return deepFreeze({ recovered, unresolved, globalBlock });
}

module.exports = {
  initializeStartupRecovery,
  mapScanBlocks
};
