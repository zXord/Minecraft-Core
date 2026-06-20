const http = require('node:http');
const https = require('node:https');
const { Readable } = require('node:stream');
const { URL } = require('node:url');

function getNativeFetch() {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('The runtime Fetch API is not available');
  }

  return globalThis.fetch.bind(globalThis);
}

function normalizeHeaders(headers = {}) {
  if (!headers) {
    return {};
  }

  if (typeof headers.entries === 'function') {
    return Object.fromEntries(headers.entries());
  }

  return { ...headers };
}

function createHeaders(rawHeaders = {}) {
  const normalized = new Map();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (!key) {
      continue;
    }

    normalized.set(
      key.toLowerCase(),
      Array.isArray(value) ? value.join(', ') : String(value ?? '')
    );
  }

  return {
    get(name) {
      return normalized.get(String(name).toLowerCase()) ?? null;
    },
    has(name) {
      return normalized.has(String(name).toLowerCase());
    },
    entries() {
      return normalized.entries();
    },
    forEach(callback) {
      for (const [key, value] of normalized.entries()) {
        callback(value, key, this);
      }
    }
  };
}

function collectNodeStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function createNodeResponse(message, url) {
  let collectedPromise = null;
  const collect = () => {
    if (!collectedPromise) {
      collectedPromise = collectNodeStream(message);
    }
    return collectedPromise;
  };

  return {
    ok: message.statusCode >= 200 && message.statusCode < 300,
    status: message.statusCode,
    statusText: message.statusMessage || '',
    url,
    headers: createHeaders(message.headers),
    body: message,
    async arrayBuffer() {
      const buffer = await collect();
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
    async buffer() {
      return collect();
    },
    async text() {
      return (await collect()).toString('utf8');
    },
    async json() {
      return JSON.parse(await this.text());
    }
  };
}

function createAbortController(timeoutMs, upstreamSignal) {
  const controller = new AbortController();
  let timeoutId = null;
  let upstreamAbortHandler = null;

  const abort = (reason) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      abort(upstreamSignal.reason);
    } else {
      upstreamAbortHandler = () => abort(upstreamSignal.reason);
      upstreamSignal.addEventListener('abort', upstreamAbortHandler, { once: true });
    }
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
    if (typeof timeoutId.unref === 'function') {
      timeoutId.unref();
    }
  }

  return {
    signal: controller.signal,
    cleanup() {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (upstreamSignal && upstreamAbortHandler) {
        upstreamSignal.removeEventListener('abort', upstreamAbortHandler);
      }
    }
  };
}

function wrapNativeResponse(response) {
  if (!response || typeof response !== 'object') {
    return response;
  }

  let nodeBody = null;

  return new Proxy(response, {
    get(target, prop, receiver) {
      if (prop === 'body') {
        const body = Reflect.get(target, prop, target);
        if (body && typeof body.getReader === 'function') {
          if (!nodeBody) {
            nodeBody = Readable.fromWeb(body);
          }
          return nodeBody;
        }
        return body;
      }

      if (prop === 'buffer') {
        return async () => Buffer.from(await target.arrayBuffer());
      }

      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function normalizeFetchUrl(input) {
  if (input instanceof URL) {
    return input;
  }

  if (typeof input === 'string') {
    return new URL(input);
  }

  if (input && typeof input.url === 'string') {
    return new URL(input.url);
  }

  return new URL(String(input));
}

function fetchWithNodeAgent(input, init) {
  const targetUrl = normalizeFetchUrl(input);
  const transport = targetUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      targetUrl,
      {
        method: init.method || 'GET',
        headers: normalizeHeaders(init.headers),
        agent: init.agent
      },
      (response) => resolve(createNodeResponse(response, targetUrl.toString()))
    );

    const abort = () => {
      request.destroy(new Error('Request aborted'));
    };

    if (init.signal) {
      if (init.signal.aborted) {
        abort();
      } else {
        init.signal.addEventListener('abort', abort, { once: true });
      }
    }

    request.on('error', reject);
    request.on('close', () => {
      if (init.signal) {
        init.signal.removeEventListener('abort', abort);
      }
    });

    if (init.body) {
      request.write(init.body);
    }
    request.end();
  });
}

async function fetchCompat(input, options = {}) {
  const { timeout, ...init } = options || {};
  const timeoutMs = Number(timeout);
  const needsController = (Number.isFinite(timeoutMs) && timeoutMs > 0) || init.signal;
  const abortState = needsController
    ? createAbortController(timeoutMs, init.signal)
    : { signal: init.signal, cleanup() {} };

  const requestInit = {
    ...init,
    signal: abortState.signal
  };

  try {
    if (requestInit.agent) {
      return await fetchWithNodeAgent(input, requestInit);
    }

    return wrapNativeResponse(await getNativeFetch()(input, requestInit));
  } finally {
    abortState.cleanup();
  }
}

module.exports = {
  fetch: fetchCompat,
  fetchCompat,
  __testUtils: {
    wrapNativeResponse
  }
};
