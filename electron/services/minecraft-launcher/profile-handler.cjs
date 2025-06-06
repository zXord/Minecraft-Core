const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { spawn } = require('child_process');
const { downloadFile } = require('./network-utils.cjs');
const { safeAsync } = require('./error-helpers.cjs');

async function installFabricLoader(javaManager, clientPath, minecraftVersion, fabricVersion = 'latest', emitter) {
  try {
    const installerUrl = 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/0.11.2/fabric-installer-0.11.2.jar';
    const installerPath = path.join(clientPath, 'fabric-installer.jar');
    if (!fs.existsSync(installerPath)) {
      await downloadFile(installerUrl, installerPath);
    }
    let loaderVersion = fabricVersion;
    if (fabricVersion === 'latest') {
      try {
        const response = await fetch('https://meta.fabricmc.net/v2/versions/loader');
        const loaders = await response.json();
        loaderVersion = loaders[0].version;
      } catch {
        loaderVersion = '0.14.21';
      }
    }
    const result = await javaManager.ensureJava(javaManager.getRequiredJavaVersion ? javaManager.getRequiredJavaVersion(minecraftVersion) : 17);
    if (!result.success) throw new Error(result.error);
    const javaExe = result.javaPath;
    const installer = spawn(javaExe, ['-jar', installerPath, 'client', '-mcversion', minecraftVersion, '-loader', loaderVersion, '-dir', clientPath]);
    await new Promise((resolve, reject) => {
      installer.on('close', code => code === 0 ? resolve() : reject(new Error(`installer exited ${code}`)));
    });
    fs.unlinkSync(installerPath);
    return { success: true, profileName: `fabric-loader-${loaderVersion}-${minecraftVersion}`, loaderVersion };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function injectVanillaDownloads(clientPath, profileName, vanillaVersion) {
  try {
    const versionsDir = path.join(clientPath, 'versions');
    const fabricPath = path.join(versionsDir, profileName, `${profileName}.json`);
    const vanillaPath = path.join(versionsDir, vanillaVersion, `${vanillaVersion}.json`);
    const fabricJson = JSON.parse(fs.readFileSync(fabricPath, 'utf8'));
    const vanillaJson = JSON.parse(fs.readFileSync(vanillaPath, 'utf8'));
    let modified = false;
    if (!fabricJson.downloads?.client && vanillaJson.downloads?.client) {
      fabricJson.downloads = fabricJson.downloads || {};
      fabricJson.downloads.client = vanillaJson.downloads.client;
      modified = true;
    }
    if (!fabricJson.inheritsFrom) {
      fabricJson.inheritsFrom = vanillaVersion;
      modified = true;
    }
    if (fabricJson.type !== 'release') {
      fabricJson.type = 'release';
      modified = true;
    }
    if (modified) fs.writeFileSync(fabricPath, JSON.stringify(fabricJson, null, 2));
    return { success: true, modified };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function enrichFabricJson(clientPath, fabricProfileName) {
  try {
    const jsonPath = path.join(clientPath, 'versions', fabricProfileName, `${fabricProfileName}.json`);
    const fabricJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    fabricJson.arguments = fabricJson.arguments || { game: [], jvm: [] };
    const authArg = '--username';
    if (!fabricJson.arguments.game.includes(authArg)) {
      fabricJson.arguments.game.unshift(authArg, '${auth_player_name}');
    }
    fs.writeFileSync(jsonPath, JSON.stringify(fabricJson, null, 2));
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = { installFabricLoader, injectVanillaDownloads, enrichFabricJson };
