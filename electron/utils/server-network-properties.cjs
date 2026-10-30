const NETWORK_ACCESS_VALUES = Object.freeze(['pack-default', 'loopback']);
const NETWORK_ACCESS_SET = new Set(NETWORK_ACCESS_VALUES);
const LOOPBACK_SERVER_IP = '127.0.0.1';
const MAX_SERVER_PROPERTIES_BYTES = 1024 * 1024;
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/u;

function isNetworkAccess(value) {
  return NETWORK_ACCESS_SET.has(value);
}

function serverNetworkProperties({ port, networkAccess }) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !isNetworkAccess(networkAccess)) {
    throw new TypeError('Server network policy is invalid');
  }
  return {
    'server-port': String(port),
    ...(networkAccess === 'loopback' ? { 'server-ip': LOOPBACK_SERVER_IP } : {})
  };
}

function invalidProperties() {
  return new TypeError('Server properties are invalid');
}

function propertiesText(bytes, mode = 'strict') {
  if (bytes === null || bytes === undefined) return '';
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw invalidProperties();
  const buffer = Buffer.from(bytes);
  if (buffer.length > MAX_SERVER_PROPERTIES_BYTES) throw invalidProperties();
  // Lossless mode maps each byte to one code unit, so bytes the overlay does not replace are written
  // back exactly, whatever encoding the file was saved in (Minecraft itself also accepts ISO-8859-1).
  if (mode === 'lossless') return buffer.toString('latin1');
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) throw invalidProperties();
  return text;
}

function isPropertyWhitespace(value) {
  return value === ' ' || value === '\t' || value === '\f';
}

function hasContinuation(value) {
  let backslashes = 0;
  for (let index = value.length - 1; index >= 0 && value[index] === '\\'; index -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function decodePropertyEscapes(value) {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    if (current !== '\\') {
      decoded += current;
      continue;
    }
    index += 1;
    if (index >= value.length) throw invalidProperties();
    const escaped = value[index];
    if (escaped === 'u') {
      if (index + 4 >= value.length) throw invalidProperties();
      const hex = value.slice(index + 1, index + 5);
      if (!/^[0-9A-Fa-f]{4}$/u.test(hex)) throw invalidProperties();
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
      continue;
    }
    decoded += {
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t'
    }[escaped] ?? escaped;
  }
  return decoded;
}

function splitNaturalLines(text) {
  if (text.length === 0) return [];
  const lines = [];
  const endings = /\r\n|\n|\r/gu;
  let cursor = 0;
  let match;
  while ((match = endings.exec(text)) !== null) {
    lines.push({
      terminator: match[0],
      text: text.slice(cursor, match.index)
    });
    cursor = endings.lastIndex;
  }
  if (cursor < text.length) {
    lines.push({ terminator: '', text: text.slice(cursor) });
  }
  return lines;
}

function parseLogicalProperty(value, startLine, endLine) {
  let start = 0;
  while (start < value.length && isPropertyWhitespace(value[start])) start += 1;
  if (start >= value.length || value[start] === '#' || value[start] === '!') return null;

  let keyEnd = value.length;
  let valueStart = value.length;
  let hasSeparator = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const current = value[index];
    if (!escaped && (current === '=' || current === ':')) {
      keyEnd = index;
      valueStart = index + 1;
      hasSeparator = true;
      break;
    }
    if (!escaped && isPropertyWhitespace(current)) {
      keyEnd = index;
      valueStart = index + 1;
      break;
    }
    escaped = current === '\\' ? !escaped : false;
  }

  while (valueStart < value.length) {
    const current = value[valueStart];
    if (isPropertyWhitespace(current)) {
      valueStart += 1;
      continue;
    }
    if (!hasSeparator && (current === '=' || current === ':')) {
      hasSeparator = true;
      valueStart += 1;
      continue;
    }
    break;
  }

  return {
    endLine,
    key: decodePropertyEscapes(value.slice(start, keyEnd)),
    startLine,
    value: decodePropertyEscapes(value.slice(valueStart))
  };
}

