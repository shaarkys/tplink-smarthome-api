/* eslint-disable no-unused-expressions */

const sinon = require('sinon');
const dgram = require('dgram');
const EventEmitter = require('events');
const { encrypt } = require('tplink-smarthome-crypto');

const { config, expect, getTestClient, testDevices } = require('./setup');

const { default: Client } = require('../src/client');
const { default: Device } = require('../src/device');
const { default: Plug } = require('../src/plug');
const { default: Bulb } = require('../src/bulb');

const { compareMac } = require('../src/utils');

const validPlugDiscoveryResponse = {
  system: {
    get_sysinfo: {
      alias: 'test',
      deviceId: 'test',
      model: 'test',
      sw_ver: 'test',
      hw_ver: 'test',
      type: 'plug',
      mac: 'test',
      feature: 'test',
      relay_state: 0,
    },
  },
};

describe('Client', function () {
  describe('constructor', function () {
    it('should use custom logger', function () {
      const debugSpy = sinon.spy();
      const infoSpy = sinon.spy();

      const logger = {
        debug: debugSpy,
        info: infoSpy,
      };

      const client = new Client({ logger });

      client.log.debug('debug msg');
      client.log.info('info msg');

      expect(debugSpy).to.be.calledOnce;
      expect(infoSpy).to.be.calledOnce;
    });

    it('should accept credentials and credentialsHash', function () {
      const client = new Client({
        credentials: { username: 'user@example.com', password: 'secret' },
        credentialsHash: 'hash123',
      });
      expect(client.credentials).to.deep.equal({
        username: 'user@example.com',
        password: 'secret',
      });
      expect(client.credentialsHash).to.equal('hash123');
    });

    it('should reject partial credentials', function () {
      expect(
        () =>
          new Client({
            credentials: { username: 'user@example.com' },
          }),
      ).to.throw(TypeError, 'credentials.password is required');
    });

    it('should apply credential precedence from client to device with device override', function () {
      const client = new Client({
        credentials: { username: 'client-user', password: 'client-pass' },
        credentialsHash: 'client-hash',
      });
      const sysInfo = validPlugDiscoveryResponse.system.get_sysinfo;

      const plugDefault = client.getDeviceFromSysInfo(sysInfo, {
        host: '127.0.0.1',
      });
      expect(plugDefault.credentials).to.deep.equal({
        username: 'client-user',
        password: 'client-pass',
      });
      expect(plugDefault.credentialsHash).to.equal('client-hash');

      const plugOverride = client.getDeviceFromSysInfo(sysInfo, {
        host: '127.0.0.1',
        credentials: { username: 'device-user', password: 'device-pass' },
        credentialsHash: 'device-hash',
      });
      expect(plugOverride.credentials).to.deep.equal({
        username: 'device-user',
        password: 'device-pass',
      });
      expect(plugOverride.credentialsHash).to.equal('device-hash');
    });

    it('should infer aes default transport and port from mgt_encrypt_schm', function () {
      const client = new Client({
        defaultSendOptions: { transport: 'tcp' },
      });
      const sysInfo = {
        ...validPlugDiscoveryResponse.system.get_sysinfo,
        mgt_encrypt_schm: {
          encrypt_type: 'AES',
          http_port: 8081,
          lv: 2,
        },
      };

      const plug = client.getPlug({
        host: '127.0.0.1',
        sysInfo,
      });
      expect(plug.defaultSendOptions.transport).to.equal('aes');
      expect(plug.port).to.equal(8081);
      plug.closeConnection();
    });

    it('should infer klap default transport from mgt_encrypt_schm', function () {
      const client = new Client({
        defaultSendOptions: { transport: 'tcp' },
      });
      const sysInfo = {
        ...validPlugDiscoveryResponse.system.get_sysinfo,
        mgt_encrypt_schm: {
          encrypt_type: 'KLAP',
          http_port: 80,
          lv: 2,
        },
      };

      const plug = client.getPlug({
        host: '127.0.0.1',
        sysInfo,
      });
      expect(plug.defaultSendOptions.transport).to.equal('klap');
      expect(plug.port).to.equal(80);
      plug.closeConnection();
    });

    it('should default getSysInfo port to 80 when client transport is authenticated', async function () {
      const client = new Client({
        defaultSendOptions: { transport: 'aes' },
      });
      const connection = {
        send: sinon.stub().resolves(JSON.stringify(validPlugDiscoveryResponse)),
        close: sinon.stub(),
      };
      const createConnectionStub = sinon
        .stub(client, 'createConnection')
        .returns(connection);

      const sysInfo = await client.getSysInfo('127.0.0.1');
      expect(sysInfo).to.deep.equal(validPlugDiscoveryResponse.system.get_sysinfo);
      expect(createConnectionStub).to.have.been.calledOnce;
      expect(createConnectionStub.firstCall.args[2]).to.equal(80);
      expect(connection.send).to.have.been.calledOnce;
      expect(connection.send.firstCall.args[1]).to.equal(80);
    });

    it('should default getDevice host lookup to 80 when client transport is authenticated', async function () {
      const client = new Client({
        defaultSendOptions: { transport: 'klap' },
      });
      const connection = {
        send: sinon.stub().resolves(JSON.stringify(validPlugDiscoveryResponse)),
        close: sinon.stub(),
      };
      const createConnectionStub = sinon
        .stub(client, 'createConnection')
        .returns(connection);

      const device = await client.getDevice({
        host: '127.0.0.1',
      });

      expect(createConnectionStub.firstCall.args[2]).to.equal(80);
      expect(device.port).to.equal(80);
      device.closeConnection();
    });

    it('should not override explicit transport and port with inferred values', function () {
      const client = new Client({
        defaultSendOptions: { transport: 'tcp' },
      });
      const sysInfo = {
        ...validPlugDiscoveryResponse.system.get_sysinfo,
        mgt_encrypt_schm: {
          encrypt_type: 'AES',
          http_port: 8081,
          lv: 2,
        },
      };

      const plug = client.getPlug({
        host: '127.0.0.1',
        port: 9999,
        defaultSendOptions: { transport: 'tcp' },
        sysInfo,
      });
      expect(plug.defaultSendOptions.transport).to.equal('tcp');
      expect(plug.port).to.equal(9999);
      plug.closeConnection();
    });

    it('should classify SMART switch sysinfo as a Plug device', function () {
      const client = new Client({
        defaultSendOptions: { transport: 'klap' },
      });
      const sysInfo = {
        ...validPlugDiscoveryResponse.system.get_sysinfo,
        type: 'SMART.KASASWITCH',
        feature: undefined,
        relay_state: undefined,
        device_on: false,
        led_off: 0,
      };

      const device = client.getDeviceFromSysInfo(sysInfo, {
        host: '127.0.0.1',
      });
      expect(device).to.be.instanceof(Plug);
      device.closeConnection();
    });

    it('should redact credentials in getDevice debug logging', async function () {
      const debugSpy = sinon.spy();
      const logger = {
        trace: () => {},
        debug: debugSpy,
        info: () => {},
        warn: () => {},
        error: () => {},
      };
      const client = new Client({ logger, logLevel: 'debug' });
      const sysInfo = validPlugDiscoveryResponse.system.get_sysinfo;

      const device = await client.getDevice({
        host: '127.0.0.1',
        sysInfo,
        credentials: { username: 'device-user', password: 'do-not-log' },
        credentialsHash: 'do-not-log-hash',
      });

      const allArgs = JSON.stringify(debugSpy.args);
      expect(allArgs).to.not.include('do-not-log');
      expect(allArgs).to.not.include('do-not-log-hash');
      device.closeConnection();
    });
  });

  describe('KS240-style child wiring', function () {
    const ks240SysInfo = {
      alias: 'KS240',
      deviceId: 'ks240-device-id',
      model: 'KS240(US)',
      sw_ver: '1.0.0',
      hw_ver: '1.0',
      type: 'IOT.SMARTPLUGSWITCH',
      mac: '00:11:22:33:44:55',
      feature: 'TIM',
      relay_state: 0,
      led_off: 0,
      children: [
        {
          id: '00',
          alias: 'Light',
          state: 0,
          category: 'kasa.switch.outlet.sub-dimmer',
          brightness: 75,
        },
        {
          id: '01',
          alias: 'Fan',
          state: 0,
          category: 'kasa.switch.outlet.sub-fan',
        },
      ],
    };

    it('should scope child modules to childId and detect child dimmer capability', async function () {
      const client = new Client();
      const lightChild = client.getPlug({
        host: '127.0.0.1',
        sysInfo: ks240SysInfo,
        childId: '00',
      });
      const fanChild = client.getPlug({
        host: '127.0.0.1',
        sysInfo: ks240SysInfo,
        childId: '01',
      });

      expect(lightChild.away.childId).to.eql('00');
      expect(lightChild.emeter.childId).to.eql('00');
      expect(lightChild.schedule.childId).to.eql('00');
      expect(lightChild.timer.childId).to.eql('00');
      expect(lightChild.dimmer.childId).to.eql('00');

      expect(lightChild.supportsDimmer).to.be.true;
      expect(fanChild.supportsDimmer).to.be.false;

      const sendCommand = sinon
        .stub(lightChild, 'sendCommand')
        .resolves({ err_code: 0 });
      await lightChild.dimmer.setBrightness(42);
      expect(sendCommand).to.have.been.calledWithMatch(
        { 'smartlife.iot.dimmer': { set_brightness: { brightness: 42 } } },
        '00',
      );
    });
  });

  describe('SMART switch module wiring', function () {
    const smartSwitchSysInfo = {
      alias: 'KS240',
      deviceId: 'smart-switch-device-id',
      model: 'KS240(US)',
      sw_ver: '1.0.0',
      hw_ver: '1.0',
      type: 'SMART.KASASWITCH',
      mac: '00:11:22:33:44:55',
      led_off: 0,
      device_on: false,
      components: [
        'device',
        'cloud_connect',
        'time',
        'led',
        'auto_off',
        'brightness',
        'preset',
        'on_off_gradually',
        'fan_control',
        'overheat_protection',
      ],
      children: [
        {
          id: '00',
          alias: 'Light',
          state: 0,
          category: 'kasa.switch.outlet.sub-dimmer',
          brightness: 55,
          components: [
            'device',
            'auto_off',
            'brightness',
            'preset',
            'on_off_gradually',
            'overheat_protection',
          ],
        },
        {
          id: '01',
          alias: 'Fan',
          state: 0,
          category: 'kasa.switch.outlet.sub-fan',
          fan_speed_level: 1,
          components: ['device', 'fan_control', 'overheat_protection'],
        },
      ],
    };

    it('should route SMART get/set power state through sendSmartCommand', async function () {
      const client = new Client({
        defaultSendOptions: { transport: 'klap' },
      });
      const lightChild = client.getPlug({
        host: '127.0.0.1',
        sysInfo: smartSwitchSysInfo,
        childId: '00',
      });

      const smartStub = sinon.stub(lightChild, 'sendSmartCommand');
      smartStub
        .withArgs('get_device_info', undefined, lightChild.childId)
        .resolves({ device_on: true });
      smartStub
        .withArgs('set_device_info', { device_on: false }, lightChild.childId)
        .resolves({ err_code: 0 });

      expect(await lightChild.getPowerState()).to.be.true;
      expect(await lightChild.setPowerState(false)).to.be.true;
      expect(lightChild.relayState).to.be.false;
      expect(smartStub).to.have.been.calledTwice;

      lightChild.closeConnection();
    });

    it('should route SMART dimmer brightness and switch-state via set_device_info', async function () {
      const client = new Client({
        defaultSendOptions: { transport: 'aes' },
      });
      const lightChild = client.getPlug({
        host: '127.0.0.1',
        sysInfo: smartSwitchSysInfo,
        childId: '00',
      });

      const smartStub = sinon.stub(lightChild, 'sendSmartCommand');
      smartStub.onFirstCall().resolves({ err_code: 0 });
      smartStub.onSecondCall().resolves({ err_code: 0 });

      await lightChild.dimmer.setBrightness(42);
      await lightChild.dimmer.setSwitchState(true);

      expect(smartStub.firstCall.args).to.deep.equal([
        'set_device_info',
        { brightness: 42 },
        lightChild.dimmer.childId,
        undefined,
      ]);
      expect(smartStub.secondCall.args).to.deep.equal([
        'set_device_info',
        { device_on: true },
        lightChild.dimmer.childId,
        undefined,
      ]);
      expect(lightChild.dimmer.brightness).to.equal(42);
      expect(lightChild.relayState).to.equal(true);

      await expect(
        lightChild.dimmer.getDimmerParameters(),
      ).to.eventually.be.rejectedWith(
        'getDimmerParameters is not supported for SMART dimmers',
      );

      lightChild.closeConnection();
    });

    it('should route SMART timer through auto_off config methods', async function () {
      const client = new Client({
        defaultSendOptions: { transport: 'aes' },
      });
      const lightChild = client.getPlug({
        host: '127.0.0.1',
        sysInfo: smartSwitchSysInfo,
        childId: '00',
      });

      const smartStub = sinon.stub(lightChild, 'sendSmartCommand');
      smartStub
        .withArgs('get_auto_off_config', undefined, lightChild.timer.childId)
        .resolves({ enable: true, delay_min: 5 });
      smartStub
        .withArgs(
          'set_auto_off_config',
          { enable: true, delay_min: 2 },
          lightChild.timer.childId,
        )
        .resolves({ err_code: 0 });
      smartStub
        .withArgs(
          'set_auto_off_config',
          { enable: false, delay_min: 5 },
          lightChild.timer.childId,
        )
        .resolves({ err_code: 0 });

      const rules = await lightChild.timer.getRules();
      expect(rules).to.containSubset({
        err_code: 0,
      });
      expect(rules.rule_list).to.be.an('array').with.length(1);
      expect(rules.rule_list[0]).to.containSubset({
        id: 'auto_off',
        enable: 1,
        act: 0,
        delay: 300,
      });

      const addResponse = await lightChild.timer.addRule({
        delay: 120,
        powerState: false,
        deleteExisting: true,
      });
      expect(addResponse).to.containSubset({
        err_code: 0,
        id: 'auto_off',
      });

      await expect(
        lightChild.timer.addRule({
          delay: 120,
          powerState: true,
          deleteExisting: true,
        }),
      ).to.eventually.be.rejectedWith(
        'SMART auto_off only supports powerState=false',
      );

      expect(await lightChild.timer.deleteAllRules()).to.containSubset({
        err_code: 0,
      });

      lightChild.closeConnection();
    });

    it('should reject unsupported SMART away/schedule legacy module calls explicitly', async function () {
      const client = new Client({
        defaultSendOptions: { transport: 'klap' },
      });
      const lightChild = client.getPlug({
        host: '127.0.0.1',
        sysInfo: smartSwitchSysInfo,
        childId: '00',
      });

      const sendCommandStub = sinon.stub(lightChild, 'sendCommand');

      await expect(lightChild.away.getRules()).to.eventually.be.rejectedWith(
        'away.getRules is not supported for SMART devices',
      );
      await expect(lightChild.schedule.getRules()).to.eventually.be.rejectedWith(
        'schedule.getRules is not supported for SMART devices',
      );
      await expect(
        lightChild.schedule.addRule({
          powerState: true,
          start: 60,
          daysOfWeek: [1, 2, 3, 4, 5],
        }),
      ).to.eventually.be.rejectedWith(
        'schedule.addRule is not supported for SMART devices',
      );

      expect(sendCommandStub).to.not.have.been.called;

      lightChild.closeConnection();
    });

    it('should reject SMART emeter calls when energy_monitoring is not available', async function () {
      const client = new Client({
        defaultSendOptions: { transport: 'klap' },
      });
      const plug = client.getPlug({
        host: '127.0.0.1',
        sysInfo: smartSwitchSysInfo,
      });

      await expect(plug.emeter.getRealtime()).to.eventually.be.rejectedWith(
        'Emeter module is not supported for this device scope',
      );

      plug.closeConnection();
    });

    it('should route SMART emeter realtime reads through energy methods and keep stats unsupported explicit', async function () {
      const client = new Client({
        defaultSendOptions: { transport: 'aes' },
      });
      const smartEnergySysInfo = JSON.parse(JSON.stringify(smartSwitchSysInfo));
      smartEnergySysInfo.components = [
        ...smartEnergySysInfo.components,
        'energy_monitoring',
      ];
      const plug = client.getPlug({
        host: '127.0.0.1',
        sysInfo: smartEnergySysInfo,
      });

      const smartStub = sinon.stub(plug, 'sendSmartCommand');
      smartStub
        .withArgs('get_emeter_data', undefined, undefined)
        .rejects(new Error('method not supported'));
      smartStub
        .withArgs('get_energy_usage', undefined, undefined)
        .resolves({
          current_power: 1234,
          today_energy: 56,
        });
      smartStub
        .withArgs('get_current_power', undefined, undefined)
        .resolves({
          current_power: 1.5,
        });

      const realtime = await plug.emeter.getRealtime();
      expect(realtime).to.containSubset({
        power_mw: 1234,
        power: 1.234,
        total_wh: 56,
        total: 0.056,
      });

      await expect(plug.emeter.getDayStats(2026, 1)).to.eventually.be.rejectedWith(
        'emeter.getDayStats is not supported for SMART devices',
      );

      plug.closeConnection();
    });

    it('should route SMART time/cloud reads and keep unsupported cloud writes explicit', async function () {
      const client = new Client({
        defaultSendOptions: { transport: 'klap' },
      });
      const plug = client.getPlug({
        host: '127.0.0.1',
        sysInfo: smartSwitchSysInfo,
      });

      const smartStub = sinon.stub(plug, 'sendSmartCommand');
      smartStub
        .withArgs('get_device_time', undefined, undefined)
        .resolves({
          timestamp: 1700000000,
          time_diff: -300,
          region: 'America/New_York',
        });
      smartStub
        .withArgs('get_connect_cloud_state', undefined, undefined)
        .resolves({ status: 0 });

      const timeInfo = await plug.time.getTime();
      const timezoneInfo = await plug.time.getTimezone();
      const cloudInfo = await plug.cloud.getInfo();

      expect(timeInfo).to.containSubset({
        err_code: 0,
        timestamp: 1700000000,
        time_diff: -300,
      });
      expect(timezoneInfo).to.containSubset({
        err_code: 0,
        region: 'America/New_York',
      });
      expect(cloudInfo).to.containSubset({
        err_code: 0,
        status: 0,
      });

      await expect(plug.cloud.bind('user', 'pass')).to.eventually.be.rejectedWith(
        'bind is not supported for SMART devices',
      );

      plug.closeConnection();
    });

    it('should use SMART LED module for getLedState/setLedState', async function () {
      const client = new Client({
        defaultSendOptions: { transport: 'aes' },
      });
      const plug = client.getPlug({
        host: '127.0.0.1',
        sysInfo: smartSwitchSysInfo,
      });

      const smartStub = sinon.stub(plug, 'sendSmartCommand');
      smartStub.onFirstCall().resolves({ led_status: false, led_rule: 'never' });
      smartStub.onSecondCall().resolves({ led_status: false, led_rule: 'never' });
      smartStub.onThirdCall().resolves({ err_code: 0 });

      expect(await plug.getLedState()).to.be.false;
      expect(await plug.setLedState(true)).to.be.true;
      expect(plug.sysInfo.led_off).to.equal(0);

      expect(smartStub.thirdCall.args[0]).to.equal('set_led_info');
      expect(smartStub.thirdCall.args[1]).to.containSubset({
        led_rule: 'always',
        led_status: true,
      });

      plug.closeConnection();
    });

    it('should negotiate component_nego and child component lists for scoped support', async function () {
      const client = new Client({
        defaultSendOptions: { transport: 'klap' },
      });
      const sysInfoWithoutComponents = JSON.parse(
        JSON.stringify(smartSwitchSysInfo),
      );
      delete sysInfoWithoutComponents.components;
      sysInfoWithoutComponents.children.forEach((child) => {
        delete child.components;
      });

      const lightChild = client.getPlug({
        host: '127.0.0.1',
        sysInfo: sysInfoWithoutComponents,
        childId: '00',
      });
      const lightChildId = lightChild.childId;
      const fanChildId = `${sysInfoWithoutComponents.deviceId}01`;

      const negotiationStub = sinon
        .stub(lightChild, 'sendSmartRequests')
        .resolves({
          component_nego: {
            component_list: [
              { id: 'device', ver_code: 2 },
              { id: 'led', ver_code: 1 },
              { id: 'child_device', ver_code: 2 },
              { id: 'fan_control', ver_code: 1 },
              { id: 'brightness', ver_code: 1 },
              { id: 'preset', ver_code: 1 },
              { id: 'on_off_gradually', ver_code: 2 },
            ],
          },
          get_child_device_list: {
            child_device_list: [
              {
                device_id: lightChildId,
                category: 'kasa.switch.outlet.sub-dimmer',
                device_on: false,
                brightness: 70,
              },
              {
                device_id: fanChildId,
                category: 'kasa.switch.outlet.sub-fan',
                device_on: true,
                fan_speed_level: 3,
              },
            ],
          },
          get_child_device_component_list: {
            child_component_list: [
              {
                device_id: lightChildId,
                component_list: [
                  { id: 'device', ver_code: 2 },
                  { id: 'brightness', ver_code: 1 },
                  { id: 'preset', ver_code: 1 },
                  { id: 'on_off_gradually', ver_code: 2 },
                ],
              },
              {
                device_id: fanChildId,
                component_list: [
                  { id: 'device', ver_code: 2 },
                  { id: 'fan_control', ver_code: 1 },
                ],
              },
            ],
          },
        });

      await lightChild.negotiateSmartComponents();

      expect(negotiationStub).to.have.been.calledOnce;
      expect(lightChild.getComponentVersion('led')).to.equal(undefined);
      expect(lightChild.getComponentVersion('preset')).to.equal(1);
      expect(lightChild.getComponentVersion('fan_control')).to.equal(undefined);
      expect(lightChild.hasComponent('fan_control', '01')).to.equal(true);
      expect(lightChild.hasComponent('preset', '01')).to.equal(false);
      expect(lightChild.supportsLightPreset).to.be.true;
      expect(lightChild.supportsLightTransition).to.be.true;
      expect(lightChild.supportsFan).to.be.false;

      lightChild.closeConnection();
    });

    it('should wire fan, preset, transition and overheat modules', async function () {
      const client = new Client({
        defaultSendOptions: { transport: 'klap' },
      });
      const fanChild = client.getPlug({
        host: '127.0.0.1',
        sysInfo: smartSwitchSysInfo,
        childId: '01',
      });
      const lightChild = client.getPlug({
        host: '127.0.0.1',
        sysInfo: smartSwitchSysInfo,
        childId: '00',
      });

      expect(fanChild.supportsFan).to.be.true;
      expect(lightChild.supportsFan).to.be.false;
      expect(lightChild.supportsLightPreset).to.be.true;
      expect(lightChild.supportsLightTransition).to.be.true;

      const fanStub = sinon.stub(fanChild, 'sendSmartCommand').resolves({
        err_code: 0,
      });
      await fanChild.fan.setFanSpeedLevel(2);
      expect(fanStub).to.have.been.calledWith(
        'set_device_info',
        {
          device_on: true,
          fan_speed_level: 2,
        },
        fanChild.fan.childId,
      );
      expect(fanChild.fan.speedLevel).to.equal(2);

      const presetStub = sinon.stub(lightChild, 'sendSmartCommand');
      presetStub.onFirstCall().resolves({ brightness: [100, 60, 30] });
      await lightChild.lightPreset.getPresetRules();
      expect(presetStub).to.have.been.calledWith(
        'get_preset_rules',
        undefined,
        lightChild.lightPreset.childId,
      );

      presetStub.onSecondCall().resolves({
        on_state: { enable: false, duration: 2 },
        off_state: { enable: false, duration: 2 },
      });
      presetStub.onThirdCall().resolves({ err_code: 0 });
      await lightChild.lightTransition.setEnabled(true);
      expect(presetStub.thirdCall.args[0]).to.equal('set_on_off_gradually_info');
      expect(presetStub.thirdCall.args[1]).to.containSubset({
        on_state: { enable: true },
        off_state: { enable: true },
      });

      presetStub.onCall(3).resolves({ overheat_status: 'overheated' });
      expect(await lightChild.overheatProtection.getOverheated()).to.be.true;

      fanChild.closeConnection();
      lightChild.closeConnection();
    });
  });

  describe('#startDiscovery()', function () {
    this.retries(1);
    this.timeout(config.defaultTestTimeout * 2);
    this.slow(config.defaultTestTimeout);

    let client;
    beforeEach('startDiscovery', function () {
      client = getTestClient();
    });

    afterEach('startDiscovery', function () {
      client.stopDiscovery();
    });

    it('should emit device-new when finding a new device', function (done) {
      client
        .startDiscovery({ discoveryInterval: 250 })
        .once('device-new', (device) => {
          expect(device).to.be.an.instanceof(Device);
          client.stopDiscovery();
          done();
        });
    });

    it('should emit device-new when finding a new device with `devices` specified', function (done) {
      const { mac } = testDevices.anyDevice;
      const { host } = testDevices.anyDevice.deviceOptions;
      expect('mac', mac).to.be.a('string').and.not.empty;
      expect('host', host).to.be.a('string').and.not.empty;

      client
        .startDiscovery({ discoveryInterval: 250, devices: [{ host }] })
        .on('device-new', (device) => {
          if (device.mac === mac) {
            client.stopDiscovery();
            done();
          }
        });
    });

    it('should emit device-new when finding a new device with a deviceType filter', function (done) {
      client
        .startDiscovery({ discoveryInterval: 250, deviceTypes: ['plug'] })
        .once('device-new', (device) => {
          expect(device).to.be.an.instanceof(Device);
          client.stopDiscovery();
          done();
        });
    });

    it('should ONLY emit device-new for specified deviceTypes', function (done) {
      client
        .startDiscovery({ discoveryInterval: 250, deviceTypes: ['plug'] })
        .on('device-new', (device) => {
          expect(device.deviceType).to.eql('plug');
        });
      setTimeout(done, 1000);
    });

    it('should NOT emit device-new with an incorrect deviceType filter', function (done) {
      client
        .startDiscovery({
          discoveryInterval: 250,
          deviceTypes: ['invalidDeviceType'],
        })
        .once('device-new', (device) => {
          client.stopDiscovery();
          expect(device).to.not.exist;
        });
      setTimeout(done, 1000);
    });

    it('should ONLY emit device-new for specified macAddresses', function (done) {
      const spy = sinon.spy();
      const { mac } = testDevices.anyDevice;
      expect(mac).to.be.a('string').and.not.empty;

      client
        .startDiscovery({ discoveryInterval: 250, macAddresses: [mac] })
        .on('device-new', spy);

      setTimeout(() => {
        expect(spy, `MAC:[${mac}] not found`).to.be.called;
        expect(spy).to.always.be.calledWithMatch({ mac });
        done();
      }, 1000);
    });

    it('should NOT emit device-new for specified excludedMacAddresses', function (done) {
      const spy = sinon.spy();
      const { mac } = testDevices.anyDevice;
      expect(mac, 'mac blank').to.be.a('string').and.not.empty;

      client
        .startDiscovery({ discoveryInterval: 250, excludeMacAddresses: [mac] })
        .on('device-new', spy);

      setTimeout(() => {
        client.stopDiscovery();
        expect(spy).to.be.called;
        expect(spy).to.not.be.calledWithMatch({ mac });
        done();
      }, 1000);
    });

    it('should NOT emit device-new for devices not meeting filterCallback', function (done) {
      const spy = sinon.spy();
      const { mac } = testDevices.anyDevice;
      expect(mac, 'mac blank').to.be.a('string').and.not.empty;

      client
        .startDiscovery({
          discoveryInterval: 250,
          filterCallback: (sysInfo) => {
            return !compareMac(sysInfo.mac, mac);
          },
        })
        .on('device-new', spy);

      setTimeout(() => {
        client.stopDiscovery();
        expect(spy).to.be.called;
        expect(spy).to.not.be.calledWithMatch({ mac });
        done();
      }, 1000);
    });

    it('should NOT emit device-new for devices not meeting filterCallback -- all devices', function (done) {
      const spy = sinon.spy();

      client
        .startDiscovery({ discoveryInterval: 250, filterCallback: () => false })
        .on('device-new', spy);

      setTimeout(() => {
        client.stopDiscovery();
        expect(spy).to.not.be.called;
        done();
      }, 1000);
    });

    it('should emit device-new for devices meeting filterCallback -- all devices', function (done) {
      client
        .startDiscovery({ discoveryInterval: 250, filterCallback: () => true })
        .once('device-new', () => {
          client.stopDiscovery();
          done();
        });
    });

    it('should ignore invalid devices that respond without encryption', function (done) {
      const socket = new EventEmitter();

      const createSocket = function () {
        socket.bind = sinon.fake();
        socket.address = () => ({ address: '1.2.3.4', port: 1234 });
        socket.setBroadcast = sinon.fake();
        return socket;
      };

      sinon.replace(dgram, 'createSocket', createSocket);

      const message = JSON.stringify(validPlugDiscoveryResponse);

      client
        .startDiscovery({ discoveryInterval: 250 })
        .on('device-new', (device) => {
          client.stopDiscovery();
          done(new Error(`Device should have been ignored: ${device.host}`));
        })
        .on('discovery-invalid', ({ rinfo, response }) => {
          expect(rinfo.address).to.eql('1.2.3.5');
          expect(rinfo.port).to.eql(1235);
          expect(response).to.eql(message);
          done();
        });

      socket.emit('message', message, {
        address: '1.2.3.5',
        port: 1235,
      });
    });

    describe('should ignore invalid devices that respond without valid response', function () {
      [
        JSON.stringify(''),
        JSON.stringify('data'),
        JSON.stringify({}),
        JSON.stringify({ unexpected: 'data' }),
        JSON.stringify({ system: undefined }),
        JSON.stringify({ system: {} }),
        JSON.stringify({ system: 'data' }),
        JSON.stringify({ system: { get_sysinfo: undefined } }),
        JSON.stringify({ system: { get_sysinfo: {} } }),
        JSON.stringify({ system: { get_sysinfo: 'data' } }),
        JSON.stringify({ system: { get_sysinfo: { alias: 'test' } } }),
      ].forEach((t) => {
        ['encrypted', 'unencrypted'].forEach((te) => {
          it(`${t} - ${te}`, function (done) {
            const socket = new EventEmitter();

            const createSocket = function () {
              socket.bind = sinon.fake();
              socket.address = () => ({ address: '1.2.3.4', port: 1234 });
              socket.setBroadcast = sinon.fake();
              return socket;
            };

            sinon.replace(dgram, 'createSocket', createSocket);

            let message;
            if (te === 'encrypted') {
              message = encrypt(t);
            } else {
              message = t;
            }

            client
              .startDiscovery({ discoveryInterval: 250 })
              .on('device-new', (device) => {
                client.stopDiscovery();
                done(
                  new Error(`Device should have been ignored: ${device.host}`),
                );
              })
              .on('discovery-invalid', ({ rinfo, response }) => {
                expect(rinfo.address).to.eql('1.2.3.5');
                expect(rinfo.port).to.eql(1235);
                expect(response).to.eql(message);
                done();
              });

            socket.emit('message', message, {
              address: '1.2.3.5',
              port: 1235,
            });
          });
        });
      });
    });

    const events = ['new', 'online', 'offline'];
    const eventTests = [];
    [
      { typeName: 'device', type: Device },
      { typeName: 'plug', type: Plug },
      { typeName: 'bulb', type: Bulb },
    ].forEach((t) => {
      events.forEach((e) => {
        eventTests.push({ ...t, event: e });
      });
    });

    eventTests.forEach((et) => {
      const eventName = `${et.typeName}-${et.event}`;

      it(`should emit ${eventName} when finding a(n) ${et.event} ${et.typeName}`, async function () {
        if (et.event === 'offline') {
          let device;
          switch (et.typeName) {
            case 'device':
              device = testDevices.anyDevice;
              break;
            case 'plug':
              device = testDevices.anyPlug;
              break;
            case 'bulb':
              device = testDevices.anyBulb;
              break;
            default:
              throw new Error(`Unexpected device type:${et.typeName}`);
          }

          if (!('getDevice' in device)) this.skip();

          const invalidDevice = await client.getDevice(device.deviceOptions);
          invalidDevice.host = testDevices.unreachable.deviceOptions.host;
          invalidDevice.status = 'online';
          invalidDevice.seenOnDiscovery = 0;
          client.devices.set(`${invalidDevice.deviceId}INV`, invalidDevice);
        }

        return new Promise((resolve) => {
          client
            .startDiscovery({ discoveryInterval: 100, offlineTolerance: 2 })
            .once(eventName, (device) => {
              expect(device).to.be.an.instanceof(et.type);
              client.stopDiscovery();
              resolve();
            });
        });
      });
    });

    it('should timeout with timeout set', function (done) {
      this.slow(100);
      client.startDiscovery({ discoveryInterval: 0, discoveryTimeout: 1 });
      setTimeout(() => {
        expect(client.discoveryPacketSequence).to.be.above(0);
        expect(client.discoveryTimer).to.not.exist;
        done();
      }, 50);
    });

    it('should emit discovery-invalid for the unreliable test device', function (done) {
      const device = testDevices.unreliable;
      if (!device.deviceOptions || !device.deviceOptions.port) this.skip();

      client
        .startDiscovery({ discoveryInterval: 250 })
        .on('discovery-invalid', ({ rinfo, response, decryptedResponse }) => {
          expect(response).to.be.instanceof(Buffer);
          expect(decryptedResponse).to.be.instanceof(Buffer);

          if (rinfo.port === device.deviceOptions.port) {
            client.stopDiscovery();
            done();
          }
        });
    });

    it('should emit device-new for each child for devices with children and breakoutChildren is true', function (done) {
      const devices = {};
      client
        .startDiscovery({
          discoveryInterval: 250,
          deviceTypes: ['plug'],
          breakoutChildren: true,
        })
        .on('device-new', (device) => {
          if (device.model.match(/^HS300/)) {
            expect(device.children).to.have.property('size', 6);
            expect(device.sysInfo.children).to.have.lengthOf(
              device.children.size,
            );
            if (devices[device.deviceId] == null) {
              devices[device.deviceId] = {};
              devices[device.deviceId].children = [];
            }
            devices[device.deviceId].children.push(device.childId);

            if (
              devices[device.deviceId].children.length >= device.children.size
            ) {
              devices[device.deviceId].children.sort().forEach((childId, i) => {
                expect(childId).to.eql(`${device.deviceId}0${i}`);
              });
              done();
            }
          }
        });
    });

    it('should emit device-new for only the device and not each child for devices with children and breakoutChildren is false', function (done) {
      const devices = {};
      client
        .startDiscovery({
          discoveryInterval: 250,
          deviceTypes: ['plug'],
          breakoutChildren: false,
        })
        .on('device-new', (device) => {
          if (device.model.match(/^HS300/)) {
            expect(device.children).to.have.property('size', 6);
            expect(device.sysInfo.children).to.have.lengthOf(
              device.children.size,
            );
            expect(devices[device.deviceId]).to.be.undefined;
            devices[device.deviceId] = device;
          }
        });
      setTimeout(() => {
        expect(Object.keys(devices)).length.to.be.above(0);
        done();
      }, 1000);
    });

    it('should create devices using default port (9999) when devicesUseDiscoveryPort is false', function (done) {
      const devices = [];
      client
        .startDiscovery({
          discoveryInterval: 250,
          devicesUseDiscoveryPort: false,
        })
        .on('device-new', (device) => {
          devices.push(device);
        });

      setTimeout(() => {
        client.stopDiscovery();
        expect(devices.length).to.be.greaterThan(0);
        devices.forEach((d) => expect(d.port).to.eql(9999));
        done();
      }, 1000);
    });

    it('should create devices using response port when devicesUseDiscoveryPort is true', function (done) {
      // This test assumes at least one test device is not responding to discovery 9999
      const devices = [];
      client
        .startDiscovery({
          discoveryInterval: 250,
          devicesUseDiscoveryPort: true,
        })
        .on('device-new', (device) => {
          devices.push(device);
        });

      setTimeout(() => {
        client.stopDiscovery();
        expect(devices.length).to.be.greaterThan(0);
        expect(devices.findIndex((d) => d.port !== 9999)).to.not.eql(-1);
        done();
      }, 1000);
    });
  });

  config.testSendOptionsSets.forEach((sendOptions) => {
    context(sendOptions.name, function () {
      this.retries(1);
      describe('#getDevice()', function () {
        let client;
        let device;

        before('before client #getDevice()', async function () {
          client = getTestClient(sendOptions);
          device = await client.getDevice(testDevices.anyDevice.deviceOptions);
        });

        after(function () {
          device.closeConnection();
        });

        it('should find a device by IP address', function () {
          return expect(device.getSysInfo()).to.eventually.have.property(
            'err_code',
            0,
          );
        });

        it('should be rejected with an invalid IP address', async function () {
          let error;
          const { deviceOptions } = testDevices.unreachable;
          try {
            const dev = await client.getDevice(deviceOptions, {
              timeout: 500,
            });
            dev.closeConnection();
          } catch (err) {
            error = err;
          }
          expect(error).to.be.instanceOf(Error);
        });
      });

      describe('#getPlug()', function () {
        let skipped = false;
        let client;
        let plug;
        let unreachablePlug;
        let sysInfo;

        before('before client #getPlug()', async function () {
          if (!('getDevice' in testDevices.anyPlug)) {
            skipped = true;
            this.skip();
          }

          client = getTestClient(sendOptions);
          const { host, port } = testDevices.anyPlug.deviceOptions;
          sysInfo = await client.getSysInfo(host, port);

          plug = client.getPlug({
            ...testDevices.anyPlug.deviceOptions,
            sysInfo,
          });

          unreachablePlug = client.getPlug({
            ...testDevices.unreachable.deviceOptions,
            sysInfo,
          });
        });

        after(function () {
          if (skipped) return;
          plug.closeConnection();
        });

        it('should find a plug by IP address', function () {
          return expect(plug.getSysInfo()).to.eventually.have.property(
            'err_code',
            0,
          );
        });

        it('should be rejected with an invalid IP address', function () {
          return expect(unreachablePlug.getSysInfo({ timeout: 500 })).to
            .eventually.be.rejected;
        });
      });

      describe('#getBulb()', function () {
        let skipped = false;
        let client;
        let bulb;
        let unreachableBulb;
        let sysInfo;

        before('before client #getBulb()', async function () {
          if (!('getDevice' in testDevices.anyBulb)) {
            skipped = true;
            this.skip();
          }

          client = getTestClient(sendOptions);

          const { host, port } = testDevices.anyBulb.deviceOptions;
          sysInfo = await client.getSysInfo(host, port);

          bulb = await client.getBulb({
            ...testDevices.anyBulb.deviceOptions,
            sysInfo,
          });
          unreachableBulb = client.getBulb({
            ...testDevices.unreachable.deviceOptions,
            sysInfo,
          });
        });

        after(function () {
          if (skipped) return;
          bulb.closeConnection();
        });

        it('should find a bulb by IP address', function () {
          return expect(bulb.getSysInfo()).to.eventually.have.property(
            'err_code',
            0,
          );
        });

        it('should be rejected with an invalid IP address', function () {
          return expect(unreachableBulb.getSysInfo({ timeout: 500 })).to
            .eventually.be.rejected;
        });
      });
    });

    describe('.send()', function () {
      let client;
      let options;
      before('before client .send()', function () {
        client = getTestClient(sendOptions);
        options = testDevices.anyDevice.deviceOptions;
      });
      ['tcp', 'udp'].forEach((transport) => {
        it(`should return info with string payload ${transport}`, async function () {
          return expect(
            JSON.parse(
              await client.send(
                '{"system":{"get_sysinfo":{}}}',
                options.host,
                options.port,
                { sendOptions: { transport } },
              ),
            ),
          ).to.have.nested.property('system.get_sysinfo.err_code', 0);
        });
        it(`should return info with object payload ${sendOptions.transport}`, async function () {
          return expect(
            JSON.parse(
              await client.send(
                { system: { get_sysinfo: {} } },
                options.host,
                options.port,
                { sendOptions: { transport } },
              ),
            ),
          ).to.have.nested.property('system.get_sysinfo.err_code', 0);
        });

        it(`should return info with object payload ${sendOptions.transport}`, async function () {
          return expect(
            JSON.parse(
              await client.send(
                { system: { get_sysinfo: {} } },
                options.host,
                options.port,
                { sendOptions: { transport } },
              ),
            ),
          ).to.have.nested.property('system.get_sysinfo.err_code', 0);
        });
      });
    });
  });
});
