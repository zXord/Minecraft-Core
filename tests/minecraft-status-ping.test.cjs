const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const {
  pingMinecraftStatus
} = require('../electron/services/minecraft-status-ping.cjs');

const MAX_STATUS_FRAME_BYTES = 1024 * 1024;

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

function decodeVarInt(buffer, offset = 0) {
  let value = 0;
  let position = 0;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    value |= (byte & 0x7f) << position;
    cursor += 1;
    if ((byte & 0x80) === 0) {
      return { bytes: cursor - offset, value: value | 0 };
    }
    position += 7;
    if (position >= 35) throw new Error('test VarInt overflow');
  }
  return null;
}

function frame(payload) {
  return Buffer.concat([encodeVarInt(payload.length), payload]);
}

function statusFrame(status) {
  const json = Buffer.from(JSON.stringify(status), 'utf8');
  return frame(Buffer.concat([encodeVarInt(0), encodeVarInt(json.length), json]));
}

function parseClientRequest(buffer) {
  const firstLength = decodeVarInt(buffer, 0);
  if (!firstLength || buffer.length < firstLength.bytes + firstLength.value) return null;
  const handshake = buffer.subarray(firstLength.bytes, firstLength.bytes + firstLength.value);
  let offset = 0;
  const packetId = decodeVarInt(handshake, offset);
  offset += packetId.bytes;
  const protocol = decodeVarInt(handshake, offset);
  offset += protocol.bytes;
  const hostLength = decodeVarInt(handshake, offset);
  offset += hostLength.bytes;
  const host = handshake.subarray(offset, offset + hostLength.value).toString('utf8');
  offset += hostLength.value;
  const port = handshake.readUInt16BE(offset);
  offset += 2;
  const nextState = decodeVarInt(handshake, offset);
  offset += nextState.bytes;
  assert.equal(offset, handshake.length);

  const secondOffset = firstLength.bytes + firstLength.value;
  const secondLength = decodeVarInt(buffer, secondOffset);
  if (!secondLength || buffer.length < secondOffset + secondLength.bytes + secondLength.value) return null;
  const request = buffer.subarray(
    secondOffset + secondLength.bytes,
    secondOffset + secondLength.bytes + secondLength.value
  );
  const requestId = decodeVarInt(request, 0);
  assert.equal(requestId.bytes, request.length);
  return {
    host,
    nextState: nextState.value,
    packetId: packetId.value,
    port,
    protocol: protocol.value,
    requestId: requestId.value
  };
}

async function withTcpServer(onSocket, work) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    onSocket(socket);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    return await work(address.port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

function healthFailure(error) {
  return error && error.code === 'HEALTH_CHECK_FAILED';
}

test('status ping writes the protocol handshake/request and accepts a fragmented response that closes', async () => {
  let requestEvidence = null;
  let expectedPort = null;
  await withTcpServer(socket => {
    let request = Buffer.alloc(0);
    socket.on('data', chunk => {
      request = Buffer.concat([request, chunk]);
      const parsed = parseClientRequest(request);
      if (!parsed || requestEvidence) return;
      requestEvidence = parsed;
      const response = statusFrame({
        version: { name: '1.21.1', protocol: 767 },
        players: { max: 20, online: 3 },
        description: {
          text: 'minecraft-core-health:',
          extra: [{ text: 'nonce-123' }]
        },
        favicon: 'data:image/png;base64,not-returned'
      });
      socket.write(response.subarray(0, 1));
      setImmediate(() => {
        socket.write(response.subarray(1, 7));
        setImmediate(() => socket.end(response.subarray(7)));
      });
    });
  }, async port => {
    expectedPort = port;
    const result = await pingMinecraftStatus({
      host: '127.0.0.1',
      port,
      timeoutMs: 1000,
      protocolVersion: -1
    });
    assert.deepEqual(result, {
      description: 'minecraft-core-health:nonce-123',
      players: { max: 20, online: 3 },
      version: { name: '1.21.1', protocol: 767 }
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.players), true);
    assert.equal(Object.isFrozen(result.version), true);
  });

  assert.deepEqual(requestEvidence, {
    host: '127.0.0.1',
    nextState: 1,
    packetId: 0,
    port: expectedPort,
    protocol: -1,
    requestId: 0
  });
});

test('status ping encodes both signed and positive five-byte VarInt protocol boundaries', async () => {
  const observed = [];
  await withTcpServer(socket => {
    let request = Buffer.alloc(0);
    socket.on('data', chunk => {
      request = Buffer.concat([request, chunk]);
      const parsed = parseClientRequest(request);
      if (!parsed) return;
      observed.push(parsed.protocol);
      socket.end(statusFrame({ description: 'ok' }));
    });
  }, async port => {
    await pingMinecraftStatus({ host: '127.0.0.1', port, timeoutMs: 1000, protocolVersion: -2147483648 });
    await pingMinecraftStatus({ host: '127.0.0.1', port, timeoutMs: 1000, protocolVersion: 2147483647 });
  });
  assert.deepEqual(observed, [-2147483648, 2147483647]);
});

test('status ping rejects malformed VarInts, bounded frames/strings, invalid JSON, and trailing bytes', async t => {
  const malformed = [
    {
      name: 'six-byte VarInt',
      bytes: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0x01])
    },
    {
      name: 'oversized frame',
      bytes: encodeVarInt(MAX_STATUS_FRAME_BYTES + 1)
    },
    {
      name: 'wrong packet id',
      bytes: frame(Buffer.concat([encodeVarInt(1), encodeVarInt(2), Buffer.from('{}')]))
    },
    {
      name: 'string exceeds frame',
      bytes: frame(Buffer.concat([encodeVarInt(0), encodeVarInt(50), Buffer.from('{}')]))
    },
    {
      name: 'invalid utf8',
      bytes: frame(Buffer.concat([encodeVarInt(0), encodeVarInt(2), Buffer.from([0xc3, 0x28])]))
    },
    {
      name: 'invalid json',
      bytes: frame(Buffer.concat([encodeVarInt(0), encodeVarInt(1), Buffer.from('{')]))
    },
    {
      name: 'trailing packet bytes',
      bytes: frame(Buffer.concat([encodeVarInt(0), encodeVarInt(2), Buffer.from('{}'), Buffer.from([0])]))
    }
  ];

  for (const scenario of malformed) {
    await t.test(scenario.name, async () => {
      await withTcpServer(socket => {
        socket.once('data', () => socket.end(scenario.bytes));
      }, async port => {
        await assert.rejects(
          pingMinecraftStatus({ host: '127.0.0.1', port, timeoutMs: 500 }),
          healthFailure
        );
      });
    });
  }
});

