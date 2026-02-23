import type { AnyDevice, SendOptions } from '../client';
import { hasErrCode, isObjectLike } from '../utils';

export default class Time {
  constructor(
    readonly device: AnyDevice,
    readonly apiModuleName: string,
  ) {}

  private isSmartPath(sendOptions?: SendOptions): boolean {
    return (
      'shouldUseSmartMethods' in this.device &&
      typeof this.device.shouldUseSmartMethods === 'function' &&
      this.device.shouldUseSmartMethods(sendOptions)
    );
  }

  private async ensureSupported(sendOptions?: SendOptions): Promise<void> {
    if (
      'negotiateSmartComponents' in this.device &&
      typeof this.device.negotiateSmartComponents === 'function'
    ) {
      await this.device.negotiateSmartComponents(sendOptions);
    }
    if (
      'hasComponent' in this.device &&
      typeof this.device.hasComponent === 'function' &&
      !this.device.hasComponent('time', undefined)
    ) {
      throw new Error('Time module is not supported for this device scope');
    }
  }

  private toLegacyStyleTimePayload(response: unknown): unknown {
    if (hasErrCode(response)) {
      return response;
    }
    if (!isObjectLike(response)) {
      return response;
    }
    return {
      err_code: 0,
      ...response,
    };
  }

  /**
   * Gets device's time.
   *
   * Requests `timesetting.get_time`. Does not support ChildId.
   * @param   sendOptions
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async getTime(sendOptions?: SendOptions): Promise<unknown> {
    if (this.isSmartPath(sendOptions)) {
      await this.ensureSupported(sendOptions);
      return this.toLegacyStyleTimePayload(
        await this.device.sendSmartCommand(
          'get_device_time',
          undefined,
          undefined,
          sendOptions,
        ),
      );
    }

    return this.device.sendCommand(
      {
        [this.apiModuleName]: { get_time: {} },
      },
      undefined,
      sendOptions,
    );
  }

  /**
   * Gets device's timezone.
   *
   * Requests `timesetting.get_timezone`. Does not support ChildId.
   * @param   sendOptions
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async getTimezone(sendOptions?: SendOptions): Promise<unknown> {
    if (this.isSmartPath(sendOptions)) {
      await this.ensureSupported(sendOptions);
      return this.toLegacyStyleTimePayload(
        await this.device.sendSmartCommand(
          'get_device_time',
          undefined,
          undefined,
          sendOptions,
        ),
      );
    }

    return this.device.sendCommand(
      {
        [this.apiModuleName]: { get_timezone: {} },
      },
      undefined,
      sendOptions,
    );
  }
}
