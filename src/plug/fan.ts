import type { SendOptions } from '../client';
import { isObjectLike } from '../utils';
import type Plug from './index';

/**
 * SMART fan control exposed by devices/channels with `fan_control`.
 */
export default class Fan {
  constructor(
    readonly device: Plug,
    readonly childId: string | undefined = undefined,
  ) {}

  /**
   * Cached fan speed level from sysInfo/child sysInfo.
   */
  get speedLevel(): number | undefined {
    return this.device.fanSpeedLevel;
  }

  /**
   * Cached fan sleep mode from sysInfo/child sysInfo.
   */
  get sleepModeOn(): boolean | undefined {
    return this.device.fanSleepModeOn;
  }

  /**
   * Requests SMART `get_device_info` for current scope.
   */
  async getDeviceInfo(sendOptions?: SendOptions): Promise<unknown> {
    const response = await this.device.sendSmartCommand(
      'get_device_info',
      undefined,
      this.childId,
      sendOptions,
    );
    if (isObjectLike(response)) {
      this.device.applySmartDeviceInfoPartial(
        response as Record<string, unknown>,
        this.childId,
      );
    }
    return response;
  }

  /**
   * Sets fan speed using SMART `set_device_info`.
   * `0` turns the target off.
   */
  async setFanSpeedLevel(
    level: number,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    const normalizedLevel = Math.max(0, Math.round(level));
    const params =
      normalizedLevel === 0
        ? { device_on: false, fan_speed_level: 0 }
        : { device_on: true, fan_speed_level: normalizedLevel };

    const response = await this.device.sendSmartCommand(
      'set_device_info',
      params,
      this.childId,
      sendOptions,
    );
    this.device.applySmartDeviceInfoPartial(params, this.childId);
    return response;
  }

  /**
   * Sets fan sleep mode using SMART `set_device_info`.
   */
  async setSleepMode(on: boolean, sendOptions?: SendOptions): Promise<unknown> {
    const params = { fan_sleep_mode_on: on };
    const response = await this.device.sendSmartCommand(
      'set_device_info',
      params,
      this.childId,
      sendOptions,
    );
    this.device.applySmartDeviceInfoPartial(params, this.childId);
    return response;
  }
}
