import type { AnyDevice, SendOptions } from '../client';
import {
  extractResponse,
  isObjectLike,
  HasErrCode,
  hasErrCode,
} from '../utils';

export type CloudInfo = {
  username?: string;
  server?: string;
  binded?: number;
  status?: number;
  cld_connection?: number;
  illegalType?: number;
  tcspStatus?: number;
  fwDlPage?: string;
  tcspInfo?: string;
  stopConnect?: number;
  fwNotifyType?: number;
};

export function isCloudInfo(candidate: unknown): candidate is CloudInfo {
  return isObjectLike(candidate);
}

export default class Cloud {
  info: (CloudInfo & HasErrCode) | undefined;

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
      !this.device.hasComponent('cloud_connect', undefined)
    ) {
      throw new Error('Cloud module is not supported for this device scope');
    }
  }

  private toLegacyStyleSmartResponse(response: unknown): unknown {
    if (hasErrCode(response)) {
      return response;
    }
    if (isObjectLike(response)) {
      return {
        err_code: 0,
        ...response,
      };
    }
    return { err_code: 0 };
  }

  private async callSmartWithCandidates(
    methodCandidates: string[],
    params: Record<string, unknown> | undefined,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    await this.ensureSupported(sendOptions);

    let firstError: unknown;
    for (const methodName of methodCandidates) {
      try {
        const response = await this.device.sendSmartCommand(
          methodName,
          params,
          undefined,
          sendOptions,
        );
        return this.toLegacyStyleSmartResponse(response);
      } catch (error) {
        if (firstError === undefined) {
          firstError = error;
        }
      }
    }

    throw (
      firstError ??
      new Error(
        `Cloud SMART call failed for methods: ${methodCandidates.join(', ')}`,
      )
    );
  }

  /**
   * Gets device's TP-Link cloud info.
   *
   * Requests `cloud.get_info`. Does not support childId.
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async getInfo(sendOptions?: SendOptions): Promise<CloudInfo & HasErrCode> {
    if (this.isSmartPath(sendOptions)) {
      await this.ensureSupported(sendOptions);
      const response = await this.device.sendSmartCommand(
        'get_connect_cloud_state',
        undefined,
        undefined,
        sendOptions,
      );
      if (!isCloudInfo(response)) {
        throw new Error(
          `Unexpected SMART cloud response: ${JSON.stringify(response)}`,
        );
      }
      const normalizedResponse: CloudInfo & HasErrCode = {
        err_code: 0,
        ...response,
      };
      this.info = normalizedResponse;
      return normalizedResponse;
    }

    this.info = extractResponse<CloudInfo & HasErrCode>(
      await this.device.sendCommand(
        {
          [this.apiModuleName]: { get_info: {} },
        },
        undefined,
        sendOptions,
      ),
      '',
      (c) => isCloudInfo(c) && hasErrCode(c),
    );
    return this.info;
  }

  /**
   * Add device to TP-Link cloud.
   *
   * Sends `cloud.bind` command. Does not support childId.
   * @param   username
   * @param   password
   * @param   sendOptions
   * @returns parsed JSON response
   */
  async bind(
    username: string,
    password: string,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    if (this.isSmartPath(sendOptions)) {
      return this.callSmartWithCandidates(
        ['bind', 'connect_cloud'],
        { username, password },
        sendOptions,
      );
    }

    return this.device.sendCommand(
      {
        [this.apiModuleName]: { bind: { username, password } },
      },
      undefined,
      sendOptions,
    );
  }

  /**
   * Remove device from TP-Link cloud.
   *
   * Sends `cloud.unbind` command. Does not support childId.
   * @param   sendOptions
   * @returns parsed JSON response
   */
  async unbind(sendOptions?: SendOptions): Promise<unknown> {
    if (this.isSmartPath(sendOptions)) {
      return this.callSmartWithCandidates(
        ['unbind', 'disconnect_cloud'],
        undefined,
        sendOptions,
      );
    }

    return this.device.sendCommand(
      {
        [this.apiModuleName]: { unbind: {} },
      },
      undefined,
      sendOptions,
    );
  }

  /**
   * Get device's TP-Link cloud firmware list.
   *
   * Sends `cloud.get_intl_fw_list` command. Does not support childId.
   * @param   sendOptions
   * @returns parsed JSON response
   */
  async getFirmwareList(sendOptions?: SendOptions): Promise<unknown> {
    if (this.isSmartPath(sendOptions)) {
      return this.callSmartWithCandidates(
        ['get_intl_fw_list', 'get_latest_fw'],
        undefined,
        sendOptions,
      );
    }

    return this.device.sendCommand(
      {
        [this.apiModuleName]: { get_intl_fw_list: {} },
      },
      undefined,
      sendOptions,
    );
  }

  /**
   * Sets device's TP-Link cloud server URL.
   *
   * Sends `cloud.set_server_url` command. Does not support childId.
   * @param   server - URL
   * @param   sendOptions
   * @returns parsed JSON response
   */
  async setServerUrl(
    server: string,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    if (this.isSmartPath(sendOptions)) {
      return this.callSmartWithCandidates(
        ['set_server_url', 'set_cloud_server_url'],
        { server },
        sendOptions,
      );
    }

    return this.device.sendCommand(
      {
        [this.apiModuleName]: { set_server_url: { server } },
      },
      undefined,
      sendOptions,
    );
  }
}
