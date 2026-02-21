const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

const { default: Client } = require('../../src/client');

const DEFAULT_TIMEOUT_SECONDS = 86400;
const SESSION_COOKIE_NAME = 'TP_SESSIONID';
const TIMEOUT_COOKIE_NAME = 'TIMEOUT';
const SIGNATURE_LENGTH = 32;

function sha256(payload) {
  return crypto.createHash('sha256').update(payload).digest();
}

function sha1(payload) {
  return crypto.createHash('sha1').update(payload).digest();
}

function md5(payload) {
  return crypto.createHash('md5').update(payload).digest();
}

function authHashV2(username, password) {
  return sha256(
    Buffer.concat([sha1(Buffer.from(username)), sha1(Buffer.from(password))]),
  );
}

function authHashV1(username, password) {
  return md5(
    Buffer.concat([md5(Buffer.from(username)), md5(Buffer.from(password))]),
  );
}

function signedInt32Buffer(value) {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(value, 0);
  return buf;
}

function deriveSession(localSeed, remoteSeed, authHash) {
  const key = sha256(
    Buffer.concat([Buffer.from('lsk'), localSeed, remoteSeed, authHash]),
  ).subarray(0, 16);
  const fullIv = sha256(
    Buffer.concat([Buffer.from('iv'), localSeed, remoteSeed, authHash]),
  );
  const ivPrefix = fullIv.subarray(0, 12);
  const signaturePrefix = sha256(
    Buffer.concat([Buffer.from('ldk'), localSeed, remoteSeed, authHash]),
  ).subarray(0, 28);
  return { key, ivPrefix, signaturePrefix };
}

function decryptRequestPayload(session, seq, payload) {
  const iv = Buffer.concat([session.ivPrefix, signedInt32Buffer(seq)]);
  const decipher = crypto.createDecipheriv('aes-128-cbc', session.key, iv);
  return Buffer.concat([
    decipher.update(payload.subarray(SIGNATURE_LENGTH)),
    decipher.final(),
  ]).toString('utf8');
}

function encryptResponsePayload(session, seq, payload) {
  const iv = Buffer.concat([session.ivPrefix, signedInt32Buffer(seq)]);
  const cipher = crypto.createCipheriv('aes-128-cbc', session.key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(payload, 'utf8')),
    cipher.final(),
  ]);
  const signature = sha256(
    Buffer.concat([
      session.signaturePrefix,
      signedInt32Buffer(seq),
      ciphertext,
    ]),
  );
  return Buffer.concat([signature, ciphertext]);
}

