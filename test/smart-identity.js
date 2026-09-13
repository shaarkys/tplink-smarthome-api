const assert = require('assert');
const { default: Client } = require('../src/client');

describe('authenticated SMART parent identity', function () {
  for (const transport of ['aes', 'klap']) {
    it(`replaces the discovery identity after ${transport} authentication without changing child identities`, async function () {
      const client = new Client({
        defaultSendOptions: { transport },
        logLevel: 'silent',
      });
      const sysInfo = {
        deviceId: 'discovery-hash',
        model: 'KS240(US)',
        alias: 'KS240',
        type: 'SMART.KASASWITCH',
        mac: '00:11:22:33:44:55',
        sw_ver: '1.0',
        hw_ver: '1.0',
        children: [{ id: 'child-device-id', state: 0, alias: 'Fan' }],
      };
      const plug = client.getPlug({ host: '192.0.2.103', sysInfo });
      plug.sendSmartRequests = async () => ({});
      plug.sendSmartCommand = async () => ({
        device_id: 'authenticated-parent-id',
        device_on: true,
      });
      const response = await plug.getSysInfo();
      assert.strictEqual(response.deviceId, 'authenticated-parent-id');
      assert.strictEqual(plug.deviceId, 'authenticated-parent-id');
      assert.strictEqual(response.relay_state, 1);
      assert.deepStrictEqual([...plug.children.keys()], ['child-device-id']);

      plug.applySmartDeviceInfoPartial(
        { device_id: 'child-device-id', device_on: false },
        'child-device-id',
      );
      assert.strictEqual(plug.deviceId, 'authenticated-parent-id');
      plug.applySmartDeviceInfoPartial({ device_id: '' });
      plug.applySmartDeviceInfoPartial({ brightness: 50 });
      assert.strictEqual(plug.deviceId, 'authenticated-parent-id');
    });
  }
});
