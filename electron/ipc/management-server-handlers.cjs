// Management server IPC handlers
const { getManagementServer } = require('../services/management-server.cjs');
const appStore = require('../utils/app-store.cjs');
const { ensureEncryptionAvailable, packSecret, unpackSecret } = require('../utils/secure-store.cjs');
const { getManagementTlsConfig } = require('../utils/tls-utils.cjs');
const { randomBytes } = require('crypto');
const {
  getDefaultServerConfig,
  readServerConfig,
  updateServerConfig
} = require('../utils/config-manager.cjs');

function getServerInstances() {
  return appStore.get('instances') || [];
}

function findServerInstanceByPath(serverPath) {
  if (!serverPath) return null;
  const instances = getServerInstances();
  return instances.find((inst) => inst && inst.type === 'server' && inst.path === serverPath) || null;
}

function updateServerInstance(serverPath, updates) {
  const instances = getServerInstances();
  const idx = instances.findIndex((inst) => inst && inst.type === 'server' && inst.path === serverPath);
  if (idx === -1) return null;
  const updated = { ...instances[idx], ...updates };
  instances[idx] = updated;
  appStore.set('instances', instances);
  return updated;
}

function generateInviteSecret() {
  return randomBytes(24).toString('base64url');
}

function getServerConfigDefaults() {
  const settings = appStore.get('serverSettings') || {};
  return getDefaultServerConfig({
    managementPort: settings.managementPort || 8080
  });
}

function readPortableServerConfig(serverPath) {
  if (!serverPath) return null;
  return readServerConfig(serverPath, getServerConfigDefaults());
}

function persistInviteMetadata(serverPath, { host, secret }) {
  if (!serverPath) return null;
  return updateServerConfig(serverPath, {
    managementInviteHost: typeof host === 'string' ? host : undefined,
    managementInviteSecret: typeof secret === 'string' ? secret : undefined
  }, getServerConfigDefaults());
}

function getConfiguredInviteHost(serverPath, instance = null) {
  const config = readPortableServerConfig(serverPath);
  if (config && typeof config.managementInviteHost === 'string' && config.managementInviteHost.trim()) {
    return config.managementInviteHost.trim();
  }
  if (instance && typeof instance.managementInviteHost === 'string' && instance.managementInviteHost.trim()) {
    const trimmed = instance.managementInviteHost.trim();
    persistInviteMetadata(serverPath, { host: trimmed });
    return trimmed;
  }
  return '';
}

function getManagementPortForServer(serverPath) {
  const status = getManagementServer().getStatus ? getManagementServer().getStatus() : null;
  const runningPort = status && status.port ? Number.parseInt(String(status.port), 10) : NaN;
  if (Number.isFinite(runningPort)) {
    return runningPort;
  }

  const config = readPortableServerConfig(serverPath);
  if (config && Number.isFinite(Number(config.managementPort))) {
    return Number(config.managementPort);
  }

  const settings = appStore.get('serverSettings') || {};
  const settingsPort = settings.managementPort ? Number.parseInt(String(settings.managementPort), 10) : NaN;
  return Number.isFinite(settingsPort) ? settingsPort : 8080;
}

function ensureInviteSecret(serverPath) {
  ensureEncryptionAvailable();
  const instance = findServerInstanceByPath(serverPath);
  const config = readPortableServerConfig(serverPath);
  if (!instance && !config) return { instance: null, secret: '' };
  let secret = '';
  if (config && typeof config.managementInviteSecret === 'string' && config.managementInviteSecret.trim()) {
    secret = config.managementInviteSecret.trim();
  }
  if (!secret && instance && instance.managementInviteSecret) {
    try {
      secret = unpackSecret(instance.managementInviteSecret);
    } catch {
      secret = '';
    }
  }
  if (!secret) {
    secret = generateInviteSecret();
  }
  if (serverPath) {
    persistInviteMetadata(serverPath, {
      host: getConfiguredInviteHost(serverPath, instance),
      secret
    });
  }
  if (instance) {
    updateServerInstance(serverPath, {
      managementInviteSecret: packSecret(secret),
      managementInviteHost: getConfiguredInviteHost(serverPath, instance)
    });
  }
  return { instance: findServerInstanceByPath(serverPath), secret };
}

function isPrivateIp(host) {
  if (!host || typeof host !== 'string') return false;
  const value = host.trim();
  if (value.startsWith('10.')) return true;
  if (value.startsWith('192.168.')) return true;
  const match = value.match(/^172\.(\d+)\./);
  if (match) {
    const octet = Number(match[1]);
    return octet >= 16 && octet <= 31;
  }
  return false;
}

/**
 * Create management server IPC handlers
 * 
 * @param {object} win - The main application window
 * @returns {Object.<string, Function>} Object with channel names as keys and handler functions as values
 */