test('status ping rejects a premature close and never leaks response bytes through its error', async () => {
  const secret = 'https://example.invalid/download?token=secret C:\\private\\server';
  await withTcpServer(socket => {
    socket.once('data', () => {
      const body = Buffer.from(`{"description":"${secret}`);
      const payload = Buffer.concat([encodeVarInt(0), encodeVarInt(body.length + 20), body]);
      socket.end(Buffer.concat([encodeVarInt(payload.length + 20), payload]));
    });
  }, async port => {
    await assert.rejects(
      pingMinecraftStatus({ host: '127.0.0.1', port, timeoutMs: 500 }),
      error => {
        assert.equal(error.code, 'HEALTH_CHECK_FAILED');
        assert.equal(error.message.includes('secret'), false);
        assert.equal(error.message.includes('private'), false);
        assert.equal(JSON.stringify(error.details || {}).includes('secret'), false);
        return true;
      }
    );
  });
});

test('status ping enforces one deadline and cancellation before and during I/O', async () => {
  await withTcpServer(() => {}, async port => {
    const started = Date.now();
    await assert.rejects(
      pingMinecraftStatus({ host: '127.0.0.1', port, timeoutMs: 30 }),
      healthFailure
    );
    assert.ok(Date.now() - started < 500);
  });

  let connections = 0;
  await withTcpServer(socket => {
    connections += 1;
    socket.resume();
  }, async port => {
    const before = new AbortController();
    before.abort();
    await assert.rejects(
      pingMinecraftStatus({ host: '127.0.0.1', port, timeoutMs: 500, signal: before.signal }),
      error => error.code === 'CANCELLED'
    );
    assert.equal(connections, 0);

    const during = new AbortController();
    const pending = pingMinecraftStatus({ host: '127.0.0.1', port, timeoutMs: 500, signal: during.signal });
    await new Promise(resolve => setImmediate(resolve));
    during.abort();
    await assert.rejects(pending, error => error.code === 'CANCELLED');
  });
});

test('status ping validates a closed bounded request before opening a socket', async () => {
  const invalid = [
    { host: '', port: 25565, timeoutMs: 100 },
    { host: '127.0.0.1', port: 0, timeoutMs: 100 },
    { host: '127.0.0.1', port: 65536, timeoutMs: 100 },
    { host: '127.0.0.1', port: 25565, timeoutMs: 0 },
    { host: '127.0.0.1', port: 25565, timeoutMs: 100, protocolVersion: 2147483648 },
    { host: '127.0.0.1', port: 25565, timeoutMs: 100, extra: true }
  ];
  for (const request of invalid) {
    await assert.rejects(pingMinecraftStatus(request), error => error.code === 'INVALID_REQUEST');
  }
});
