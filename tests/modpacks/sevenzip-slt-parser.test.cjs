const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const {
  parseSevenZipTechnicalList
} = require('../../electron/services/modpacks/archive/sevenzip-slt-parser.cjs');

function technicalList({ archive = [], entries = [], newline = '\r\n', terminalBlank = true } = {}) {
  const lines = [
    '',
    '7-Zip 26.02 (x64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-06-25',
    '',
    'Scanning the drive for archives:',
    '1 file, 123 bytes (1 KiB)',
    '',
    'Listing archive: C:\\opaque\\input\\fixture.zip',
    '',
    '--',
    'Path = C:\\opaque\\input\\fixture.zip',
    'Type = zip',
    'Physical Size = 123',
    ...archive,
    '',
    '----------',
    ...entries.flatMap(entry => [...entry, ''])
  ];
  if (!terminalBlank) lines.pop();
  return Buffer.from(`${lines.join(newline)}${newline}`, 'utf8');
}

function regularEntry(name = '世界.txt', overrides = {}) {
  const fields = {
    Path: name,
    Folder: '-',
    Size: '5',
    'Packed Size': '7',
    Modified: '2026-08-02 04:06:08',
    Created: '',
    Accessed: '',
    Attributes: 'A',
    Encrypted: '-',
    Comment: '',
    CRC: '3610A686',
    Method: 'Deflate',
    Characteristics: '',
    'Host OS': 'FAT',
    Version: '20',
    'Volume Index': '0',
    Offset: '0',
    ...overrides
  };
  return Object.entries(fields).map(([key, value]) => `${key} = ${value}`);
}

function directoryEntry(name = 'mods') {
  return regularEntry(name, {
    Folder: '+',
    Size: '0',
    'Packed Size': '0',
    Attributes: 'D',
    CRC: '',
    Method: ''
  });
}

function streamInChunks(buffer, chunkSizes = [1]) {
  const chunks = [];
  let offset = 0;
  let index = 0;
  while (offset < buffer.length) {
    const size = chunkSizes[index++ % chunkSizes.length];
    chunks.push(buffer.subarray(offset, Math.min(offset + size, buffer.length)));
    offset += size;
  }
  return Readable.from(chunks);
}

function hasCode(code) {
  return error => error?.code === code && !/C:\\opaque|fixture\.zip|world|password123/i.test(error.message);
}

test('incrementally parses pinned 7-Zip 26.02 technical output into frozen typed records', async () => {
  const bytes = technicalList({ entries: [directoryEntry(), regularEntry()] });
  const result = await parseSevenZipTechnicalList(streamInChunks(bytes, [1, 2, 3, 5, 8]), { maxBytes: bytes.length });

  assert.equal(result.engineVersion, '26.02');
  assert.deepEqual(result.archive, {
    type: 'zip',
    physicalSize: '123',
    encrypted: false,
    multivolume: false
  });
  assert.deepEqual(result.entries.map(entry => ({
    path: entry.path,
    type: entry.type,
    size: entry.size,
    packedSize: entry.packedSize,
    encrypted: entry.encrypted
  })), [
    { path: 'mods', type: 'directory', size: '0', packedSize: '0', encrypted: false },
    { path: '世界.txt', type: 'file', size: '5', packedSize: '7', encrypted: false }
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.entries), true);
  assert.equal(Object.isFrozen(result.entries[0]), true);
  assert.doesNotMatch(JSON.stringify(result), /C:\\opaque/);
});

test('accepts the closed RAR5 safety grammar and retains volume and link-relevant fields', async () => {
  const bytes = technicalList({
    archive: [
      'Total Physical Size = 246',
      'Characteristics = Volume FirstVolume',
      'Encrypted = -',
      'Solid = +',
      'Blocks = 1',
      'Method = v6:1M:m5',
      'Multivolume = +',
      'Volume Index = 0',
      'Volumes = 2'
    ],
    entries: [[
      'Path = mods/example.jar', 'Folder = -', 'Size = 5', 'Packed Size = 7',
      'Modified = 2026-08-02 04:06:08.123456789', 'Created = ', 'Accessed = ',
      'Attributes =  -rw-r--r--', 'Alternate Stream = -', 'Encrypted = -', 'Solid = +',
      'Split Before = -', 'Split After = -', 'CRC = 3610A686', 'Host OS = Unix',
      'Method = v6:m5:1M', 'Characteristics = CRC Time:uMn', 'Symbolic Link = ',
      'Hard Link = ', 'Copy Link = ', 'Volume Index = 0', 'Checksum = ', 'NT Security = '
    ]]
  });
  const patched = Buffer.from(bytes.toString('utf8').replace('Type = zip', 'Type = Rar5'), 'utf8');
  const result = await parseSevenZipTechnicalList(Readable.from([patched]), { maxBytes: patched.length });
  assert.deepEqual(result.archive, {
    type: 'rar5', physicalSize: '123', totalPhysicalSize: '246',
    characteristics: 'Volume FirstVolume', encrypted: false, solid: true,
    blocks: '1', method: 'v6:1M:m5', multivolume: true, volumeIndex: '0', volumes: '2'
  });
  assert.equal(result.entries[0].solid, true);
  assert.equal(result.entries[0].symbolicLink, null);
});

