import type { SendOptions } from '../client';
import { isObjectLike } from '../utils';
import type Plug from './index';

/**
 * SMART overheat status accessor.
 */
export default class OverheatProtection {
  constructor(
    readonly device: Plug,
    readonly childId: string | undefined = undefined,
  ) {}

  /**
   * Cached overheat status from sysInfo/child sysInfo.
   */
  get overheated(): boolean | undefined {
    return this.device.overheated;
  }

  /**
   * Refreshes SMART device info and returns current overheat status.
   */
  async getOverheated(sendOptions?: SendOptions): Promise<boolean | undefined> {
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
    return this.overheated;
  }
}
