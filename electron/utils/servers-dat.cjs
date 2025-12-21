const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const nbt = require('prismarine-nbt');
const zlib = require('zlib');
const { getManagementHttpsAgent, getPinnedHttpsAgent } = require('./tls-utils.cjs');

/**
 * Create or update the servers.dat and options.txt files so the given server
 * appears in Minecraft's multiplayer list and is set as the last server.
 *
 * @param {string} clientDir - Path to the Minecraft client directory
 * @param {string} serverIp - Server IP address (used for management and game)
 * @param {number|string} managementPort - Management server port
 * @param {string} serverName - Name to display in the multiplayer list
 * @param {number|string} [minecraftPortOverride] - Optional Minecraft server port
 *   If not provided, the function will attempt to retrieve it from the
 *   management server's /api/server/info endpoint.
 * @param {boolean} [preserveExistingServers] - If true, only creates server entry if it doesn't exist, preserving user modifications
 * @param {string|null} [sessionToken] - Optional management server session token
 * @param {string} [managementProtocol] - Optional management server protocol (http/https)
 * @param {string|null} [managementCertFingerprint] - Optional pinned TLS fingerprint
 * @returns {Promise<{success: boolean, error?: string, preserved?: boolean}>}
 */
async function ensureServersDat(
  clientDir,
  serverIp,
  managementPort,
  serverName = 'Minecraft Server',
  minecraftPortOverride = null,
  preserveExistingServers = false,
  sessionToken = null,
  managementProtocol = 'https',
  managementCertFingerprint = null
) {
  try {
    let minecraftPort = minecraftPortOverride || 25565;

    if (!minecraftPortOverride && managementPort) {
      const protocol = managementProtocol === 'http' ? 'http' : 'https';
      let agent;
      if (protocol === 'https') {
        try {
          if (managementCertFingerprint) {
            agent = await getPinnedHttpsAgent(serverIp, managementPort, managementCertFingerprint);
          }
        } catch {
          agent = undefined;
        }
        if (!agent) {
          agent = await getManagementHttpsAgent();
        }
      }
      const infoRes = await fetch(
        `${protocol}://${serverIp}:${managementPort}/api/server/info`,
        {
          timeout: 5000,
          headers: sessionToken ? { 'X-Session-Token': sessionToken } : undefined,
          agent
        }
      ).catch(() => null);
      if (infoRes?.ok) {
        const info = await infoRes.json();
        if (info.minecraftPort) {
          const portNum = parseInt(info.minecraftPort, 10);
          if (!Number.isNaN(portNum)) minecraftPort = portNum;
        }
      }
    }

    if (!fs.existsSync(clientDir)) {
      fs.mkdirSync(clientDir, { recursive: true });
    }

    const serverAddress =
      minecraftPort === 25565 ? serverIp : `${serverIp}:${minecraftPort}`;

    // Always update options.txt with the current server as lastServer
    const optionsFile = path.join(clientDir, 'options.txt');
    let optionsContent = '';
    if (fs.existsSync(optionsFile)) {
      optionsContent = fs.readFileSync(optionsFile, 'utf8');
    }
    const lines = optionsContent.split('\n').filter(l => !l.startsWith('lastServer:'));
    lines.push(`lastServer:${serverAddress}`);
    fs.writeFileSync(optionsFile, lines.join('\n'), 'utf8');

    const serversDatPath = path.join(clientDir, 'servers.dat');
    
    // If preserveExistingServers is true, check if servers.dat exists and has any server entries
    if (preserveExistingServers && fs.existsSync(serversDatPath)) {
      try {
        const buf = fs.readFileSync(serversDatPath);
        const uncompressed = zlib.gunzipSync(buf);
        const parsed = await nbt.parse(uncompressed);
        const list = (parsed.parsed.value.servers?.value || []);
        
        // If there are any existing servers, don't modify servers.dat
        // This preserves user modifications including changed ports
        if (Array.isArray(list) && list.length > 0) {
          return { success: true, preserved: true };
        }
      } catch {
        // If we can't read the existing file, fall through to create a new one
      }
    }

    // Create or update servers.dat (only when preserveExistingServers is false, or no existing servers found)
    let existingServers = [];
    if (fs.existsSync(serversDatPath)) {
      try {
        const buf = fs.readFileSync(serversDatPath);
        const uncompressed = zlib.gunzipSync(buf);
        const parsed = await nbt.parse(uncompressed);
        const list = (parsed.parsed.value.servers?.value || []);
        existingServers = /** @type {any[]} */(list).map(entry =>
          entry.value
            ? {
                name: entry.value.name.value,
                ip: entry.value.ip.value,
                icon: entry.value.icon.value,
                acceptTextures: entry.value.acceptTextures.value,
              }
            : entry
        );
        existingServers = existingServers.filter(s => s.ip !== serverAddress);
      } catch {
        existingServers = [];
      }
    }

    existingServers.push({
      name: serverName,
      ip: serverAddress,
      icon: '',
      acceptTextures: 1,
    });

    const nbtServers = existingServers.map((s) => ({
      name: nbt.string(s.name),
      ip: nbt.string(s.ip),
      icon: nbt.string(s.icon),
      acceptTextures: nbt.byte(s.acceptTextures)
    }));

    const nbtData = nbt.comp({
      servers: nbt.list(nbt.comp(nbtServers))
    });
    const raw = nbt.writeUncompressed(/** @type {any} */(nbtData));
    fs.writeFileSync(serversDatPath, raw);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { ensureServersDat };