test('maps only the exact ordered bounded 7-Zip missing-volume header to MULTIPART_VOLUME_MISSING', async () => {
  const base = technicalList({ entries: [regularEntry()] }).toString('utf8')
    .replace('Type = zip', 'Type = Rar')
    .replace('Physical Size = 123', [
      'ERROR = Missing volume : multipart.part0003.rar',
      'Physical Size = 123',
      'Solid = -',
      'Blocks = 1',
      'Multivolume = +',
      'Volumes = 2'
    ].join('\r\n'));
  const missing = Buffer.from(base, 'utf8');
  await assert.rejects(
    parseSevenZipTechnicalList(Readable.from([missing]), { maxBytes: missing.length }),
    error => error?.code === 'MULTIPART_VOLUME_MISSING' &&
      !/part0003|\\|\//iu.test(error.message) && error.details === undefined
  );

  for (const diagnostic of [
    'ERROR = Cannot open file',
    'ERROR = Missing volume : ..\\private.rar',
    `ERROR = Missing volume : ${'x'.repeat(256)}.rar`
  ]) {
    const malformed = Buffer.from(base.replace('ERROR = Missing volume : multipart.part0003.rar', diagnostic), 'utf8');
    await assert.rejects(
      parseSevenZipTechnicalList(Readable.from([malformed]), { maxBytes: malformed.length }),
      hasCode('EXTRACTOR_FAILED')
    );
  }

  const misplaced = Buffer.from(base
    .replace('ERROR = Missing volume : multipart.part0003.rar\r\n', '')
    .replace('Physical Size = 123', 'Physical Size = 123\r\nERROR = Missing volume : multipart.part0003.rar'), 'utf8');
  await assert.rejects(
    parseSevenZipTechnicalList(Readable.from([misplaced]), { maxBytes: misplaced.length }),
    hasCode('EXTRACTOR_FAILED')
  );
});

test('fatal UTF-8 decoding, BOMs, controls, and inconsistent line endings fail closed', async () => {
  const valid = technicalList({ entries: [regularEntry()] });
  const mutations = [
    Buffer.concat([valid.subarray(0, 5), Buffer.from([0xff]), valid.subarray(5)]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]),
    Buffer.from(valid.toString('utf8').replace('Path = 世界.txt', 'Path = bad\u0000name'), 'utf8'),
    Buffer.from(valid.toString('utf8').replace('Path = 世界.txt', 'Path = bad\u007fname'), 'utf8'),
    Buffer.from(valid.toString('utf8').replace('\r\nSize = 5', '\nSize = 5'), 'utf8'),
    Buffer.from(valid.toString('utf8').replace('\r\nSize = 5', '\rSize = 5'), 'utf8')
  ];
  for (const [index, bytes] of mutations.entries()) {
    await assert.rejects(parseSevenZipTechnicalList(streamInChunks(bytes, [1, 7]), { maxBytes: bytes.length }), hasCode('EXTRACTOR_FAILED'), `mutation ${index}`);
  }
});

test('total bytes, line bytes, field bytes, record count, and decimal width are bounded', async () => {
  const valid = technicalList({ entries: [regularEntry()] });
  await assert.rejects(parseSevenZipTechnicalList(Readable.from([valid]), { maxBytes: valid.length - 1 }), hasCode('ARCHIVE_LIMIT_EXCEEDED'));

  const longPath = technicalList({ entries: [regularEntry('x'.repeat(8193))] });
  await assert.rejects(parseSevenZipTechnicalList(Readable.from([longPath]), { maxBytes: longPath.length }), hasCode('ARCHIVE_LIMIT_EXCEEDED'));

  const overflow = technicalList({ entries: [regularEntry('file', { Size: '18446744073709551616' })] });
  await assert.rejects(parseSevenZipTechnicalList(Readable.from([overflow]), { maxBytes: overflow.length }), hasCode('EXTRACTOR_FAILED'));
});

