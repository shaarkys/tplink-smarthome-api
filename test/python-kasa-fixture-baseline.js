/* eslint-disable no-unused-expressions */

const fs = require('fs');
const path = require('path');
const sinon = require('sinon');

const { expect } = require('./setup');
const { default: Client } = require('../src/client');

function loadFixture(fileName) {
  const fixturePath = path.join(
    __dirname,
    'fixtures',
    'python-kasa-smart',
    fileName,
  );
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

function toLegacyPlugSysInfo(fixture) {
  const discovery = fixture.discovery_result.result;
  const info = fixture.get_device_info;
  const children =
    fixture.get_child_device_list != null &&
    Array.isArray(fixture.get_child_device_list.child_device_list)
      ? fixture.get_child_device_list.child_device_list
      : [];

  return {
    alias: `${info.model} fixture`,
    deviceId: info.device_id,
    model: discovery.device_model,
    sw_ver: info.fw_ver,
    hw_ver: info.hw_ver,
    type: info.type,
    mac: info.mac,
    feature: 'TIM',
    relay_state: info.device_on ? 1 : 0,
    mgt_encrypt_schm: discovery.mgt_encrypt_schm,
    children: children.map((child) => ({
      id: child.device_id,
      alias: child.device_id,
      state: child.device_on ? 1 : 0,
      category: child.category,
      ...(typeof child.brightness === 'number'
        ? { brightness: child.brightness }
        : {}),
    })),
  };
}

describe('python-kasa fixture baseline', function () {
  it('infers AES transport defaults from KS240 fixture discovery metadata', function () {
    const fixture = loadFixture('KS240(US)_1.0_1.0.5.min.json');
    const sysInfo = toLegacyPlugSysInfo(fixture);
    const client = new Client({
      defaultSendOptions: { transport: 'tcp' },
    });

    const device = client.getPlug({ host: '127.0.0.1', sysInfo });
    expect(device.defaultSendOptions.transport).to.equal('aes');
    expect(device.port).to.equal(80);
    device.closeConnection();
  });

  it('infers KLAP transport defaults from KS225 fixture discovery metadata', function () {
    const fixture = loadFixture('KS225(US)_1.0_1.1.1.min.json');
    const sysInfo = toLegacyPlugSysInfo(fixture);
    const client = new Client({
      defaultSendOptions: { transport: 'tcp' },
    });

    const device = client.getPlug({ host: '127.0.0.1', sysInfo });
    expect(device.defaultSendOptions.transport).to.equal('klap');
    expect(device.port).to.equal(80);
    device.closeConnection();
  });

  it('infers AES transport defaults from S500D fixture discovery metadata', function () {
    const fixture = loadFixture('S500D(US)_1.0_1.0.5.min.json');
    const sysInfo = toLegacyPlugSysInfo(fixture);
    const client = new Client({
      defaultSendOptions: { transport: 'tcp' },
    });

    const device = client.getPlug({ host: '127.0.0.1', sysInfo });
    expect(device.defaultSendOptions.transport).to.equal('aes');
    expect(device.port).to.equal(80);
    device.closeConnection();
  });

  it('wraps KS240 child SMART calls in control_child using fixture child ids', async function () {
    const fixture = loadFixture('KS240(US)_1.0_1.0.5.min.json');
    const sysInfo = toLegacyPlugSysInfo(fixture);
    const childId =
      fixture.get_child_device_list.child_device_list[0].device_id;
    const client = new Client({
      defaultSendOptions: { transport: 'klap' },
    });

    const childDevice = client.getPlug({
      host: '127.0.0.1',
      sysInfo,
      childId,
    });

    const sendStub = sinon.stub(childDevice, 'send').resolves(
      JSON.stringify({
        error_code: 0,
        result: {
          responseData: {
            error_code: 0,
            result: { ack: true },
          },
        },
      }),
    );

    const response = await childDevice.sendSmartCommand('set_device_info', {
      device_on: true,
    });

    expect(response).to.deep.equal({ ack: true });
    expect(sendStub).to.have.been.calledOnce;
    expect(sendStub.firstCall.args[0]).to.containSubset({
      method: 'control_child',
      params: {
        device_id: childId,
        requestData: {
          method: 'set_device_info',
          params: { device_on: true },
        },
      },
    });
    childDevice.closeConnection();
  });

  it('routes KS240 child dimmer brightness through SMART set_device_info', async function () {
    const fixture = loadFixture('KS240(US)_1.0_1.0.5.min.json');
    const sysInfo = toLegacyPlugSysInfo(fixture);
    sysInfo.components = ['device', 'child_device', 'brightness'];
    sysInfo.children = sysInfo.children.map((child) => {
      if (child.category === 'kasa.switch.outlet.sub-dimmer') {
        return {
          ...child,
          components: ['device', 'brightness'],
        };
      }
      return {
        ...child,
        components: ['device', 'fan_control'],
      };
    });
    const childId =
      fixture.get_child_device_list.child_device_list[0].device_id;
    const client = new Client({
      defaultSendOptions: { transport: 'aes' },
    });

    const childDevice = client.getPlug({
      host: '127.0.0.1',
      sysInfo,
      childId,
    });

    const sendStub = sinon.stub(childDevice, 'send').resolves(
      JSON.stringify({
        error_code: 0,
        result: {
          responseData: {
            error_code: 0,
            result: { ack: true },
          },
        },
      }),
    );

    const response = await childDevice.dimmer.setBrightness(33);

    expect(response).to.deep.equal({ ack: true });
    expect(sendStub).to.have.been.calledOnce;
    expect(sendStub.firstCall.args[0]).to.containSubset({
      method: 'control_child',
      params: {
        device_id: childId,
        requestData: {
          method: 'set_device_info',
          params: { brightness: 33 },
        },
      },
    });
    expect(childDevice.dimmer.brightness).to.equal(33);
    childDevice.closeConnection();
  });
});