function createPlugSysInfo() {
  return {
    alias: 'Test Plug',
    deviceId: 'test-device-id',
    model: 'KS240(US)',
    sw_ver: '1.0.0',
    hw_ver: '1.0',
    type: 'IOT.SMARTPLUGSWITCH',
    mac: '00:11:22:33:44:55',
    feature: 'TIM',
    relay_state: 0,
    led_off: 0,
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function getCookieValue(req, name) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  const cookies = cookieHeader.split(';').map((entry) => entry.trim());
  const pair = cookies.find((entry) => entry.startsWith(`${name}=`));
  if (!pair) return undefined;
  return pair.substring(name.length + 1);
}

function createKlapTestServer({
  username = 'user@example.com',
  password = 'secret',
  loginVariant = 'v2',
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  forceFirstRequest403 = false,
} = {}) {
  const metrics = {
    handshake1Count: 0,
    handshake2Count: 0,
    requestCount: 0,
    requestAttemptCount: 0,
  };

  const handshakeState = new Map();
  const activeSessions = new Map();
  const remoteSeed = Buffer.alloc(16, 0x44);
  const expectedAuthHash =
    loginVariant === 'v1'
      ? authHashV1(username, password)
      : authHashV2(username, password);

  let request403AlreadySent = false;
  const responsePayload = '{"error_code":0,"result":{"ok":true}}';

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);

    if (req.url === '/app/handshake1') {
      metrics.handshake1Count += 1;
      const localSeed = body;
      const serverHash =
        loginVariant === 'v1'
          ? sha256(Buffer.concat([localSeed, expectedAuthHash]))
          : sha256(Buffer.concat([localSeed, remoteSeed, expectedAuthHash]));
      const sessionId = `sid-${metrics.handshake1Count}`;
      handshakeState.set(sessionId, {
        localSeed,
        remoteSeed,
        authHash: expectedAuthHash,
      });

      res.writeHead(200, {
        'Set-Cookie': [
          `${SESSION_COOKIE_NAME}=${sessionId}; Path=/`,
          `${TIMEOUT_COOKIE_NAME}=${timeoutSeconds}; Path=/`,
        ],
      });
      res.end(Buffer.concat([remoteSeed, serverHash]));
      return;
    }

    if (req.url === '/app/handshake2') {
      metrics.handshake2Count += 1;
      const sessionId = getCookieValue(req, SESSION_COOKIE_NAME);
      if (!sessionId || !handshakeState.has(sessionId)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const state = handshakeState.get(sessionId);
      const expectedPayload =
        loginVariant === 'v1'
          ? sha256(Buffer.concat([state.remoteSeed, state.authHash]))
          : sha256(
              Buffer.concat([
                state.remoteSeed,
                state.localSeed,
                state.authHash,
              ]),
            );
      if (!expectedPayload.equals(body)) {
        res.writeHead(403);
        res.end();
        return;
      }
      activeSessions.set(
        sessionId,
        deriveSession(state.localSeed, state.remoteSeed, state.authHash),
      );
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.url && req.url.startsWith('/app/request')) {
      metrics.requestAttemptCount += 1;

      if (forceFirstRequest403 && !request403AlreadySent) {
        request403AlreadySent = true;
        res.writeHead(403);
        res.end();
        return;
      }

      const sessionId = getCookieValue(req, SESSION_COOKIE_NAME);
      if (!sessionId || !activeSessions.has(sessionId)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const seqRaw = req.url.split('seq=')[1];
      const seq = Number.parseInt(seqRaw, 10);
      if (Number.isNaN(seq)) {
        res.writeHead(400);
        res.end();
        return;
      }

      const session = activeSessions.get(sessionId);
      decryptRequestPayload(session, seq, body);
      metrics.requestCount += 1;

      res.writeHead(200);
      res.end(encryptResponsePayload(session, seq, responsePayload));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const start = () =>
    new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve(server.address().port);
      });
    });
  const stop = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
    });

  return { metrics, start, stop };
}

function createKlapPlug(client, host, port) {
  return client.getPlug({
    host,
    port,
    sysInfo: createPlugSysInfo(),
  });
}

