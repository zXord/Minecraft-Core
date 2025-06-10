const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const nbt = require('prismarine-nbt');
const zlib = require('zlib');

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
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function ensureServersDat(
  clientDir,
  serverIp,
  managementPort,
  serverName = 'Minecraft Server',
  minecraftPortOverride = null
) {
  try {
    let minecraftPort = minecraftPortOverride || 25565;

    if (!minecraftPortOverride && managementPort) {
      const infoRes = await fetch(
        `http://${serverIp}:${managementPort}/api/server/info`,
        { timeout: 5000 }
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

  const optionsFile = path.join(clientDir, 'options.txt');
    let optionsContent = '';
    if (fs.existsSync(optionsFile)) {
      optionsContent = fs.readFileSync(optionsFile, 'utf8');
    }
    const lines = optionsContent.split('\n').filter(l => !l.startsWith('lastServer:'));
    lines.push(`lastServer:${serverAddress}`);
    fs.writeFileSync(optionsFile, lines.join('\n'), 'utf8');

  const serversDatPath = path.join(clientDir, 'servers.dat');
    let existingServers = [];
    if (fs.existsSync(serversDatPath)) {
      try {
        const buf = fs.readFileSync(serversDatPath);
        const uncompressed = zlib.gunzipSync(buf);
        const parsed = await nbt.parse(uncompressed);
        const list = (parsed.parsed.value.servers?.value || []) ;
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
