const assert = require('node:assert/strict');
const { createPublicKey } = require('node:crypto');
const dgram = require('node:dgram');
const EventEmitter = require('node:events');
const test = require('node:test');

const { default: Client } = require('../src/client');
const {
  calculateTdpCrc32,
  parseSmartDiscoveryPacket,
} = require('../src/smart-discovery');

class FakeDiscoverySocket extends EventEmitter {
  constructor() {
    super();
    this.packets = [];
  }

  bind(...args) {
    const callback = args.find((arg) => typeof arg === 'function');
    this.bound = true;
    callback();
  }

  address() {
    return { address: '0.0.0.0', family: 'IPv4', port: this.port };
  }

  setBroadcast(value) {
    this.broadcast = value;
  }

  send(message, offset, length, port, address) {
    this.packets.push({
      message: Buffer.from(message.subarray(offset, offset + length)),
      port,
      address,
    });
  }

  close() {
    this.closed = true;
  }
}

function createTdpResponse(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const packet = Buffer.alloc(16 + body.length);
  packet.writeUInt8(2, 0);
  packet.writeUInt8(1, 1);
  packet.writeUInt16BE(2, 2);
  packet.writeUInt16BE(body.length, 4);
  packet.writeUInt8(17, 6);
  packet.writeUInt8(0, 7);
  packet.writeUInt32BE(0x12345678, 8);
  packet.writeUInt32BE(0x5a6b7c8d, 12);
  body.copy(packet, 16);
  packet.writeUInt32BE(calculateTdpCrc32(packet), 12);
  return packet;
}

function waitForEvent(emitter, eventName) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, 500);
    emitter.once(eventName, (value) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
}

test('uses SMART get_device_info and python-kasa-compatible TDP v2 discovery ports', async (t) => {
  const client = new Client({
    defaultSendOptions: { transport: 'aes' },
  });
  const sentRequests = [];
  client.createConnection = () => ({
    send: async (payload, port, host) => {
      sentRequests.push({ payload, port, host });
      return JSON.stringify({
        error_code: 0,
        result: {
          device_id: 'smart-device-id',
          fw_ver: '1.0.0',
          hw_ver: '1.0',
          mac: '00-11-22-33-44-55',
          model: 'S500D',
          type: 'SMART.KASASWITCH',
          nickname: Buffer.from('SMART test device').toString('base64'),
          device_on: true,
        },
      });
    },
    close: () => {},
  });

  const sysInfo = await client.getSysInfo('192.0.2.10');
  assert.equal(sentRequests.length, 1);
  assert.deepEqual(JSON.parse(sentRequests[0].payload), {
    method: 'get_device_info',
  });
  assert.equal(sentRequests[0].port, 80);
  assert.equal(sysInfo.alias, 'SMART test device');
  assert.equal(sysInfo.relay_state, 1);
  assert.deepEqual(sysInfo.mgt_encrypt_schm, {
    encrypt_type: 'AES',
    http_port: 80,
  });

  const socket = new FakeDiscoverySocket();
  const originalCreateSocket = dgram.createSocket;
  dgram.createSocket = () => socket;
  t.after(() => {
    dgram.createSocket = originalCreateSocket;
    client.stopDiscovery();
  });

  const discovered = waitForEvent(client, 'plug-new');
  client.startDiscovery({
    devices: [{ host: '192.0.2.11' }],
    devicesUseDiscoveryPort: true,
  });

  const ports = socket.packets.map((packet) => packet.port);
  assert.ok(ports.includes(9999));
  assert.ok(ports.includes(20002));
  assert.ok(ports.includes(20004));
  const smartProbe = socket.packets.find((packet) => packet.port === 20002);
  const smartProbeAlternate = socket.packets.find(
    (packet) => packet.port === 20004,
  );
  assert.deepEqual(smartProbeAlternate.message, smartProbe.message);
  const parsedProbe = parseSmartDiscoveryPacket(smartProbe.message);
  assert.deepEqual(
    {
      version: parsedProbe.version,
      messageType: parsedProbe.messageType,
      opcode: parsedProbe.opcode,
      flags: parsedProbe.flags,
    },
    { version: 2, messageType: 0, opcode: 1, flags: 17 },
  );
  const rsaKey = parsedProbe.payload.params.rsa_key;
  assert.equal(typeof rsaKey, 'string');
  assert.equal(
    createPublicKey(rsaKey).asymmetricKeyDetails.modulusLength,
    2048,
  );

  const smartResponse = createTdpResponse({
    error_code: 0,
    result: {
      device_id: 'discovered-smart-device',
      fw_ver: '1.0.0',
      hw_ver: '1.0',
      mac: '00-11-22-33-44-66',
      mgt_encrypt_schm: { encrypt_type: 'KLAP', http_port: 80 },
      model: 'KS225',
      type: 'SMART.KASASWITCH',
      nickname: Buffer.from('Discovered SMART device').toString('base64'),
    },
  });
  socket.emit('message', smartResponse, {
    address: '192.0.2.11',
    family: 'IPv4',
    port: 20002,
    size: 0,
  });

  const plug = await discovered;
  assert.equal(plug.port, 80);
  assert.equal(plug.defaultSendOptions.transport, 'klap');
  assert.equal(plug.sysInfo.alias, 'Discovered SMART device');
  const rediscovered = waitForEvent(client, 'plug-online');
  socket.emit('message', smartResponse, {
    address: '192.0.2.11',
    family: 'IPv4',
    port: 20004,
    size: 0,
  });
  assert.strictEqual(await rediscovered, plug);
  plug.closeConnection();
});
