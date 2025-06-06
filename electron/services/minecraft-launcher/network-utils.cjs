const fs = require('fs');
const http = require('http');
const https = require('https');

function protocol(url) {
  return url.startsWith('https') ? https : http;
}

async function downloadJson(url, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await _downloadJsonSingle(url);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }
}

function _downloadJsonSingle(url) {
  return new Promise((resolve, reject) => {
    const req = protocol(url).get(url, { timeout: 15000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(_downloadJsonSingle(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('JSON download timeout')); });
    req.on('error', reject);
  });
}

async function downloadFile(url, filePath, maxRetries = 3, progressCallback = null) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await _downloadFileSingle(url, filePath, progressCallback);
      return;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }
}

function _downloadFileSingle(url, filePath, progressCallback) {
  return new Promise((resolve, reject) => {
    const proto = protocol(url);
    const file = fs.createWriteStream(filePath);
    const req = proto.get(url, { timeout: 60000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(filePath, () => {});
        return resolve(_downloadFileSingle(res.headers.location, filePath, progressCallback));
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(filePath, () => {});
        return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      res.on('data', chunk => {
        downloaded += chunk.length;
        if (progressCallback && total > 0) progressCallback(downloaded / total);
      });
      res.pipe(file);
    });
    req.on('error', err => { file.close(); fs.unlink(filePath, () => {}); reject(err); });
    req.on('timeout', () => { file.close(); fs.unlink(filePath, () => {}); reject(new Error('Download timeout')); });
    file.on('finish', () => resolve(fs.statSync(filePath).size));
  });
}

module.exports = { downloadJson, downloadFile };
