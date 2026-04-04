const net = require('net');
const { execFile } = require('child_process');
const appStore = require('./app-store.cjs');
const { readServerConfig, getDefaultServerConfig } = require('./config-manager.cjs');

let logger = null;
function getLogger() {
  if (!logger) {
    try {
      const { getLoggerHandlers } = require('../ipc/logger-handlers.cjs');
      logger = getLoggerHandlers();
    } catch {
      logger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {}
      };
    }
  }
  return logger;
}

function toNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getSavedServerPort(instance) {
  if (!instance || instance.type !== 'server' || !instance.path) {
    return null;
  }

  try {
    const config = readServerConfig(instance.path, getDefaultServerConfig()) || {};
    return {
      minecraftPort: toNumber(config.port, 25565),
      managementPort: toNumber(config.managementPort, 8080)
    };
  } catch {
    return {
      minecraftPort: 25565,
      managementPort: 8080
    };
  }
}

function normalizeConflictInstance(instance) {
  return {
    id: instance.id || null,
    name: instance.name || 'Unnamed Instance',
    path: instance.path || null
  };
}

function getPortConflictMessage(kind, port, conflictingInstance) {
  const label = kind === 'management' ? 'Management port' : 'Minecraft port';
  if (conflictingInstance) {
    return `${label} ${port} is already used by "${conflictingInstance.name}".`;
  }
  return `${label} ${port} is already in use.`;
}

function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function lookupWindowsProcessName(pid) {
  if (!pid) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const firstLine = String(stdout || '').split(/\r?\n/).find((line) => line.trim());
    if (!firstLine || firstLine.startsWith('INFO:')) {
      return null;
    }

    const columns = firstLine
      .trim()
      .replace(/^"|"$/g, '')
      .split('","');

    return columns[0] || null;
  } catch {
    return null;
  }
}

async function findListeningProcess(port) {
  if (process.platform !== 'win32' || !Number.isFinite(port)) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp']);
    const lines = String(stdout || '').split(/\r?\n/);

    for (const line of lines) {
      if (!line.includes('LISTENING') || !line.includes(`:${port}`)) {
        continue;
      }

      const columns = line.trim().split(/\s+/);
      const localAddress = columns[1] || '';
      const pidText = columns[4] || '';
      if (!localAddress.endsWith(`:${port}`)) {
        continue;
      }

      const pid = Number.parseInt(pidText, 10);
      if (!Number.isFinite(pid)) {
        continue;
      }

      const processName = await lookupWindowsProcessName(pid);
      return {
        pid,
        processName
      };
    }
  } catch {
    return null;
  }

  return null;
}

async function probePortAvailability(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (error) => {
      resolve({
        available: false,
        code: error && error.code ? error.code : 'UNKNOWN'
      });
    });

    server.once('listening', () => {
      server.close(() => resolve({ available: true, code: null }));
    });

    try {
      server.listen(port, host);
    } catch (error) {
      resolve({
        available: false,
        code: error && error.code ? error.code : 'UNKNOWN'
      });
    }
  });
}

async function validateServerPorts(options = {}) {
  const loggerInstance = getLogger();
  const {
    instanceId = null,
    serverPath = null,
    minecraftPort = null,
    managementPort = null,
    includeExternalCheck = true
  } = options;

  const normalizedMinecraftPort = toNumber(minecraftPort, null);
  const normalizedManagementPort = toNumber(managementPort, null);
  const errors = [];

  const instances = (appStore.get('instances') || []).filter((instance) =>
    instance && instance.type === 'server' && instance.path
  );

  for (const instance of instances) {
    const sameInstance = (instanceId && instance.id === instanceId)
      || (serverPath && instance.path === serverPath);

    if (sameInstance) {
      continue;
    }

    const ports = getSavedServerPort(instance);
    const conflictInstance = normalizeConflictInstance(instance);

    if (normalizedMinecraftPort && ports.minecraftPort === normalizedMinecraftPort) {
      errors.push({
        type: 'minecraft',
        scope: 'internal',
        port: normalizedMinecraftPort,
        conflictingInstance: conflictInstance,
        message: getPortConflictMessage('minecraft', normalizedMinecraftPort, conflictInstance)
      });
    }

    if (normalizedManagementPort && ports.managementPort === normalizedManagementPort) {
      errors.push({
        type: 'management',
        scope: 'internal',
        port: normalizedManagementPort,
        conflictingInstance: conflictInstance,
        message: getPortConflictMessage('management', normalizedManagementPort, conflictInstance)
      });
    }
  }

  if (includeExternalCheck) {
    if (normalizedMinecraftPort && !errors.some((error) => error.type === 'minecraft' && error.scope === 'internal')) {
      const probe = await probePortAvailability(normalizedMinecraftPort);
      if (!probe.available) {
        const processInfo = await findListeningProcess(normalizedMinecraftPort);
        errors.push({
          type: 'minecraft',
          scope: 'external',
          port: normalizedMinecraftPort,
          code: probe.code,
          process: processInfo,
          message: processInfo?.processName
            ? `Minecraft port ${normalizedMinecraftPort} is already occupied by ${processInfo.processName} (PID ${processInfo.pid}).`
            : processInfo?.pid
              ? `Minecraft port ${normalizedMinecraftPort} is already occupied by another process (PID ${processInfo.pid}).`
              : `Minecraft port ${normalizedMinecraftPort} is already occupied by another process.`
        });
      }
    }

    if (normalizedManagementPort && !errors.some((error) => error.type === 'management' && error.scope === 'internal')) {
      const probe = await probePortAvailability(normalizedManagementPort);
      if (!probe.available) {
        const processInfo = await findListeningProcess(normalizedManagementPort);
        errors.push({
          type: 'management',
          scope: 'external',
          port: normalizedManagementPort,
          code: probe.code,
          process: processInfo,
          message: processInfo?.processName
            ? `Management port ${normalizedManagementPort} is already occupied by ${processInfo.processName} (PID ${processInfo.pid}).`
            : processInfo?.pid
              ? `Management port ${normalizedManagementPort} is already occupied by another process (PID ${processInfo.pid}).`
              : `Management port ${normalizedManagementPort} is already occupied by another process.`
        });
      }
    }
  }

  loggerInstance.debug('Server port validation completed', {
    category: 'settings',
    data: {
      service: 'PortValidator',
      operation: 'validateServerPorts',
      instanceId,
      serverPath,
      minecraftPort: normalizedMinecraftPort,
      managementPort: normalizedManagementPort,
      valid: errors.length === 0,
      errors
    }
  });

  return {
    valid: errors.length === 0,
    errors
  };
}

async function assertNoServerPortConflicts(options = {}) {
  const validation = await validateServerPorts(options);
  if (!validation.valid) {
    const error = new Error(validation.errors[0].message);
    error.code = 'PORT_CONFLICT';
    error.details = validation.errors;
    throw error;
  }
  return validation;
}

module.exports = {
  probePortAvailability,
  validateServerPorts,
  assertNoServerPortConflicts
};