function createManagementServerHandlers(win) {
  const managementServer = getManagementServer();
  
  return {
    // Start the management server
    'start-management-server': async (_event, { port = 8080, serverPath }) => {
      try {
        const targetPath = serverPath || appStore.get('lastServerPath');
        const { instance, secret } = ensureInviteSecret(targetPath);
        if (secret) {
          managementServer.setInviteSecret(secret);
        }
        const configuredHost = getConfiguredInviteHost(targetPath, instance);
        managementServer.setExternalHost(configuredHost || null);

        const result = await managementServer.start(port, targetPath);
        
        if (result.success) {
          
          // Notify renderer about server status
          if (win && win.webContents) {
            win.webContents.send('management-server-status', {
              isRunning: true,
              port: result.port,
              serverPath: targetPath
            });
          }
        }
        
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
      // Stop the management server
    'stop-management-server': async () => {
      try {
        const result = await managementServer.stop();
        
        // Notify renderer about server status when stopped, even if forced/timeout
        if (win && win.webContents && (result.success || result.forced)) {
          win.webContents.send('management-server-status', {
            isRunning: false,
            port: null,
            serverPath: null,
            forced: !!result.forced,
            reason: result.reason || undefined
          });
        }
        
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
      // Get management server status
    'get-management-server-status': async () => {
      try {
        const status = managementServer.getStatus();
        return { success: true, status };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    // Update server path
    'update-management-server-path': async (_event, serverPath) => {
      try {
        const targetPath = serverPath || null;
        const { instance, secret } = ensureInviteSecret(targetPath);
        if (secret) {
          managementServer.setInviteSecret(secret);
        }
        const configuredHost = getConfiguredInviteHost(targetPath, instance);
        managementServer.setExternalHost(configuredHost || null);
        managementServer.updateServerPath(targetPath);
        
        // Notify renderer about path update
        if (win && win.webContents) {
          win.webContents.send('management-server-path-updated', targetPath);
        }
        
        return { success: true, serverPath: targetPath };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Set external host for mod downloads
    'set-management-server-external-host': async (_event, payload = {}) => {
      try {
        const hostIP = typeof payload === 'string' ? payload : payload?.hostIP;
        const serverPath = typeof payload === 'object' && payload ? payload.serverPath : undefined;
        const targetPath = serverPath || appStore.get('lastServerPath');
        const host = typeof hostIP === 'string' ? hostIP.trim() : '';
        if (targetPath) {
          updateServerInstance(targetPath, { managementInviteHost: host || '' });
          persistInviteMetadata(targetPath, { host: host || '' });
        }
        managementServer.setExternalHost(host || null);
        
        return { 
          success: true, 
          externalHost: host || null,
          downloadHost: managementServer.getModDownloadHost()
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Get current external host info
    'get-management-server-host-info': async () => {
      try {
        await managementServer.refreshPublicHostIfStale();
        return { 
          success: true, 
          downloadHost: managementServer.getModDownloadHost(),
          externalHost: managementServer.externalHost,
          publicHost: managementServer.publicHost,
          configuredHost: managementServer.configuredHost,
          detectedPublicHost: managementServer.detectedPublicHost,
          protocol: managementServer.useHttps ? 'https' : 'http'
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Get invite link information for the current server instance
    'get-management-invite-info': async (_event, { serverPath, port } = {}) => {
      try {
        const targetPath = serverPath || appStore.get('lastServerPath');
        if (!targetPath) {
          return { success: false, error: 'No server path available' };
        }
        const { instance, secret } = ensureInviteSecret(targetPath);
        if (!instance) {
          return { success: false, error: 'Server instance not found' };
        }

        await managementServer.refreshPublicHostIfStale();
        let fingerprint = '';
        try {
          const tlsConfig = await getManagementTlsConfig(targetPath);
          fingerprint = tlsConfig && tlsConfig.fingerprint ? tlsConfig.fingerprint : '';
        } catch {
          fingerprint = '';
        }
        const configuredHost = getConfiguredInviteHost(targetPath, instance);
        const publicHost = managementServer.publicHost;
        const fallbackHost = managementServer.detectExternalIP() || 'localhost';
        const host = configuredHost || publicHost || fallbackHost;
        const hostSource = configuredHost ? 'configured' : publicHost ? 'public' : 'local';
        const protocol = managementServer.useHttps ? 'https' : 'http';
        const requestedPort = typeof port === 'number' ? port : Number.parseInt(port, 10);
        const configuredPort = getManagementPortForServer(targetPath);
        const portValue = Number.isFinite(requestedPort) ? Number(requestedPort) : configuredPort;
        const fpParam = fingerprint ? `&fp=${encodeURIComponent(fingerprint)}` : '';
        const inviteLink = `${protocol}://${host}:${portValue}/?secret=${encodeURIComponent(secret)}${fpParam}`;
        const usesPublicHost = hostSource === 'public' && !isPrivateIp(host);

        return {
          success: true,
          inviteLink,
          host,
          port: portValue,
          protocol,
          secret,
          fingerprint,
          configuredHost,
          publicHost,
          hostSource,
          usesPublicHost
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Update the configured invite host for a server instance
    'set-management-invite-host': async (_event, { serverPath, host }) => {
      try {
        const targetPath = serverPath || appStore.get('lastServerPath');
        if (!targetPath) {
          return { success: false, error: 'No server path available' };
        }
        const trimmed = typeof host === 'string' ? host.trim() : '';
        updateServerInstance(targetPath, { managementInviteHost: trimmed || '' });
        persistInviteMetadata(targetPath, { host: trimmed || '' });
        managementServer.setExternalHost(trimmed || null);
        return { success: true, host: trimmed || null };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Regenerate the invite secret for a server instance
    'regenerate-management-invite-secret': async (_event, { serverPath } = {}) => {
      try {
        const targetPath = serverPath || appStore.get('lastServerPath');
        if (!targetPath) {
          return { success: false, error: 'No server path available' };
        }
        ensureEncryptionAvailable();
        const secret = generateInviteSecret();
        updateServerInstance(targetPath, { managementInviteSecret: packSecret(secret) });
        persistInviteMetadata(targetPath, {
          host: getConfiguredInviteHost(targetPath, findServerInstanceByPath(targetPath)),
          secret
        });
        managementServer.setInviteSecret(secret);
        return { success: true, secret };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  };
}

module.exports = { createManagementServerHandlers };
