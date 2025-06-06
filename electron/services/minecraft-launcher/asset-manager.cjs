const fs = require('fs');
const path = require('path');
const { downloadFile } = require('./network-utils.cjs');

async function downloadAssets(clientPath, minecraftVersion, emitter) {
  try {
    const versionJsonPath = path.join(clientPath, 'versions', minecraftVersion, `${minecraftVersion}.json`);
    if (!fs.existsSync(versionJsonPath)) {
      throw new Error(`Version JSON not found: ${versionJsonPath}`);
    }

    const versionJson = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
    if (!versionJson.assetIndex) {
      throw new Error(`Version JSON missing assetIndex: ${versionJsonPath}`);
    }

    const assetIndex = versionJson.assetIndex;
    const indexDir = path.join(clientPath, 'assets', 'indexes');
    const objectsDir = path.join(clientPath, 'assets', 'objects');
    fs.mkdirSync(indexDir, { recursive: true });
    fs.mkdirSync(objectsDir, { recursive: true });

    const indexPath = path.join(indexDir, `${assetIndex.id}.json`);
    await downloadFile(assetIndex.url, indexPath);
    const indexJson = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (!indexJson.objects) throw new Error('Malformed asset index');

    const totalAssets = Object.keys(indexJson.objects).length;
    let processed = 0;
    let downloaded = 0;
    const update = () => {
      if (emitter) {
        emitter.emit('client-download-progress', {
          type: 'Assets',
          task: `Downloading game assets... ${processed}/${totalAssets}`,
          total: totalAssets,
          current: processed
        });
      }
    };

    for (const [relPath, meta] of Object.entries(indexJson.objects)) {
      const hash = meta.hash;
      const twoChar = hash.substring(0, 2);
      const destDir = path.join(objectsDir, twoChar);
      const destFile = path.join(destDir, hash);
      fs.mkdirSync(destDir, { recursive: true });
      if (fs.existsSync(destFile)) {
        const stats = fs.statSync(destFile);
        if (stats.size === meta.size) { processed++; continue; }
      }
      await downloadFile(`https://resources.download.minecraft.net/${twoChar}/${hash}`, destFile);
      downloaded++; processed++; update();
    }
    update();
    return { success: true, downloaded, skipped: totalAssets - downloaded, total: totalAssets };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function clearAssets(clientPath) {
  try {
    const assetsDir = path.join(clientPath, 'assets');
    if (fs.existsSync(assetsDir)) {
      fs.rmSync(assetsDir, { recursive: true, force: true });
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = { downloadAssets, clearAssets };
