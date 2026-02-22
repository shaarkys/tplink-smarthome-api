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

  private async ensureSupported(sendOptions?: SendOptions): Promise<void> {
    await this.device.negotiateSmartComponents(sendOptions);
    if (!this.device.supportsOverheatProtection) {
      throw new Error(
        'OverheatProtection module is not supported for this device scope',
      );
    }
  }

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
    await this.ensureSupported(sendOptions);
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