test('record field order is pinned and duplicate, missing, malformed, and unknown fields are rejected', async () => {
  const base = regularEntry('file.txt');
  const cases = [
    [base.slice(0, 3).concat(base[1], base.slice(3)), 'duplicate'],
    [base.filter(line => !line.startsWith('Packed Size =')), 'missing'],
    [[base[1], base[0], ...base.slice(2)], 'order'],
    [base.map(line => line.startsWith('Size =') ? 'Size: 5' : line), 'separator'],
    [base.concat('Anti = +'), 'unknown safety field'],
    [base.concat('Symbolic Link = target'), 'link field out of order']
  ];
  for (const [entry, label] of cases) {
    const bytes = technicalList({ entries: [entry] });
    await assert.rejects(parseSevenZipTechnicalList(Readable.from([bytes]), { maxBytes: bytes.length }), hasCode('EXTRACTOR_FAILED'), label);
  }
});

test('numeric signs, whitespace, invalid booleans, enums, and timestamps are rejected', async () => {
  const mutations = [
    { Size: '-1' },
    { Size: '+1' },
    { Size: ' 1' },
    { Folder: 'false' },
    { Encrypted: 'yes' },
    { Modified: '08/02/2026' },
    { 'Volume Index': '1.0' }
  ];
  for (const mutation of mutations) {
    const bytes = technicalList({ entries: [regularEntry('file.txt', mutation)] });
    await assert.rejects(parseSevenZipTechnicalList(streamInChunks(bytes, [2, 11]), { maxBytes: bytes.length }), hasCode('EXTRACTOR_FAILED'));
  }
});

test('archive and entry encryption evidence stops parsing with ENCRYPTED_ARCHIVE', async () => {
  for (const bytes of [
    technicalList({ archive: ['Encrypted = +'], entries: [regularEntry()] }),
    technicalList({ entries: [regularEntry('secret.dat', { Encrypted: '+' })] }),
    Buffer.from(technicalList({ entries: [regularEntry()] }).toString('utf8').replace('Scanning the drive for archives:', 'Enter password (will not be echoed):'), 'utf8')
  ]) {
    await assert.rejects(parseSevenZipTechnicalList(Readable.from([bytes]), { maxBytes: bytes.length }), hasCode('ENCRYPTED_ARCHIVE'));
  }
});

test('link targets are retained as typed safety evidence for policy rejection', async () => {
  const fields = [
    'Path = link', 'Folder = -', 'Size = 6', 'Packed Size = 6',
    'Modified = 2026-08-02 04:06:08', 'Created = ', 'Accessed = ',
    'Attributes =  lrwxrwxrwx', 'Alternate Stream = -', 'Encrypted = -', 'Solid = -',
    'Split Before = -', 'Split After = -', 'CRC = 00000000', 'Host OS = Unix',
    'Method = v6:m0:128K', 'Characteristics = UnixTime', 'Symbolic Link = target',
    'Hard Link = ', 'Copy Link = ', 'Volume Index = 0', 'Checksum = ', 'NT Security = '
  ];
  const bytes = technicalList({
    archive: ['Characteristics = Locator', 'Encrypted = -', 'Solid = -', 'Blocks = 1', 'Method = v6:128K:m0', 'Multivolume = -', 'Volumes = 1'],
    entries: [fields]
  });
  const patched = Buffer.from(bytes.toString('utf8').replace('Type = zip', 'Type = Rar5'), 'utf8');
  const result = await parseSevenZipTechnicalList(Readable.from([patched]), { maxBytes: patched.length });
  assert.equal(result.entries[0].symbolicLink, 'target');
});

test('wrong engine version, malformed preamble/header separators, incomplete records, and trailing text fail', async () => {
  const validText = technicalList({ entries: [regularEntry()] }).toString('utf8');
  const cases = [
    validText.replace('7-Zip 26.02', '7-Zip 26.03'),
    validText.replace('\r\n--\r\n', '\r\n---\r\n'),
    validText.replace('\r\n----------\r\n', '\r\n---------\r\n'),
    validText.replace('\r\nFolder = -', '\r\nFolder = -\r\nPath = duplicate'),
    `${validText}Everything is Ok\r\n`,
    technicalList({ entries: [regularEntry()], terminalBlank: false }).toString('utf8')
  ];
  for (const value of cases) {
    const bytes = Buffer.from(value, 'utf8');
    await assert.rejects(parseSevenZipTechnicalList(Readable.from([bytes]), { maxBytes: bytes.length }), hasCode('EXTRACTOR_FAILED'));
  }
});

test('maxBytes is a closed non-negative integer contract', async () => {
  const bytes = technicalList({ entries: [regularEntry()] });
  for (const maxBytes of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '123']) {
    await assert.rejects(parseSevenZipTechnicalList(Readable.from([bytes]), { maxBytes }), hasCode('INVALID_REQUEST'));
  }
});
