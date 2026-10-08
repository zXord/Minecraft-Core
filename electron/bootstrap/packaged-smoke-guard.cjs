function isPublicHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function createPackagedSmokeGuard({ app } = {}) {
  if (!app || typeof app.on !== 'function') throw new TypeError('Packaged smoke guard app is invalid');
  let rendererPublicNetworkRequests = 0;
  const webContentsErrors = [];
  const record = (kind, value) => webContentsErrors.push(`${kind}: ${String(value || 'unknown').slice(0, 500)}`);

  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-fail-load', (_loadEvent, code, description, url, isMainFrame) => {
      if (isMainFrame !== false) record('did-fail-load', `${code} ${description} ${url}`);
    });
    contents.on('render-process-gone', (_goneEvent, details) => record('render-process-gone', details?.reason));
    contents.on('console-message', (_consoleEvent, level, message) => {
      if (level >= 3) record('console', message);
    });
  });

  function installSessionBlock(sessionApi) {
    const webRequest = sessionApi?.defaultSession?.webRequest;
    if (!webRequest || typeof webRequest.onBeforeRequest !== 'function') {
      throw new TypeError('Packaged smoke session webRequest is unavailable');
    }
    webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      if (isPublicHttpUrl(details?.url)) rendererPublicNetworkRequests += 1;
      callback({ cancel: true });
    });
  }

  function evidence() {
    return Object.freeze({ rendererPublicNetworkRequests, webContentsErrors: Object.freeze([...webContentsErrors]) });
  }

  return Object.freeze({ installSessionBlock, evidence });
}

module.exports = { createPackagedSmokeGuard, isPublicHttpUrl };
