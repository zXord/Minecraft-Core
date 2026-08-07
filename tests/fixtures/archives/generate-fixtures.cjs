const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
const UTF8_FLAG = 1 << 11;
const ENCRYPTED_FLAG = 1;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32Update(value, byte) {
  return (CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)) >>> 0;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crc32Update(value, byte);
  return (value ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const result = Buffer.alloc(2);
  result.writeUInt16LE(value, 0);
  return result;
}

function u32(value) {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value >>> 0, 0);
  return result;
}

function u64(value) {
  const result = Buffer.alloc(8);
  result.writeBigUInt64LE(BigInt(value), 0);
  return result;
}

function zipCrypto(bytes, crc) {
  let key0 = 0x12345678;
  let key1 = 0x23456789;
  let key2 = 0x34567890;
  const update = byte => {
    key0 = crc32Update(key0, byte);
    key1 = (Math.imul((key1 + (key0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    key2 = crc32Update(key2, (key1 >>> 24) & 0xff);
  };
  const encrypt = plain => {
    const result = Buffer.alloc(plain.length);
    for (let index = 0; index < plain.length; index += 1) {
      const temporary = (key2 | 2) >>> 0;
      result[index] = plain[index] ^ ((Math.imul(temporary, temporary ^ 1) >>> 8) & 0xff);
      update(plain[index]);
    }
    return result;
  };
  const header = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, (crc >>> 24) & 0xff]);
  return Buffer.concat([encrypt(header), encrypt(bytes)]);
}

function zip(entries, { zip64 = false } = {}) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const source of entries) {
    const name = Buffer.from(source.name, 'utf8');
    const directory = source.directory === true || source.name.endsWith('/');
    const symbolicLink = typeof source.symbolicLink === 'string';
    const data = Buffer.from(symbolicLink ? source.symbolicLink : source.data ?? '');
    const method = directory || symbolicLink || source.store ? 0 : 8;
    const compressedPlain = method === 8
      ? zlib.deflateRawSync(data, { level: source.level ?? 9 })
      : data;
    const checksum = crc32(data);
    const flags = UTF8_FLAG | (source.encrypted ? ENCRYPTED_FLAG : 0);
    const compressed = source.encrypted ? zipCrypto(compressedPlain, checksum) : compressedPlain;
    const localExtra = zip64
      ? Buffer.concat([u16(0x0001), u16(16), u64(data.length), u64(compressed.length)])
      : Buffer.alloc(0);
    const localRecord = Buffer.concat([
      u32(0x04034b50), u16(zip64 ? 45 : 20), u16(flags), u16(method),
      u16(FIXED_DOS_TIME), u16(FIXED_DOS_DATE), u32(checksum),
      u32(zip64 ? 0xffffffff : compressed.length), u32(zip64 ? 0xffffffff : data.length),
      u16(name.length), u16(localExtra.length), name, localExtra, compressed
    ]);
    local.push(localRecord);

    const centralExtra = zip64
      ? Buffer.concat([u16(0x0001), u16(24), u64(data.length), u64(compressed.length), u64(offset)])
      : Buffer.alloc(0);
    const mode = symbolicLink ? 0o120777 : directory ? 0o40755 : 0o100644;
    const externalAttributes = ((mode << 16) | (directory ? 0x10 : 0)) >>> 0;
    central.push(Buffer.concat([
      u32(0x02014b50), u16((3 << 8) | (zip64 ? 45 : 20)), u16(zip64 ? 45 : 20),
      u16(flags), u16(method), u16(FIXED_DOS_TIME), u16(FIXED_DOS_DATE), u32(checksum),
      u32(zip64 ? 0xffffffff : compressed.length), u32(zip64 ? 0xffffffff : data.length),
      u16(name.length), u16(centralExtra.length), u16(0), u16(0), u16(0),
      u32(externalAttributes), u32(zip64 ? 0xffffffff : offset), name, centralExtra
    ]));
    offset += localRecord.length;
  }

  const centralBytes = Buffer.concat(central);
  const end = [];
  if (zip64) {
    const zip64Offset = offset + centralBytes.length;
    end.push(Buffer.concat([
      u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0),
      u64(entries.length), u64(entries.length), u64(centralBytes.length), u64(offset)
    ]));
    end.push(Buffer.concat([u32(0x07064b50), u32(0), u64(zip64Offset), u32(1)]));
    end.push(Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(0xffff), u16(0xffff),
      u32(0xffffffff), u32(0xffffffff), u16(0)
    ]));
  } else {
    end.push(Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
      u32(centralBytes.length), u32(offset), u16(0)
    ]));
  }
  return Buffer.concat([...local, centralBytes, ...end]);
}

