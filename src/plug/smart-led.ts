import type { SendOptions } from '../client';
import { isObjectLike } from '../utils';
import type Plug from './index';

export type SmartLedInfo = {
  led_rule?: string;
  led_status?: boolean;
} & Record<string, unknown>;

/**
 * SMART LED module (`get_led_info` / `set_led_info`).
 */
export default class SmartLed {
  constructor(
    readonly device: Plug,
    readonly childId: string | undefined = undefined,
  ) {}

  private async ensureSupported(sendOptions?: SendOptions): Promise<void> {
    await this.device.negotiateSmartComponents(sendOptions);
    if (!this.device.supportsSmartLed) {
      throw new Error('SmartLed module is not supported for this device scope');
    }
  }

  /**
   * Requests SMART `get_led_info`.
   */
  async getInfo(sendOptions?: SendOptions): Promise<SmartLedInfo> {
    await this.ensureSupported(sendOptions);
    const response = await this.device.sendSmartCommand(
      'get_led_info',
      undefined,
      this.childId,
      sendOptions,
    );
    if (!isObjectLike(response)) {
      throw new Error(`Unexpected SMART LED response: ${response as string}`);
    }
    return response as SmartLedInfo;
  }

  /**
   * Returns LED state from SMART LED info.
   */
  async getLedState(sendOptions?: SendOptions): Promise<boolean> {
    const info = await this.getInfo(sendOptions);
    if (typeof info.led_status === 'boolean') {
      return info.led_status;
    }
    if (typeof info.led_rule === 'string') {
      return info.led_rule !== 'never';
    }
    return true;
  }

  /**
   * Sets SMART LED state by updating `led_rule`.
   */
  async setLedState(
    value: boolean,
    sendOptions?: SendOptions,
  ): Promise<true> {
    await this.ensureSupported(sendOptions);
    const current = await this.getInfo(sendOptions);
    const payload: SmartLedInfo = {
      ...current,
      led_rule: value ? 'always' : 'never',
    };
    if ('led_status' in current) {
      payload.led_status = value;
    }
    await this.device.sendSmartCommand(
      'set_led_info',
      payload,
      this.childId,
      sendOptions,
    );

    this.device.sysInfo.led_off = value ? 0 : 1;
    return true;
  }
}
