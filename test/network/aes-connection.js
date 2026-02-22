const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

const { default: Client } = require('../../src/client');

const DEFAULT_TIMEOUT_SECONDS = 86400;
const SESSION_COOKIE_NAME = 'TP_SESSIONID';
const TIMEOUT_COOKIE_NAME = 'TIMEOUT';

function sha1Hex(payload) {
  return crypto.createHash('sha1').update(payload).digest('hex');
}

function base64Encode(payload) {
  return Buffer.from(payload, 'utf8').toString('base64');
}

function expectedLoginParams(username, password, loginVariant) {
  const hashedUsername = base64Encode(sha1Hex(username));
  if (loginVariant === 'v1') {
    return { username: hashedUsername, password: base64Encode(password) };
  }
  return {
    username: hashedUsername,
    password2: base64Encode(sha1Hex(password)),
  };
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
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
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

function encryptPayload(session, payload) {
  const cipher = crypto.createCipheriv('aes-128-cbc', session.key, session.iv);
  return Buffer.concat([
    cipher.update(Buffer.from(payload, 'utf8')),
    cipher.final(),
  ]).toString('base64');
}

function decryptPayload(session, payload) {
  const decipher = crypto.createDecipheriv(
    'aes-128-cbc',
    session.key,
    session.iv,
  );
  return Buffer.concat([
    decipher.update(Buffer.from(payload, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function createAesTestServer({
  username = 'user@example.com',
  password = 'secret',
  loginVariant = 'v2',
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  requestHandler,
} = {}) {
  const metrics = {
    handshakeCount: 0,
    passthroughCount: 0,
    loginCount: 0,
    requestCount: 0,
  };
  const requests = [];
  const sessions = new Map();
  const expectedLogin = expectedLoginParams(username, password, loginVariant);

  const server = http.createServer(async (req, res) => {
    const bodyString = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(bodyString);
    } catch (_error) {
      res.writeHead(400);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    if (requestUrl.pathname !== '/app') {
      res.writeHead(404);
      res.end();
      return;
    }

    if (payload.method === 'handshake') {
      metrics.handshakeCount += 1;
      if (
        !payload.params ||
        typeof payload.params !== 'object' ||
        typeof payload.params.key !== 'string'
      ) {
        res.writeHead(400);
        res.end();
        return;
      }

      const sessionId = `sid-${metrics.handshakeCount}`;
      const key = crypto.randomBytes(16);
      const iv = crypto.randomBytes(16);
      sessions.set(sessionId, { key, iv, token: undefined });

      const encryptedKey = crypto
        .publicEncrypt(
          {
            key: payload.params.key,
            padding: crypto.constants.RSA_PKCS1_PADDING,
          },
          Buffer.concat([key, iv]),
        )
        .toString('base64');

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': [
          `${SESSION_COOKIE_NAME}=${sessionId}; Path=/`,
          `${TIMEOUT_COOKIE_NAME}=${timeoutSeconds}; Path=/`,
        ],
      });
      res.end(JSON.stringify({ error_code: 0, result: { key: encryptedKey } }));
      return;
    }

    if (payload.method !== 'securePassthrough') {
      res.writeHead(404);
      res.end();
      return;
    }

    metrics.passthroughCount += 1;
    const sessionId = getCookieValue(req, SESSION_COOKIE_NAME);
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const session = sessions.get(sessionId);

    if (
      !payload.params ||
      typeof payload.params !== 'object' ||
      typeof payload.params.request !== 'string'
    ) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error_code: -1008 }));
      return;
    }

    let decryptedRequest;
    try {
      decryptedRequest = decryptPayload(session, payload.params.request);
    } catch (_error) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error_code: -1005 }));
      return;
    }
    requests.push(decryptedRequest);

    let parsedRequest;
    try {
      parsedRequest = JSON.parse(decryptedRequest);
    } catch (_error) {
      parsedRequest = undefined;
    }

    let innerResponse;
    if (parsedRequest && parsedRequest.method === 'login_device') {
      metrics.loginCount += 1;
      const loginParams = parsedRequest.params || {};
      const validLogin =
        loginParams.username === expectedLogin.username &&
        ((loginVariant === 'v2' &&
          loginParams.password2 === expectedLogin.password2) ||
          (loginVariant === 'v1' &&
            loginParams.password === expectedLogin.password));

      if (validLogin) {
        session.token = `token-${sessionId}`;
        innerResponse = { error_code: 0, result: { token: session.token } };
      } else {
        innerResponse = { error_code: -1501 };
      }
    } else {
      if (
        session.token == null ||
        requestUrl.searchParams.get('token') !== session.token
      ) {
        innerResponse = { error_code: -1501 };
      } else if (typeof requestHandler === 'function') {
        const customResponse = requestHandler(parsedRequest, decryptedRequest);
        innerResponse =
          customResponse === undefined
            ? { error_code: 0, result: { ok: true } }
            : customResponse;
      } else {
        innerResponse = { error_code: 0, result: { ok: true } };
      }
      metrics.requestCount += 1;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error_code: 0,
        result: {
          response: encryptPayload(session, JSON.stringify(innerResponse)),
        },
      }),
    );
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

  return { metrics, requests, start, stop };
}

function createAesPlug(client, host, port) {
  return client.getPlug({
    host,
    port,
    sysInfo: createPlugSysInfo(),
  });
}