function write(name, bytes) {
  fs.writeFileSync(path.join(__dirname, name), bytes);
}

const serverJar = zip([
  { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\r\nMain-Class: net.minecraft.server.Main\r\n\r\n', store: true },
  { name: 'version.json', data: JSON.stringify({ id: '1.21.1', name: '1.21.1', world_version: 3955, protocol_version: 767, java_version: 21 }), store: true }
]);

write('tiny.zip', zip([{ name: 'hello.txt', data: 'hello' }]));
write('tiny-zip64.zip', zip([{ name: 'hello.txt', data: 'zip64' }], { zip64: true }));
write('encrypted.zip', zip([{ name: 'secret.txt', data: 'secret', encrypted: true, store: true }]));
write('traversal.zip', zip([{ name: '../escape.txt', data: 'escape' }]));
write('unicode-alias.zip', zip([
  { name: 'mods/Café.jar', data: 'one' },
  { name: 'mods/Cafe\u0301.jar', data: 'two' }
]));
write('file-directory-collision.zip', zip([
  { name: 'a', data: 'file' },
  { name: 'a/b.txt', data: 'child' }
]));
write('symlink-metadata.zip', zip([{ name: 'server-link', symbolicLink: 'server.jar' }]));
write('high-ratio.zip', zip([{ name: 'bomb.bin', data: Buffer.alloc(64 * 1024 * 1024) }]));
write('prepared-vanilla.zip', zip([
  { name: 'server.jar', data: serverJar, store: true },
  { name: 'server.properties', data: 'motd=Fixture\n', store: true }
]));
write('installer-only.zip', zip([
  { name: 'forge-1.21.1-52.0.1-installer.jar', data: zip([{ name: 'install_profile.json', data: JSON.stringify({ version: '1.21.1-forge-52.0.1' }), store: true }]), store: true },
  { name: 'install.ps1', data: 'Write-Output "fixture only"\n', store: true }
]));
write('minecraft-core-backup.zip', zip([
  { name: '.minecraft-core.json', data: JSON.stringify({ version: '1.21.1', loader: 'vanilla', loaderVersion: '1.21.1', detectionMethod: 'automatic' }), store: true },
  { name: 'server.properties', data: 'motd=Backup fixture\n', store: true },
  { name: 'world/level.dat', data: 'fixture-level', store: true }
]));
write('client-only.mrpack', zip([{ name: 'modrinth.index.json', data: JSON.stringify({
  formatVersion: 1,
  game: 'minecraft',
  versionId: 'client-only-fixture',
  name: 'Client Only Fixture',
  files: [{
    path: 'mods/client.jar',
    hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
    env: { client: 'required', server: 'unsupported' },
    downloads: ['https://cdn.modrinth.com/data/fixture/versions/fixture/client.jar'],
    fileSize: 1
  }],
  dependencies: { minecraft: '1.21.1' }
}), store: true }]));
write('conflicting-loader.zip', zip([
  { name: 'fabric-server-launch.jar', data: 'fixture', store: true },
  { name: 'libraries/net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar', data: 'fixture', store: true },
  { name: 'libraries/net/neoforged/neoforge/21.1.1/win_args.txt', data: '-Dfixture=true', store: true }
]));
write('custom-bootstrap.zip', zip([
  { name: 'custom-wrapper.jar', data: 'unrecognized', store: true },
  { name: 'launch-custom.bat', data: '@echo off\r\njava -jar custom-wrapper.jar\r\n', store: true }
]));
write('ambiguous-roots.zip', zip([
  { name: 'one/server.jar', data: serverJar, store: true },
  { name: 'two/server.jar', data: serverJar, store: true }
]));