function parseServerProperties(bytes, mode = 'strict') {
  const text = propertiesText(bytes, mode);
  const lines = splitNaturalLines(text);
  const newline = lines.find(line => line.terminator)?.terminator || '\n';
  const entries = [];
  let terminalContinuationLine = null;

  for (let index = 0; index < lines.length; index += 1) {
    const startLine = index;
    let logical = lines[index].text;
    const firstContent = logical.search(/[^ \t\f]/u);
    const comment = firstContent >= 0 && (logical[firstContent] === '#' || logical[firstContent] === '!');
    if (!comment) {
      while (hasContinuation(logical)) {
        logical = logical.slice(0, -1);
        if (index + 1 >= lines.length) {
          terminalContinuationLine = index;
          break;
        }
        index += 1;
        logical += lines[index].text.replace(/^[ \t\f]+/u, '');
      }
    }
    const entry = parseLogicalProperty(logical, startLine, index);
    if (entry) entries.push(entry);
  }

  return { entries, lines, newline, terminalContinuationLine };
}

function readEffectiveServerProperty(bytes, propertyName) {
  if (typeof propertyName !== 'string' || propertyName.length === 0 || propertyName.length > 256 ||
      /[\r\n\u0000]/u.test(propertyName)) throw invalidProperties();
  let effective = null;
  for (const entry of parseServerProperties(bytes).entries) {
    if (entry.key === propertyName) effective = entry.value;
  }
  return effective;
}

function overlayServerProperties(bytes, properties) {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new TypeError('Server properties overlay is invalid');
  }
  const overlay = new Map();
  for (const [key, value] of Object.entries(properties)) {
    if (typeof key !== 'string' || key.length === 0 || !/^[A-Za-z0-9._-]+$/u.test(key) ||
        (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') ||
        !PRINTABLE_ASCII.test(String(value))) {
      throw new TypeError('Server properties overlay is invalid');
    }
    overlay.set(key, `${key}=${value}`);
  }
  const parsed = parseServerProperties(bytes, 'lossless');
  const replacements = new Map();
  const placedKeys = new Set();
  const removedLines = new Set();
  for (const entry of parsed.entries) {
    if (!overlay.has(entry.key)) continue;
    if (!placedKeys.has(entry.key)) {
      placedKeys.add(entry.key);
      replacements.set(entry.startLine, entry);
      continue;
    }
    for (let index = entry.startLine; index <= entry.endLine; index += 1) removedLines.add(index);
  }

  let output = '';
  let last = null;
  for (let index = 0; index < parsed.lines.length; index += 1) {
    const replacement = replacements.get(index);
    if (replacement) {
      // The first entry keeps its position and the terminator of its last physical line.
      const { terminator } = parsed.lines[replacement.endLine];
      output += `${overlay.get(replacement.key)}${terminator}`;
      last = { terminator, continuation: false };
      index = replacement.endLine;
      continue;
    }
    if (removedLines.has(index)) continue;
    const line = parsed.lines[index];
    output += `${line.text}${line.terminator}`;
    last = { terminator: line.terminator, continuation: index === parsed.terminalContinuationLine };
  }

  const additions = [...overlay.keys()].filter(key => !placedKeys.has(key));
  if (additions.length > 0 && last) {
    if (last.terminator === '') output += parsed.newline;
    if (last.continuation) output += parsed.newline;
  }
  for (const key of additions) output += `${overlay.get(key)}${parsed.newline}`;
  return Buffer.from(output, 'latin1');
}

function applyServerNetworkProperties(bytes, network) {
  return overlayServerProperties(bytes, serverNetworkProperties(network));
}

module.exports = {
  LOOPBACK_SERVER_IP,
  MAX_SERVER_PROPERTIES_BYTES,
  NETWORK_ACCESS_VALUES,
  applyServerNetworkProperties,
  isNetworkAccess,
  overlayServerProperties,
  readEffectiveServerProperty,
  serverNetworkProperties
};
