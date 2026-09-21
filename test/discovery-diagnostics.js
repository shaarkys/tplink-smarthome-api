const assert = require('assert');
const { normalizeSmartSysInfo } = require('../src/smart-discovery');

describe('discovery diagnostic flags', () => {
  const normalize = (scheme) =>
    normalizeSmartSysInfo({
      device_model: 'HS220(US)',
      device_id: 'dummy-id',
      device_type: 'IOT.SMARTPLUGSWITCH',
      mac: '00:00:00:00:00:00',
      mgt_encrypt_schm: scheme,
    }).mgt_encrypt_schm;

  it('preserves boolean and binary flags without changing transport metadata', () => {
    [true, false, 0, 1].forEach((value) => {
      assert.deepStrictEqual(
        normalize({ encrypt_type: 'KLAP', lv: 2, new_klap: value, ANS: value }),
        { encrypt_type: 'KLAP', lv: 2, new_klap: value, ANS: value },
      );
    });
  });

  it('does not forward secrets, malformed flags or invent missing flags', () => {
    [undefined, null, 'secret', { token: 'secret' }, 2].forEach((value) => {
      assert.deepStrictEqual(
        normalize({
          new_klap: value,
          ANS: value,
          owner: 'secret',
          token: 'secret',
        }),
        {},
      );
    });
  });
});
