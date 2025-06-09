/**
 * Utility functions to fetch the latest Minecraft and Fabric versions
 */

/**
 * Fetch the latest stable Minecraft version from Fabric's meta API
 * @returns {Promise<string|null>} latest version or null on failure
 */
export async function fetchLatestMinecraftVersion() {
  try {
    const res = await fetch('https://meta.fabricmc.net/v2/versions/game');
    if (!res.ok) {
      throw new Error(`Status ${res.status}`);
    }
    const data = await res.json();    const stable = data.find(v => v.stable);
    return stable ? stable.version : (data[0]?.version ?? null);
  } catch {
    return null;
  }
}

/**
 * Fetch the latest Fabric loader version for a given Minecraft version
 * @param {string} mcVersion - Minecraft version to check
 * @returns {Promise<string|null>} latest loader version or null on failure
 */
export async function fetchLatestFabricVersion(mcVersion) {
  if (!mcVersion) return null;
  try {
    const res = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`);
    if (!res.ok) {
      throw new Error(`Status ${res.status}`);
    }    const data = await res.json();
    return data.length > 0 ? data[0].loader.version : null;
  } catch {
    return null;
  }
}

/**
 * Fetch all Fabric loader versions for a given Minecraft version
 * @param {string} mcVersion - Minecraft version to check
 * @returns {Promise<string[]>} array of loader versions (may include unstable releases)
 */
export async function fetchAllFabricVersions(mcVersion) {
  if (!mcVersion) return [];
  try {
    const res = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}?limit=1000`);
    if (!res.ok) {
      throw new Error(`Status ${res.status}`);
    }
    const data = await res.json();    return data.map(v => v.loader.version);
  } catch {
    return [];
  }
}
