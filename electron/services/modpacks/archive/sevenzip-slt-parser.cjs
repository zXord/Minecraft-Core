const { TextDecoder } = require('node:util');
const { ARCHIVE_LIMITS } = require('../limits.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');

const MAX_LINE_BYTES = 8192;
const MAX_UINT64 = 18446744073709551615n;
const ENGINE_LINE = /^7-Zip 26\.02 \(x64\) : Copyright \(c\) 1999-2026 Igor Pavlov : 2026-06-25$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const TIMESTAMP = /^(?:|[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?)$/;

const ARCHIVE_ORDER = Object.freeze([
  'Path', 'Type', 'ERROR', 'Physical Size', 'Total Physical Size', '64-bit', 'Headers Size',
  'Embedded Stub Size', 'Tail Size', 'Characteristics', 'Encrypted', 'Solid', 'Blocks',
  'Method', 'Multivolume', 'Volume', 'Volume Index', 'Volumes', 'Offset', 'Comment', 'Code Page'
]);

const ZIP_ENTRY_ORDER = Object.freeze([
  'Path', 'Folder', 'Size', 'Packed Size', 'Modified', 'Created', 'Accessed', 'Attributes',
  'Encrypted', 'Comment', 'CRC', 'Method', 'Characteristics', 'Host OS', 'Version',
  'Volume Index', 'Offset'
]);
const RAR4_ENTRY_ORDER = Object.freeze([
  'Path', 'Folder', 'Size', 'Packed Size', 'Modified', 'Created', 'Accessed', 'Attributes',
  'Encrypted', 'Solid', 'Commented', 'Split Before', 'Split After', 'CRC', 'Host OS',
  'Method', 'Version', 'Volume Index', 'Block'
]);
const RAR5_ENTRY_ORDER = Object.freeze([
  'Path', 'Folder', 'Size', 'Packed Size', 'Modified', 'Created', 'Accessed', 'Attributes',
  'Alternate Stream', 'Encrypted', 'Solid', 'Split Before', 'Split After', 'CRC', 'Host OS',
  'Method', 'Characteristics', 'Symbolic Link', 'Hard Link', 'Copy Link', 'Volume Index',
  'Checksum', 'NT Security'
]);

function invalid(field = 'maxBytes') {
  throw new ModpackError('INVALID_REQUEST', 'Archive list request is invalid', { details: { field } });
}

function malformed(cause) {
  return new ModpackError('EXTRACTOR_FAILED', 'Archive technical listing was invalid', { cause });
}

function encrypted() {
  return new ModpackError('ENCRYPTED_ARCHIVE', 'Encrypted archives are not supported');
}

function multipartMissing() {
  return new ModpackError('MULTIPART_VOLUME_MISSING', 'The multipart archive set could not be verified');
}

function limit(actual) {
  return new ModpackError('ARCHIVE_LIMIT_EXCEEDED', 'Archive technical listing exceeded its safety limit', {
    details: { limit: 'maxTechnicalStdoutBytes', actual: String(actual) }
  });
}

function parseDecimal(value, { empty = false } = {}) {
  if (empty && value === '') return null;
  if (!DECIMAL.test(value)) throw malformed();
  const parsed = BigInt(value);
  if (parsed > MAX_UINT64) throw malformed();
  return parsed.toString();
}

function parseBoolean(value) {
  if (value === '+') return true;
  if (value === '-') return false;
  throw malformed();
}

function boundedText(value, maximum, { empty = true } = {}) {
  if (typeof value !== 'string' || value.length > maximum || (!empty && value.length === 0)) throw malformed();
  return value;
}

function fieldLine(line) {
  const separator = line.indexOf(' = ');
  if (separator < 1) throw malformed();
  const key = line.slice(0, separator);
  const value = line.slice(separator + 3);
  if (key.length > 64 || /\s$/.test(key)) throw malformed();
  return [key, value];
}

function orderedRecord(lines, order, { required = order } = {}) {
  const record = Object.create(null);
  let previous = -1;
  for (const line of lines) {
    const [key, value] = fieldLine(line);
    const index = order.indexOf(key);
    if (index < 0 || index <= previous || Object.hasOwn(record, key)) throw malformed();
    record[key] = value;
    previous = index;
  }
  if (required.some(key => !Object.hasOwn(record, key))) throw malformed();
  return record;
}

function archiveRecord(lines) {
  const raw = orderedRecord(lines, ARCHIVE_ORDER, { required: ['Path', 'Type', 'Physical Size'] });
  for (const key of ['Path', 'Type', 'Physical Size']) if (!Object.hasOwn(raw, key)) throw malformed();
  boundedText(raw.Path, 4096, { empty: false });
  const type = raw.Type === 'zip' ? 'zip' : raw.Type === 'Rar' ? 'rar' : raw.Type === 'Rar5' ? 'rar5' : null;
  if (!type) throw malformed();
  if (Object.hasOwn(raw, 'ERROR')) {
    const prefix = 'Missing volume : ';
    const missingName = raw.ERROR.startsWith(prefix) ? raw.ERROR.slice(prefix.length) : '';
    if ((type !== 'rar' && type !== 'rar5') || missingName.length < 1 || missingName.length > 255 ||
        missingName !== missingName.trim() || missingName !== missingName.normalize('NFC') ||
        /[\\/:\u0000-\u001f\u007f]/u.test(missingName) || /[. ]$/u.test(missingName) ||
        !/(?:\.part0*[1-9][0-9]*\.rar|\.r[0-9]{2}|\.[0-9]{3,})$/iu.test(missingName)) throw malformed();
    throw multipartMissing();
  }

  const required = type === 'zip'
    ? ['Path', 'Type', 'Physical Size']
    : type === 'rar'
      ? ['Path', 'Type', 'Physical Size', 'Solid', 'Blocks', 'Multivolume', 'Volumes']
      : ['Path', 'Type', 'Physical Size', 'Characteristics', 'Encrypted', 'Solid', 'Blocks', 'Method', 'Multivolume', 'Volumes'];
  if (required.some(key => !Object.hasOwn(raw, key))) throw malformed();

  const encryptedValue = Object.hasOwn(raw, 'Encrypted') ? parseBoolean(raw.Encrypted) : false;
  if (encryptedValue) throw encrypted();
  const result = {
    type,
    physicalSize: parseDecimal(raw['Physical Size']),
    ...(Object.hasOwn(raw, 'Total Physical Size') ? { totalPhysicalSize: parseDecimal(raw['Total Physical Size']) } : {}),
    ...(Object.hasOwn(raw, '64-bit') ? { zip64: parseBoolean(raw['64-bit']) } : {}),
    ...(Object.hasOwn(raw, 'Headers Size') ? { headersSize: parseDecimal(raw['Headers Size']) } : {}),
    ...(Object.hasOwn(raw, 'Embedded Stub Size') ? { embeddedStubSize: parseDecimal(raw['Embedded Stub Size']) } : {}),
    ...(Object.hasOwn(raw, 'Tail Size') ? { tailSize: parseDecimal(raw['Tail Size']) } : {}),
    ...(Object.hasOwn(raw, 'Characteristics') ? { characteristics: boundedText(raw.Characteristics, 1024) } : {}),
    encrypted: encryptedValue,
    ...(Object.hasOwn(raw, 'Solid') ? { solid: parseBoolean(raw.Solid) } : {}),
    ...(Object.hasOwn(raw, 'Blocks') ? { blocks: parseDecimal(raw.Blocks) } : {}),
    ...(Object.hasOwn(raw, 'Method') ? { method: boundedText(raw.Method, 1024) } : {}),
    multivolume: Object.hasOwn(raw, 'Multivolume') ? parseBoolean(raw.Multivolume) : false,
    ...(Object.hasOwn(raw, 'Volume') ? { volume: parseDecimal(raw.Volume, { empty: true }) } : {}),
    ...(Object.hasOwn(raw, 'Volume Index') ? { volumeIndex: parseDecimal(raw['Volume Index'], { empty: true }) } : {}),
    ...(Object.hasOwn(raw, 'Volumes') ? { volumes: parseDecimal(raw.Volumes) } : {}),
    ...(Object.hasOwn(raw, 'Offset') ? { offset: parseDecimal(raw.Offset) } : {})
  };
  if (Object.hasOwn(raw, 'Comment')) boundedText(raw.Comment, 4096);
  if (Object.hasOwn(raw, 'Code Page')) parseDecimal(raw['Code Page']);
  return result;
}

function entryRecord(lines, archiveType) {
  const order = archiveType === 'zip' ? ZIP_ENTRY_ORDER : archiveType === 'rar' ? RAR4_ENTRY_ORDER : RAR5_ENTRY_ORDER;
  const raw = orderedRecord(lines, order, {
    required: archiveType === 'rar' ? order.filter(key => key !== 'Block') : order
  });
  const folder = parseBoolean(raw.Folder);
  const encryptedValue = parseBoolean(raw.Encrypted);
  if (encryptedValue) throw encrypted();
  if (!TIMESTAMP.test(raw.Modified) || !TIMESTAMP.test(raw.Created) || !TIMESTAMP.test(raw.Accessed)) throw malformed();
  boundedText(raw.Path, 4096, { empty: false });
  boundedText(raw.Attributes, 1024);
  boundedText(raw.Method, 1024);
  boundedText(raw['Host OS'], 256);
  if (Object.hasOwn(raw, 'Characteristics')) boundedText(raw.Characteristics, 1024);
  if (Object.hasOwn(raw, 'Comment')) boundedText(raw.Comment, 4096);
  if (raw.CRC !== '' && !/^[A-F0-9]{8,64}$/.test(raw.CRC)) throw malformed();

  const result = {
    path: raw.Path,
    type: folder ? 'directory' : 'file',
    size: parseDecimal(raw.Size),
    packedSize: parseDecimal(raw['Packed Size']),
    modified: raw.Modified || null,
    created: raw.Created || null,
    accessed: raw.Accessed || null,
    attributes: raw.Attributes,
    encrypted: encryptedValue,
    method: raw.Method,
    hostOs: raw['Host OS'],
    crc: raw.CRC || null,
    ...(Object.hasOwn(raw, 'Characteristics') ? { characteristics: raw.Characteristics } : {}),
    ...(Object.hasOwn(raw, 'Solid') ? { solid: parseBoolean(raw.Solid) } : {}),
    ...(Object.hasOwn(raw, 'Commented') ? { commented: parseBoolean(raw.Commented) } : {}),
    ...(Object.hasOwn(raw, 'Split Before') ? { splitBefore: parseBoolean(raw['Split Before']) } : {}),
    ...(Object.hasOwn(raw, 'Split After') ? { splitAfter: parseBoolean(raw['Split After']) } : {}),
    ...(Object.hasOwn(raw, 'Alternate Stream') ? { alternateStream: parseBoolean(raw['Alternate Stream']) } : {}),
    ...(Object.hasOwn(raw, 'Symbolic Link') ? { symbolicLink: raw['Symbolic Link'] || null } : {}),
    ...(Object.hasOwn(raw, 'Hard Link') ? { hardLink: raw['Hard Link'] || null } : {}),
    ...(Object.hasOwn(raw, 'Copy Link') ? { copyLink: raw['Copy Link'] || null } : {}),
    ...(Object.hasOwn(raw, 'NT Security') ? { ntSecurity: raw['NT Security'] || null } : {}),
    ...(Object.hasOwn(raw, 'Checksum') ? { checksum: raw.Checksum || null } : {}),
    ...(Object.hasOwn(raw, 'Version') ? { version: parseDecimal(raw.Version, { empty: true }) } : {}),
    ...(Object.hasOwn(raw, 'Volume Index') ? { volumeIndex: parseDecimal(raw['Volume Index'], { empty: true }) } : {}),
    ...(Object.hasOwn(raw, 'Offset') ? { offset: parseDecimal(raw.Offset) } : {}),
    ...(Object.hasOwn(raw, 'Block') ? { block: parseDecimal(raw.Block, { empty: true }) } : {})
  };
  for (const key of ['Symbolic Link', 'Hard Link', 'Copy Link', 'NT Security', 'Checksum']) {
    if (Object.hasOwn(raw, key)) boundedText(raw[key], key === 'Checksum' ? 256 : 1024);
  }
  return result;
}

async function forEachLine(readable, maxBytes, consume) {
  if (!readable || typeof readable[Symbol.asyncIterator] !== 'function') invalid('readable');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let total = 0;
  let pending = '';
  let newlineStyle = null;
  let sawNewline = false;

  const consumeText = text => {
    if (text.includes('\ufeff')) throw malformed();
    let offset = 0;
    for (;;) {
      const newline = text.indexOf('\n', offset);
      if (newline < 0) {
        pending += text.slice(offset);
        if (Buffer.byteLength(pending, 'utf8') > MAX_LINE_BYTES) throw limit(Buffer.byteLength(pending, 'utf8'));
        break;
      }
      pending += text.slice(offset, newline);
      const crlf = pending.endsWith('\r');
      const line = crlf ? pending.slice(0, -1) : pending;
      if (line.includes('\r')) throw malformed();
      const style = crlf ? 'crlf' : 'lf';
      if (newlineStyle && newlineStyle !== style) throw malformed();
      newlineStyle = style;
      sawNewline = true;
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw limit(Buffer.byteLength(line, 'utf8'));
      for (const character of line) {
        const code = character.codePointAt(0);
        if (code < 0x20 || code === 0x7f) throw malformed();
      }
      consume(line);
      pending = '';
      offset = newline + 1;
    }
  };

  try {
    for await (const chunkValue of readable) {
      if (!Buffer.isBuffer(chunkValue) && !(chunkValue instanceof Uint8Array)) throw malformed();
      const chunk = Buffer.from(chunkValue);
      total += chunk.length;
      if (total > maxBytes) throw limit(total);
      consumeText(decoder.decode(chunk, { stream: true }));
    }
    consumeText(decoder.decode());
  } catch (error) {
    if (error instanceof ModpackError) throw error;
    throw malformed(error);
  }
  if (!sawNewline || pending.length !== 0) throw malformed();
}

async function parseSevenZipTechnicalList(readable, { maxBytes } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) invalid();
  let phase = 0;
  let headerLines = [];
  let archive = null;
  let entryLines = [];
  const entries = [];
  let separatorSeen = false;
  let terminalRecord = false;

  const preamble = [
    line => line === '',
    line => ENGINE_LINE.test(line),
    line => line === '',
    line => line === 'Scanning the drive for archives:',
    line => /^1 file, [0-9]+ bytes(?: \([^)]+\))?$/.test(line),
    line => line === '',
    line => line.startsWith('Listing archive: ') && line.length > 'Listing archive: '.length,
    line => line === '',
    line => line === '--'
  ];

  const consume = line => {
    if (/(?:enter|wrong|incorrect|required).{0,48}password|password.{0,48}(?:required|incorrect|wrong)/i.test(line)) throw encrypted();
    if (phase < preamble.length) {
      if (!preamble[phase](line)) throw malformed();
      phase += 1;
      return;
    }
    if (!archive) {
      if (line === '') {
        if (headerLines.length === 0) throw malformed();
        archive = archiveRecord(headerLines);
        headerLines = [];
      } else {
        headerLines.push(line);
        if (headerLines.length > ARCHIVE_ORDER.length) throw malformed();
      }
      return;
    }
    if (!separatorSeen) {
      if (line !== '----------') throw malformed();
      separatorSeen = true;
      return;
    }
    if (line === '') {
      if (entryLines.length === 0) {
        terminalRecord = true;
        return;
      }
      if (entries.length >= ARCHIVE_LIMITS.maxArchiveEntries) throw limit(entries.length + 1);
      entries.push(entryRecord(entryLines, archive.type));
      entryLines = [];
      terminalRecord = true;
      return;
    }
    terminalRecord = false;
    entryLines.push(line);
    if (entryLines.length > Math.max(ZIP_ENTRY_ORDER.length, RAR5_ENTRY_ORDER.length)) throw malformed();
  };

  await forEachLine(readable, maxBytes, consume);
  if (phase !== preamble.length || !archive || !separatorSeen || entryLines.length !== 0 || (entries.length > 0 && !terminalRecord)) throw malformed();
  return deepFreeze({ engineVersion: '26.02', archive, entries });
}

module.exports = { parseSevenZipTechnicalList };
