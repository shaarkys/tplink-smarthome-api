const assert = require('node:assert/strict');
const test = require('node:test');
const { Client } = require('../lib');
const { normalizeSmartSysInfo } = require('../lib/smart-discovery');
const { isPlugSysinfo } = require('../lib/device');

test('TDP IOT discovery without feature flags remains a routable plug', () => {
  const info = normalizeSmartSysInfo({ device_id: 'discovery-hash', device_model: 'HS210(US)',
    device_type: 'IOT.SMARTPLUGSWITCH', mac: '00:11:22:33:44:55',
    mgt_encrypt_schm: { encrypt_type: 'KLAP', http_port: 80 } });
  assert.equal(info.feature, undefined);
  assert.equal(isPlugSysinfo(info), true);
  const client = new Client({ logLevel: 'silent' });
  const plug = client.getPlug({ host: '192.0.2.75', sysInfo: info });
  assert.equal(plug.defaultSendOptions.transport, 'klap');
  assert.equal(plug.defaultSendOptions.protocol, 'iot');
  assert.equal(isPlugSysinfo({ ...info, mgt_encrypt_schm: { encrypt_type: 'unknown' } }), false);
});

for (const transport of ['tcp', 'klap', 'aes']) {
  test(`IOT command format remains independent of ${transport} encryption`, async () => {
    const info = { err_code: 0, deviceId: 'hs210-parent', model: 'HS210(US)',
      type: 'IOT.SMARTPLUGSWITCH', alias: 'Switch', mac: '00:11:22:33:44:55',
      hw_ver: '3.0', sw_ver: '1.1.0', feature: 'TIM', relay_state: 1 };
    const client = new Client({ logLevel: 'silent', defaultSendOptions: { transport, protocol: 'iot' } });
    client.send = async payload => {
      assert.deepEqual(JSON.parse(payload), { system: { get_sysinfo: {} } });
      return JSON.stringify({ system: { get_sysinfo: info } });
    };
    assert.deepEqual(await client.getSysInfo('192.0.2.75'), info);
    const plug = client.getPlug({ host: '192.0.2.75', sysInfo: info });
    assert.equal(plug.port, transport === 'tcp' ? 9999 : 80);
    plug.send = async (payload, options) => {
      assert.equal(options.transport, transport);
      return JSON.stringify({ system: { get_sysinfo: info },
        cnCloud: { get_info: { err_code: 0 } }, emeter: { get_realtime: { err_code: -1 } },
        schedule: { get_next_action: { err_code: 0 } } });
    };
    assert.equal((await plug.getInfo()).sysInfo.deviceId, info.deviceId);
  });
}

test('discovery retains IOT protocol metadata alongside KLAP; default authenticated SMART remains unchanged', async () => {
  const client = new Client({ logLevel: 'silent' });
  const plug = client.getPlug({ host: '192.0.2.75', sysInfo: {
    deviceId: 'hash', model: 'HS210(US)', type: 'IOT.SMARTPLUGSWITCH',
    alias: 'Switch', mac: '00:11:22:33:44:55', hw_ver: '3.0', sw_ver: '1.1.0',
    feature: 'TIM', relay_state: 1, mgt_encrypt_schm: { encrypt_type: 'KLAP', http_port: 80 },
  } });
  assert.equal(plug.defaultSendOptions.protocol, 'iot');
  assert.equal(plug.defaultSendOptions.transport, 'klap');
  const smart = new Client({ logLevel: 'silent', defaultSendOptions: { transport: 'klap' } });
  smart.send = async request => {
    assert.equal(request.method, 'get_device_info');
    return JSON.stringify({ error_code: 0, result: { device_id: 'parent', model: 'KS240',
      type: 'SMART.KASASWITCH', mac: '00:11:22:33:44:55', device_on: true } });
  };
  assert.equal((await smart.getSysInfo('192.0.2.103')).deviceId, 'parent');
});