describe('KlapConnection', function () {
  it('defaults device port to 80 when client transport is klap', function () {
    const client = new Client({
      credentials: { username: 'user@example.com', password: 'secret' },
      defaultSendOptions: {
        timeout: 1500,
        transport: 'klap',
      },
    });
    const device = client.getPlug({
      host: '127.0.0.1',
      sysInfo: createPlugSysInfo(),
    });

    assert.strictEqual(device.port, 80);
    device.closeConnection();
  });

  it('reuses a KLAP session across sequential device.send calls', async function () {
    const server = createKlapTestServer();
    const port = await server.start();
    const client = new Client({
      credentials: { username: 'user@example.com', password: 'secret' },
      defaultSendOptions: {
        timeout: 1500,
        transport: 'klap',
      },
    });
    const device = createKlapPlug(client, '127.0.0.1', port);

    const first = await device.send('{"method":"first"}');
    const second = await device.send('{"method":"second"}');

    assert.strictEqual(first, '{"error_code":0,"result":{"ok":true}}');
    assert.strictEqual(second, '{"error_code":0,"result":{"ok":true}}');
    assert.strictEqual(server.metrics.handshake1Count, 1);
    assert.strictEqual(server.metrics.handshake2Count, 1);
    assert.strictEqual(server.metrics.requestCount, 2);

    device.closeConnection();
    await server.stop();
  });

  it('re-authenticates when session timeout expires', async function () {
    const server = createKlapTestServer({ timeoutSeconds: 1 });
    const port = await server.start();
    const client = new Client({
      credentials: { username: 'user@example.com', password: 'secret' },
      defaultSendOptions: {
        timeout: 1500,
        transport: 'klap',
      },
    });
    const device = createKlapPlug(client, '127.0.0.1', port);

    await device.send('{"method":"first"}');
    await new Promise((resolve) => {
      setTimeout(resolve, 1200);
    });
    await device.send('{"method":"second"}');

    assert.strictEqual(server.metrics.handshake1Count, 2);
    assert.strictEqual(server.metrics.handshake2Count, 2);
    assert.strictEqual(server.metrics.requestCount, 2);

    device.closeConnection();
    await server.stop();
  });

  it('retries with a fresh handshake after a 403 request response', async function () {
    const server = createKlapTestServer({ forceFirstRequest403: true });
    const port = await server.start();
    const client = new Client({
      credentials: { username: 'user@example.com', password: 'secret' },
      defaultSendOptions: {
        timeout: 1500,
        transport: 'klap',
      },
    });
    const device = createKlapPlug(client, '127.0.0.1', port);

    const response = await device.send('{"method":"one"}');

    assert.strictEqual(response, '{"error_code":0,"result":{"ok":true}}');
    assert.strictEqual(server.metrics.handshake1Count, 2);
    assert.strictEqual(server.metrics.handshake2Count, 2);
    assert.strictEqual(server.metrics.requestAttemptCount, 2);
    assert.strictEqual(server.metrics.requestCount, 1);

    device.closeConnection();
    await server.stop();
  });

  it('serializes concurrent send calls and keeps one shared session', async function () {
    const server = createKlapTestServer();
    const port = await server.start();
    const client = new Client({
      credentials: { username: 'user@example.com', password: 'secret' },
      defaultSendOptions: {
        timeout: 1500,
        transport: 'klap',
      },
    });
    const device = createKlapPlug(client, '127.0.0.1', port);

    const responses = await Promise.all(
      Array.from({ length: 5 }).map((_, index) =>
        device.send(`{"method":"cmd-${index}"}`),
      ),
    );

    responses.forEach((response) => {
      assert.strictEqual(response, '{"error_code":0,"result":{"ok":true}}');
    });
    assert.strictEqual(server.metrics.handshake1Count, 1);
    assert.strictEqual(server.metrics.handshake2Count, 1);
    assert.strictEqual(server.metrics.requestCount, 5);

    device.closeConnection();
    await server.stop();
  });

  it('supports credentialsHash authentication without plaintext credentials', async function () {
    const username = 'user@example.com';
    const password = 'secret';
    const server = createKlapTestServer({ username, password });
    const port = await server.start();
    const credentialsHash = authHashV2(username, password).toString('base64');
    const client = new Client({
      credentialsHash,
      defaultSendOptions: {
        timeout: 1500,
        transport: 'klap',
      },
    });
    const device = createKlapPlug(client, '127.0.0.1', port);

    const response = await device.send('{"method":"one"}');
    assert.strictEqual(response, '{"error_code":0,"result":{"ok":true}}');
    assert.strictEqual(server.metrics.handshake1Count, 1);
    assert.strictEqual(server.metrics.handshake2Count, 1);

    device.closeConnection();
    await server.stop();
  });

  it('fails predictably when credentials are invalid', async function () {
    const server = createKlapTestServer({
      username: 'correct@example.com',
      password: 'correct-secret',
    });
    const port = await server.start();
    const client = new Client({
      credentials: { username: 'wrong@example.com', password: 'wrong-secret' },
      defaultSendOptions: {
        timeout: 1500,
        transport: 'klap',
      },
    });
    const device = createKlapPlug(client, '127.0.0.1', port);

    await assert.rejects(
      async () => {
        await device.send('{"method":"one"}');
      },
      (error) => {
        assert.match(error.message, /authentication failed/i);
        return true;
      },
    );
    assert.strictEqual(server.metrics.handshake1Count, 1);
    assert.strictEqual(server.metrics.handshake2Count, 0);

    device.closeConnection();
    await server.stop();
  });
});
