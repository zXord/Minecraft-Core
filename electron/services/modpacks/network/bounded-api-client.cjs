const { ModpackError } = require('../errors.cjs');

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_REQUEST_TIMEOUT_MS = 5 * 60_000;

function invalid() {
  return new ModpackError('INVALID_RELEASE_URL', 'Provider API address is not allowed', {
    details: { reasonCode: 'host-not-allowed' }
  });
}

function tooLarge(actual) {
  return new ModpackError('ARCHIVE_LIMIT_EXCEEDED', 'Provider response exceeded the configured byte limit', {
    details: { limit: 'maxTechnicalStdoutBytes', actual: String(actual) }
  });
}

function deadlineExceeded() {
  return new ModpackError('INVALID_RELEASE_URL', 'Provider request timed out', { retryable: true });
}

function cancelled() {
  return new ModpackError('CANCELLED', 'Provider request was cancelled');
}

function requestTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_REQUEST_TIMEOUT_MS) throw new TypeError('Bounded API client dependencies are invalid');
  return value;
}

function deadlineSignal(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let rejectCancellation;
  const cancellation = new Promise((resolve, reject) => {
    rejectCancellation = reject;
  });
  const onAbort = () => {
    controller.abort();
    rejectCancellation(cancelled());
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  let rejectDeadline;
  const deadline = new Promise((resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectDeadline(deadlineExceeded());
  }, timeoutMs);
  return {
    signal: controller.signal,
    deadline,
    cancellation,
    timedOut: () => timedOut,
    release() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  };
}

function normalizedPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || value[0] !== '/' || value.startsWith('//') ||
      value.includes('\\') || value.includes('?') || value.includes('#') || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid();
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw invalid(); }
  if (decoded.split('/').some(segment => segment === '.' || segment === '..') || decoded.includes('\\')) throw invalid();
  return value;
}

function appendQuery(url, value) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0 || Object.keys(value).length > 128) throw invalid();
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, 'en-US'))) {
    const item = value[key];
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(key) || typeof item !== 'string' || item.length > 16 * 1024 ||
        /[\u0000-\u001f\u007f]/u.test(item)) throw invalid();
    url.searchParams.append(key, item);
  }
}

class BoundedApiClient {
  constructor({ client, baseUrl, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, maxRedirects = 0, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    if (!client || typeof client.request !== 'function' || typeof baseUrl !== 'string' ||
        !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > DEFAULT_MAX_RESPONSE_BYTES ||
        !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 1) throw new TypeError('Bounded API client dependencies are invalid');
    let parsed;
    try { parsed = new URL(baseUrl); } catch { throw new TypeError('Bounded API base URL is invalid'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash ||
        !parsed.hostname || !parsed.pathname.endsWith('/')) throw new TypeError('Bounded API base URL is invalid');
    this.client = client;
    this.baseUrl = parsed;
    this.origin = parsed.origin;
    this.host = parsed.hostname;
    this.maxResponseBytes = maxResponseBytes;
    this.maxRedirects = maxRedirects;
    this.requestTimeoutMs = requestTimeout(requestTimeoutMs);
  }

  async request(path, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype ||
        Object.keys(options).some(key => !['headers', 'query', 'signal'].includes(key))) throw invalid();
    const relative = normalizedPath(path).slice(1);
    const url = new URL(relative, this.baseUrl);
    if (url.origin !== this.origin || !url.pathname.startsWith(this.baseUrl.pathname)) throw invalid();
    appendQuery(url, options.query);
    const bounded = deadlineSignal(options.signal, this.requestTimeoutMs);
    let response;
    const destroyOnAbort = () => response?.destroy?.();
    bounded.signal.addEventListener('abort', destroyOnAbort, { once: true });
    const execute = async () => {
      response = await this.client.request(url.href, {
        headers: options.headers,
        signal: bounded.signal,
        allowedHosts: [this.host],
        allowedOrigins: [this.origin],
        allowSubdomains: false,
        maxRedirects: this.maxRedirects
      });
      if (!response || !Number.isSafeInteger(response.statusCode) || typeof response[Symbol.asyncIterator] !== 'function') {
        response?.destroy?.();
        throw invalid();
      }
      const rawLength = response.headers?.['content-length'];
      if (rawLength !== undefined) {
        if (Array.isArray(rawLength) || !/^(0|[1-9][0-9]*)$/u.test(String(rawLength)) ||
            BigInt(rawLength) > BigInt(this.maxResponseBytes)) {
          response.destroy?.();
          throw tooLarge(rawLength);
        }
      }
      const chunks = [];
      let measured = 0;
      try {
        for await (const value of response) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          measured += chunk.length;
          if (measured > this.maxResponseBytes) {
            response.destroy?.();
            throw tooLarge(measured);
          }
          chunks.push(chunk);
        }
      } catch (error) {
        response.destroy?.();
        throw error;
      }
      return Object.freeze({
        statusCode: response.statusCode,
        headers: Object.freeze({ ...(response.headers || {}) }),
        body: Buffer.concat(chunks, measured)
      });
    };
    try {
      return await Promise.race([execute(), bounded.deadline, bounded.cancellation]);
    } catch (error) {
      response?.destroy?.();
      if (bounded.timedOut()) throw deadlineExceeded();
      throw error;
    } finally {
      bounded.signal.removeEventListener('abort', destroyOnAbort);
      bounded.release();
    }
  }
}

module.exports = { BoundedApiClient, DEFAULT_MAX_RESPONSE_BYTES };
