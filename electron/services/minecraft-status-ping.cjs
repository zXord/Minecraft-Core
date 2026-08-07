const net = require('node:net');
const { TextDecoder } = require('node:util');

const { ModpackError } = require('./modpacks/errors.cjs');

const MAX_STATUS_FRAME_BYTES = 1024 * 1024;
const MAX_HOST_BYTES = 255;
const REQUEST_KEYS = new Set(['host', 'port', 'protocolVersion', 'signal', 'timeoutMs']);

function invalidRequest(cause) {
  return new ModpackError('INVALID_REQUEST', 'Minecraft status request is invalid', { cause });
}

function healthFailure(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('HEALTH_CHECK_FAILED', 'Minecraft status check failed', { cause });
}

function cancelled(cause) {
  return new ModpackError('CANCELLED', 'Minecraft status check was cancelled', { cause });
}

function assertExactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest();
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalidRequest();
  }
}

function isAbortSignal(value) {
  return value && typeof value === 'object' && typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' && typeof value.removeEventListener === 'function';
}

function hasControlCharacters(value) {
  return [...value].some(character => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  });
}

function normalizeRequest(value) {
  assertExactKeys(value, REQUEST_KEYS);
  const host = typeof value.host === 'string' ? value.host.trim() : '';
  const hostBytes = Buffer.from(host, 'utf8');
  const port = value.port;
  const timeoutMs = value.timeoutMs;
  const protocolVersion = value.protocolVersion === undefined ? -1 : value.protocolVersion;
  const signal = value.signal;

  if (!host || hostBytes.length > MAX_HOST_BYTES || hasControlCharacters(host)) throw invalidRequest();
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw invalidRequest();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw invalidRequest();
  if (!Number.isInteger(protocolVersion) || protocolVersion < -2147483648 || protocolVersion > 2147483647) {
    throw invalidRequest();
  }
  if (signal !== undefined && !isAbortSignal(signal)) throw invalidRequest();

  return Object.freeze({ host, hostBytes, port, protocolVersion, signal, timeoutMs });
}

function encodeVarInt(value) {
  let remaining = value >>> 0;
  const bytes = [];
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return Buffer.from(bytes);
}

function frame(payload) {
  return Buffer.concat([encodeVarInt(payload.length), payload]);
}

function buildStatusRequest(request) {
  const port = Buffer.allocUnsafe(2);
  port.writeUInt16BE(request.port);
  const handshake = Buffer.concat([
    encodeVarInt(0),
    encodeVarInt(request.protocolVersion),
    encodeVarInt(request.hostBytes.length),
    request.hostBytes,
    port,
    encodeVarInt(1)
  ]);
  return Buffer.concat([frame(handshake), frame(encodeVarInt(0))]);
}

function decodeVarInt(buffer, offset = 0) {
  let unsigned = 0;
  for (let index = 0; index < 5; index += 1) {
    const cursor = offset + index;
    if (cursor >= buffer.length) return null;
    const byte = buffer[cursor];
    if (index === 4 && (byte & 0xf0) !== 0) throw new Error('Malformed VarInt');
    unsigned |= (byte & 0x7f) << (index * 7);
    if ((byte & 0x80) === 0) {
      return { bytes: index + 1, value: unsigned | 0 };
    }
  }
  throw new Error('Malformed VarInt');
}

function flattenDescription(value) {
  if (typeof value === 'string') return value;
  let nodes = 0;
  function visit(node, depth) {
    nodes += 1;
    if (nodes > 4096 || depth > 32) throw new Error('Status description is too complex');
    if (typeof node === 'string') return node;
    if (!node || typeof node !== 'object' || Array.isArray(node)) return '';
    let result = typeof node.text === 'string' ? node.text : '';
    if (Array.isArray(node.extra)) {
      for (const child of node.extra) result += visit(child, depth + 1);
    }
    return result;
  }
  return visit(value, 0);
}

function normalizeStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid status object');
  const description = flattenDescription(value.description);
  let players = null;
  if (value.players && typeof value.players === 'object' && !Array.isArray(value.players) &&
      Number.isSafeInteger(value.players.max) && value.players.max >= 0 &&
      Number.isSafeInteger(value.players.online) && value.players.online >= 0) {
    players = Object.freeze({ max: value.players.max, online: value.players.online });
  }
  let version = null;
  if (value.version && typeof value.version === 'object' && !Array.isArray(value.version) &&
      typeof value.version.name === 'string' && Number.isInteger(value.version.protocol)) {
    version = Object.freeze({ name: value.version.name, protocol: value.version.protocol });
  }
  return Object.freeze({ description, players, version });
}

function parseStatusResponse(buffer) {
  const frameLength = decodeVarInt(buffer);
  if (!frameLength) return null;
  if (frameLength.value < 0 || frameLength.value > MAX_STATUS_FRAME_BYTES) throw new Error('Invalid status frame');
  const totalLength = frameLength.bytes + frameLength.value;
  if (buffer.length < totalLength) return null;
  if (buffer.length !== totalLength) throw new Error('Unexpected trailing status bytes');

  const payload = buffer.subarray(frameLength.bytes, totalLength);
  let offset = 0;
  const packetId = decodeVarInt(payload, offset);
  if (!packetId) throw new Error('Missing status packet identifier');
  offset += packetId.bytes;
  if (packetId.value !== 0) throw new Error('Unexpected status packet identifier');
  const stringLength = decodeVarInt(payload, offset);
  if (!stringLength || stringLength.value < 0 || stringLength.value > MAX_STATUS_FRAME_BYTES) {
    throw new Error('Invalid status string length');
  }
  offset += stringLength.bytes;
  if (stringLength.value !== payload.length - offset) throw new Error('Invalid status string boundary');

  const jsonBytes = payload.subarray(offset);
  const json = new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes);
  return normalizeStatus(JSON.parse(json));
}

async function pingMinecraftStatus(input) {
  let request;
  try {
    request = normalizeRequest(input);
  } catch (error) {
    throw error instanceof ModpackError ? error : invalidRequest(error);
  }
  if (request.signal?.aborted) throw cancelled();

  return new Promise((resolve, reject) => {
    let socket = null;
    let settled = false;
    let response = Buffer.alloc(0);
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (request.signal) request.signal.removeEventListener('abort', onAbort);
      if (socket) {
        socket.removeListener('connect', onConnect);
        socket.removeListener('data', onData);
        socket.removeListener('end', onEnd);
        socket.removeListener('close', onClose);
        socket.removeListener('error', onError);
      }
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (socket && !socket.destroyed) socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const failHealth = cause => finish(healthFailure(cause));
    const onAbort = () => finish(cancelled());
    const onConnect = () => {
      try {
        socket.setNoDelay(true);
        socket.write(buildStatusRequest(request));
      } catch (error) {
        failHealth(error);
      }
    };
    const onData = chunk => {
      if (settled) return;
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
      if (response.length + chunk.length > MAX_STATUS_FRAME_BYTES + 5) {
        failHealth(new Error('Status response is too large'));
        return;
      }
      response = Buffer.concat([response, chunk]);
      try {
        const result = parseStatusResponse(response);
        if (result) finish(null, result);
      } catch (error) {
        failHealth(error);
      }
    };
    const onEnd = () => {
      if (!settled) failHealth(new Error('Status response ended early'));
    };
    const onClose = () => {
      if (!settled) failHealth(new Error('Status connection closed early'));
    };
    const onError = error => failHealth(error);

    timer = setTimeout(() => failHealth(new Error('Status deadline exceeded')), request.timeoutMs);
    if (request.signal) request.signal.addEventListener('abort', onAbort, { once: true });
    try {
      socket = net.createConnection({ host: request.host, port: request.port });
      socket.once('connect', onConnect);
      socket.on('data', onData);
      socket.once('end', onEnd);
      socket.once('close', onClose);
      socket.once('error', onError);
    } catch (error) {
      failHealth(error);
    }
  });
}

module.exports = {
  MAX_STATUS_FRAME_BYTES,
  pingMinecraftStatus
};
