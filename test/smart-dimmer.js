/* eslint-disable no-await-in-loop */
const assert = require('assert');
const { default: Client } = require('../src/client');

function createPlug(transport, protocol, childId) {
  const client = new Client({
    logLevel: 'silent',
    defaultSendOptions: { transport, protocol },
  });
  return client.getPlug({
    host: '192.0.2.112',
    childId,
    sysInfo: {
      deviceId: 'dimmer-parent',
      model: childId ? 'KS240(US)' : 'HS220(US)',
      type: protocol === 'smart' ? 'SMART.KASASWITCH' : 'IOT.SMARTPLUGSWITCH',
      alias: 'Dimmer',
      mac: '00:11:22:33:44:55',
      hw_ver: '1.0',
      sw_ver: '1.0',
      feature: 'TIM',
      relay_state: 1,
      brightness: 70,
      components: ['device', 'brightness'],
      ...(childId
        ? {
            children: [
              {
                id: childId,
                state: 1,
                brightness: 45,
                components: ['device', 'brightness'],
                category: 'kasa.switch.outlet.sub-dimmer',
              },
              {
                id: 'other-child',
                state: 1,
                brightness: 80,
                components: ['device', 'brightness'],
              },
            ],
          }
        : {}),
    },
  });
}

describe('SMART dimmer zero brightness', function () {
  for (const transport of ['aes', 'klap']) {
    for (const childId of [undefined, 'light-child']) {
      const scope = childId ? 'child' : 'parent';
      it(`${transport} ${scope}: turns off, preserves saved brightness and forwards options`, async function () {
        const plug = createPlug(transport, 'smart', childId);
        const sent = [];
        const options = { timeout: 1234 };
        plug.send = async (payload, sendOptions) => {
          assert.strictEqual(sendOptions.timeout, options.timeout);
          assert.strictEqual(sendOptions.transport, transport);
          if (childId) {
            assert.strictEqual(payload.method, 'control_child');
            assert.strictEqual(payload.params.device_id, childId);
          }
          sent.push(childId ? payload.params.requestData : payload);
          const response = { error_code: 0, result: { ack: true } };
          return JSON.stringify(
            childId
              ? { error_code: 0, result: { responseData: response } }
              : response,
          );
        };

        for (const brightness of [1, 100, 0]) {
          const response = await plug.dimmer.setBrightness(brightness, options);
          assert.deepStrictEqual(response, { ack: true });
          assert.strictEqual(sent[sent.length - 1].method, 'set_device_info');
          assert.deepStrictEqual(
            sent[sent.length - 1].params,
            brightness === 0 ? { device_on: false } : { brightness },
          );
        }
        assert.strictEqual(sent.length, 3);
        assert.strictEqual(plug.dimmer.brightness, 100);
        if (childId) {
          assert.strictEqual(plug.children.get(childId).state, 0);
          assert.strictEqual(plug.children.get('other-child').state, 1);
          assert.strictEqual(plug.children.get('other-child').brightness, 80);
          assert.strictEqual(plug.sysInfo.relay_state, 1);
          assert.strictEqual(plug.sysInfo.brightness, 70);
        } else {
          assert.strictEqual(plug.sysInfo.relay_state, 0);
        }
      });

      it(`${transport} ${scope}: a rejected off command leaves cached state unchanged`, async function () {
        const plug = createPlug(transport, 'smart', childId);
        const before = JSON.stringify(plug.sysInfo);
        plug.send = async () => JSON.stringify({ error_code: -1008 });
        await assert.rejects(plug.dimmer.setBrightness(0), /-1008/);
        assert.strictEqual(JSON.stringify(plug.sysInfo), before);
        assert.strictEqual(plug.dimmer.brightness, childId ? 45 : 70);
      });
    }
  }

  for (const transport of ['tcp', 'aes', 'klap']) {
    it(`preserves the legacy IOT zero-brightness command over ${transport}`, async function () {
      const plug = createPlug(transport, 'iot');
      let calls = 0;
      plug.send = async (payload) => {
        calls += 1;
        const request =
          typeof payload === 'string' ? JSON.parse(payload) : payload;
        assert.deepStrictEqual(request, {
          'smartlife.iot.dimmer': { set_brightness: { brightness: 0 } },
        });
        return JSON.stringify({
          'smartlife.iot.dimmer': { set_brightness: { err_code: 0 } },
        });
      };
      await plug.dimmer.setBrightness(0);
      assert.strictEqual(calls, 1);
      assert.strictEqual(plug.dimmer.brightness, 0);
      assert.strictEqual(plug.sysInfo.relay_state, 1);
    });
  }
});