describe('AesConnection', function () {
  it('defaults device port to 80 when client transport is aes', function () {
    const client = new Client({
      credentials: { username: 'user@example.com', password: 'secret' },
      defaultSendOptions: {
        timeout: 1500,
        transport: 'aes',
      },
    });
    const device = client.getPlug({
      host: '127.0.0.1',
      sysInfo: createPlugSysInfo(),
    });

    assert.strictEqual(device.port, 80);
    device.closeConnection();
  });

  it('reuses AES handshake/login session across sequential device.send calls', async function () {
    const server = createAesTestServer();
    const port = await server.start();
    const client = new Client({
      credentials: { username: 'user@example.com', password: 'secret' },
      defaultSendOptions: { timeout: 1500, transport: 'aes' },
    });
    const device = createAesPlug(client, '127.0.0.1', port);

    const first = await device.send('{"method":"first"}');
    const second = await device.send('{"method":"second"}');

    assert.deepStrictEqual(JSON.parse(first), {
      error_code: 0,
      result: { ok: true },
    });
    assert.deepStrictEqual(JSON.parse(second), {
      error_code: 0,
      result: { ok: true },
    });
    assert.strictEqual(server.metrics.handshakeCount, 1);
    assert.strictEqual(server.metrics.loginCount, 1);
    assert.strictEqual(server.metrics.requestCount, 2);

    device.closeConnection();
    await server.stop();
  });

  it('re-authenticates when AES session timeout expires', async function () {
    const server = createAesTestServer({ timeoutSeconds: 1 });
    const port = await server.start();
    const client = new Client({
      credentials: { username: 'user@example.com', password: 'secret' },
      defaultSendOptions: { timeout: 1500, transport: 'aes' },
    });
    const device = createAesPlug(client, '127.0.0.1', port);

    await device.send('{"method":"first"}');
    await new Promise((resolve) => {
      setTimeout(resolve, 1200);
    });
    await device.send('{"method":"second"}');

    assert.strictEqual(server.metrics.handshakeCount, 2);
    assert.strictEqual(server.metrics.loginCount, 2);
    assert.strictEqual(server.metrics.requestCount, 2);

    device.closeConnection();
    await server.stop();
  });

  it('supports SMART requests over AES transport', async function () {
    const server = createAesTestServer({
      requestHandler(request) {
        if (request && request.method === 'get_device_info') {
          return { error_code: 0, result: { model: 'KS240', via: 'aes' } };
        }
        return { error_code: 0, result: {} };
      },
    });
    const port = await server.start();
    const client = new Client({
      credentials: { username: 'user@example.com', password: 'secret' },
    });
    const device = client.getPlug({
      host: '127.0.0.1',
      port,
      sysInfo: {
        ...createPlugSysInfo(),
        mgt_encrypt_schm: { encrypt_type: 'AES', http_port: port, lv: 2 },
      },
    });

    const response = await device.sendSmartCommand('get_device_info');

    assert.deepStrictEqual(response, { model: 'KS240', via: 'aes' });

    device.closeConnection();
    await server.stop();
  });

  it('supports SMART client.sendSmart() using client default aes transport', async function () {
    const server = createAesTestServer({
      requestHandler(request) {
        if (request && request.method === 'get_device_info') {
          return { error_code: 0, result: { via: 'client.sendSmart.aes' } };
        }
        return { error_code: 0, result: {} };
      },
    });
    const port = await server.start();
    const client = new Client({
      credentials: { username: 'user@example.com', password: 'secret' },
      defaultSendOptions: { transport: 'aes' },
    });

    const response = await client.sendSmart(
      { method: 'get_device_info' },
      '127.0.0.1',
      port,
    );

    assert.deepStrictEqual(response, {
      error_code: 0,
      result: { via: 'client.sendSmart.aes' },
    });

    await server.stop();
  });

  it('supports AES credentialsHash login params without plaintext credentials', async function () {
    const username = 'user@example.com';
    const password = 'secret';
    const server = createAesTestServer({
      username,
      password,
      loginVariant: 'v2',
    });
    const port = await server.start();

    const credentialsHash = Buffer.from(
      JSON.stringify(expectedLoginParams(username, password, 'v2')),
      'utf8',
    ).toString('base64');
    const client = new Client({
      credentialsHash,
      defaultSendOptions: { timeout: 1500, transport: 'aes' },
    });
    const device = createAesPlug(client, '127.0.0.1', port);

    const response = await device.send('{"method":"one"}');
    assert.deepStrictEqual(JSON.parse(response), {
      error_code: 0,
      result: { ok: true },
    });
    assert.strictEqual(server.metrics.handshakeCount, 1);
    assert.strictEqual(server.metrics.loginCount, 1);

    device.closeConnection();
    await server.stop();
  });

  it('fails predictably when AES credentials are invalid', async function () {
    const server = createAesTestServer({
      username: 'correct@example.com',
      password: 'correct-secret',
    });
    const port = await server.start();
    const client = new Client({
      credentials: { username: 'wrong@example.com', password: 'wrong-secret' },
      defaultSendOptions: { timeout: 1500, transport: 'aes' },
    });
    const device = createAesPlug(client, '127.0.0.1', port);

    await assert.rejects(
      async () => {
        await device.send('{"method":"one"}');
      },
      (error) => {
        assert.match(error.message, /login failed with error_code -1501/i);
        return true;
      },
    );
    assert.ok(server.metrics.handshakeCount >= 1);
    assert.ok(server.metrics.loginCount >= 4);

    device.closeConnection();
    await server.stop();
  });
});
