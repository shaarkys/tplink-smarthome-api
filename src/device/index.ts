import { randomBytes } from 'crypto';
import { EventEmitter } from 'events';
import castArray from 'lodash.castarray';
import type log from 'loglevel';

import type { BulbSysinfo } from '../bulb';
import type Client from '../client';
import type {
  SendOptions,
  SmartMethodRequest,
  SmartRequestPayload,
} from '../client';
import {
  type CredentialOptions,
  type Credentials,
  mergeCredentialOptions,
  redactCredentialOptions,
} from '../credentials';
import type { Logger } from '../logger';
import type { DeviceConnection } from '../network/connection';
import type { PlugSysinfo } from '../plug';
import type { RealtimeNormalized } from '../shared/emeter';
import SmartError from '../smart-error';
import {
  extractResponse,
  isObjectLike,
  processResponse,
  processSingleCommandResponse,
  type HasErrCode,
} from '../utils';
import Netif from './netif';

type HasAtLeastOneProperty = {
  [key: string]: unknown;
};

type SmartResponse = {
  error_code: number;
  result?: unknown;
};

export interface ApiModuleNamespace {
  system: string;
  cloud: string;
  schedule: string;
  timesetting: string;
  emeter: string;
  netif: string;
  lightingservice: string;
}

export type Sysinfo = BulbSysinfo | PlugSysinfo;
export type SmartMethodResponseMap = Record<string, unknown>;

export interface DeviceConstructorOptions extends CredentialOptions {
  client: Client;
  host: string;
  /**
   * @defaultValue 9999
   */
  port?: number;
  logger?: log.RootLogger;
  defaultSendOptions?: SendOptions;
}

export type ManagementEncryptionScheme = {
  is_support_https?: boolean;
  encrypt_type?: string;
  http_port?: number;
  lv?: number;
};

// type SysinfoTypeValues =
//   | 'IOT.SMARTPLUGSWITCH'
//   | 'IOT.SMARTBULB'
//   | 'IOT.RANGEEXTENDER.SMARTPLUG';

export type CommonSysinfo = {
  alias: string;
  deviceId: string;
  model: string;
  sw_ver: string;
  hw_ver: string;
  mgt_encrypt_schm?: ManagementEncryptionScheme;
};

export function isCommonSysinfo(
  candidate: unknown,
): candidate is CommonSysinfo {
  return (
    isObjectLike(candidate) &&
    'alias' in candidate &&
    'deviceId' in candidate &&
    'model' in candidate &&
    'sw_ver' in candidate &&
    'hw_ver' in candidate
  );
}

export function isBulbSysinfo(candidate: unknown): candidate is BulbSysinfo {
  return (
    isCommonSysinfo(candidate) &&
    'mic_type' in candidate &&
    'mic_mac' in candidate &&
    'description' in candidate &&
    'light_state' in candidate &&
    'is_dimmable' in candidate &&
    'is_color' in candidate &&
    'is_variable_color_temp' in candidate
  );
}

export function isPlugSysinfo(candidate: unknown): candidate is PlugSysinfo {
  if (!isCommonSysinfo(candidate)) {
    return false;
  }

  const hasType = 'type' in candidate || 'mic_type' in candidate;
  const hasMac = 'mac' in candidate || 'ethernet_mac' in candidate;
  const hasLegacyShape =
    'feature' in candidate &&
    ('relay_state' in candidate || 'children' in candidate);
  const hasSmartShape =
    'type' in candidate &&
    typeof candidate.type === 'string' &&
    candidate.type.startsWith('SMART.') &&
    ('device_on' in candidate ||
      'relay_state' in candidate ||
      'children' in candidate ||
      'brightness' in candidate);

  return hasType && hasMac && (hasLegacyShape || hasSmartShape);
}

function isSysinfo(candidate: unknown): candidate is Sysinfo {
  return isPlugSysinfo(candidate) || isBulbSysinfo(candidate);
}

function isSmartResponse(candidate: unknown): candidate is SmartResponse {
  return isObjectLike(candidate) && typeof candidate.error_code === 'number';
}

export interface DeviceEvents {
  /**
   * Energy Monitoring Details were updated from device. Fired regardless if status was changed.
   */
  'emeter-realtime-update': (value: RealtimeNormalized) => void;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
declare interface Device {
  on<U extends keyof DeviceEvents>(event: U, listener: DeviceEvents[U]): this;

  emit<U extends keyof DeviceEvents>(
    event: U,
    ...args: Parameters<DeviceEvents[U]>
  ): boolean;
}

/**
 * TP-Link Device.
 *
 * Abstract class. Shared behavior for {@link Plug} and {@link Bulb}.
 * @fires  Device#emeter-realtime-update
 * @noInheritDoc
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
abstract class Device extends EventEmitter {
  readonly client: Client;

  host: string;

  port: number;

  netif = new Netif(this, 'netif');

  log: Logger;

  readonly defaultSendOptions: SendOptions;

  readonly credentials?: Credentials;

  readonly credentialsHash?: string;

  private readonly smartTerminalUuid = randomBytes(16).toString('base64');

  private readonly connections: Record<
    'udp' | 'tcp' | 'klap' | 'aes',
    DeviceConnection
  >;

  protected _sysInfo: Sysinfo;

  abstract readonly apiModules: ApiModuleNamespace;

  abstract supportsEmeter: boolean;

  // eslint-disable-next-line class-methods-use-this
  get childId(): string | undefined {
    return undefined;
  }

  constructor(options: DeviceConstructorOptions & { _sysInfo: Sysinfo }) {
    super();

    const {
      client,
      // eslint-disable-next-line @typescript-eslint/naming-convention
      _sysInfo,
      host,
      port,
      logger,
      defaultSendOptions,
      credentials,
      credentialsHash,
    } = options;

    // Log first as methods below may call `log`
    this.log = logger || client.log;
    this.log.debug('device.constructor(%j)', {
      // eslint-disable-next-line prefer-rest-params
      ...redactCredentialOptions(arguments[0]),
      client: 'not shown',
    });

    this.client = client;
    // eslint-disable-next-line no-underscore-dangle
    this._sysInfo = _sysInfo;
    this.host = host;
    this.defaultSendOptions = {
      ...client.defaultSendOptions,
      ...defaultSendOptions,
    };
    const defaultTransport = this.defaultSendOptions.transport;
    this.port =
      port ??
      (defaultTransport === 'klap' || defaultTransport === 'aes' ? 80 : 9999);

    const mergedCredentials = mergeCredentialOptions(
      {
        credentials: client.credentials,
        credentialsHash: client.credentialsHash,
      },
      { credentials, credentialsHash },
      'device constructor options',
    );
    this.credentials = mergedCredentials.credentials;
    this.credentialsHash = mergedCredentials.credentialsHash;

    this.connections = {
      udp: this.client.createConnection('udp', this.host, this.port),
      tcp: this.client.createConnection('tcp', this.host, this.port),
      klap: this.client.createConnection('klap', this.host, this.port, {
        credentials: this.credentials,
        credentialsHash: this.credentialsHash,
      }),
      aes: this.client.createConnection('aes', this.host, this.port, {
        credentials: this.credentials,
        credentialsHash: this.credentialsHash,
      }),
    };
  }

  /**
   * Returns cached results from last retrieval of `system.sysinfo`.
   * @returns system.sysinfo
   */
  get sysInfo(): Sysinfo {
    // eslint-disable-next-line no-underscore-dangle
    return this._sysInfo;
  }

  /**
   * @internal
   */
  setSysInfo(sysInfo: Sysinfo): void {
    this.log.debug('[%s] device sysInfo set', sysInfo.alias || this.alias);
    // eslint-disable-next-line no-underscore-dangle
    this._sysInfo = sysInfo;
  }

  /**
   * Cached value of `sysinfo.alias`.
   */
  get alias(): string {
    return this.sysInfo.alias;
  }

  /**
   * Cached value of `sysinfo.deviceId`.
   */
  get id(): string {
    return this.deviceId;
  }

  /**
   * Cached value of `sysinfo.deviceId`.
   */
  get deviceId(): string {
    return this.sysInfo.deviceId;
  }

  /**
   * Cached value of `sysinfo.[description|dev_name]`.
   */
  abstract get description(): string | undefined;

  /**
   * Cached value of `sysinfo.model`.
   */
  get model(): string {
    return this.sysInfo.model;
  }

  /**
   * Cached value of `sysinfo.alias`.
   */
  get name(): string {
    return this.alias;
  }

  /**
   * Cached value of `sysinfo.[type|mic_type]`.
   */
  get type(): string {
    if ('type' in this.sysInfo) return this.sysInfo.type;
    if ('mic_type' in this.sysInfo) return this.sysInfo.mic_type;
    return '';
  }

  isSmartProtocolDevice(): boolean {
    const typeValue = this.type;
    return typeof typeValue === 'string' && typeValue.startsWith('SMART.');
  }

  shouldUseSmartMethods(sendOptions?: SendOptions): boolean {
    if (!this.isSmartProtocolDevice()) {
      return false;
    }
    const transport = sendOptions?.transport ?? this.defaultSendOptions.transport;
    return transport === 'klap' || transport === 'aes';
  }

  /**
   * Type of device (or `device` if unknown).
   *
   * Based on cached value of `sysinfo.[type|mic_type]`
   */
  get deviceType(): 'plug' | 'bulb' | 'device' {
    const { type } = this;
    switch (true) {
      case /plug/i.test(type):
        return 'plug';
      case /bulb/i.test(type):
        return 'bulb';
      default:
        return 'device';
    }
  }

  /**
   * Cached value of `sysinfo.sw_ver`.
   */
  get softwareVersion(): string {
    return this.sysInfo.sw_ver;
  }

  /**
   * Cached value of `sysinfo.hw_ver`.
   */
  get hardwareVersion(): string {
    return this.sysInfo.hw_ver;
  }

  /**
   * Cached value of `sysinfo.[mac|mic_mac|ethernet_mac]`.
   */
  get mac(): string {
    if ('mac' in this.sysInfo) return this.sysInfo.mac;
    if ('mic_mac' in this.sysInfo) return this.sysInfo.mic_mac;
    if ('ethernet_mac' in this.sysInfo) return this.sysInfo.ethernet_mac;
    return '';
  }

  /**
   * Normalized cached value of `sysinfo.[mac|mic_mac|ethernet_mac]`
   *
   * Removes all non alphanumeric characters and makes uppercase
   * `aa:bb:cc:00:11:22` will be normalized to `AABBCC001122`
   */
  get macNormalized(): string {
    const mac = this.mac || '';
    return mac.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  }

  /**
   * Closes any open network connections including any shared sockets.
   */
  closeConnection(): void {
    this.connections.udp.close();
    this.connections.tcp.close();
    this.connections.klap.close();
    this.connections.aes.close();
  }

  /**
   * Sends `payload` to device (using {@link Client#send})
   * @param   payload - payload to send to device, if object, converted to string via `JSON.stringify`
   * @returns parsed JSON response
   */
  async send(
    payload: string | Record<string, unknown>,
    sendOptions?: SendOptions,
  ): Promise<string> {
    this.log.debug('[%s] device.send()', this.alias);

    try {
      const thisSendOptions = {
        ...this.defaultSendOptions,
        ...sendOptions,
      } as Required<SendOptions>;
      const payloadString = !(typeof payload === 'string')
        ? JSON.stringify(payload)
        : payload;

      const connection = this.connections[thisSendOptions.transport];
      return await connection.send(
        payloadString,
        this.port,
        this.host,
        thisSendOptions,
      );
    } catch (err) {
      this.log.error('[%s] device.send() %s', this.alias, err);
      throw err;
    }
  }

  /**
   * @internal
   * @alpha
   */
  async sendSingleCommand(
    moduleName: string,
    methodName: string,
    parameters: HasAtLeastOneProperty,
    childIds: string[] | string | undefined = this.childId,
    sendOptions?: SendOptions,
  ): Promise<HasErrCode> {
    const payload: {
      [key: string]: {
        [key: string]: unknown;
        context?: { childIds: string[] };
      };
    } = {
      [moduleName]: { [methodName]: parameters },
    };

    if (childIds) {
      const childIdsArray = castArray(childIds).map((childId) =>
        this.normalizeChildId(childId),
      );
      payload.context = { child_ids: childIdsArray };
    }

    const payloadString = JSON.stringify(payload);

    const response = await this.send(payloadString, sendOptions);
    const results = processSingleCommandResponse(
      moduleName,
      methodName,
      payloadString,
      response,
    );
    return results;
  }

  /**
   * Sends command(s) to device.
   *
   * Calls {@link Device#send} and processes the response.
   *
   * - Adds context.child_ids:[] to the command.
   *   - If `childIds` parameter is set. _or_
   *   - If device was instantiated with a childId it will default to that value.
   *
   * - If only one operation was sent:
   *   - Promise fulfills with specific parsed JSON response for command.\
   *     Example: `{system:{get_sysinfo:{}}}`
   *     - resolves to: `{err_code:0,...}`\
   *     - instead of: `{system:{get_sysinfo:{err_code:0,...}}}` (as {@link Device#send} would)
   * - If more than one operation was sent:
   *   - Promise fulfills with full parsed JSON response (same as {@link Device#send})
   *
   * Also, the response's `err_code`(s) are checked, if any are missing or != `0` the Promise is rejected with {@link ResponseError}.
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async sendCommand(
    command: string | Record<string, unknown>,
    childIds: string[] | string | undefined = this.childId,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    // TODO: allow certain err codes (particularly emeter for non HS110 devices)
    const commandObj = (
      typeof command === 'string' ? JSON.parse(command) : command
    ) as {
      [key: string]: {
        [key: string]: unknown;
        context?: { childIds: string[] };
      };
    };

    if (childIds) {
      const childIdsArray = castArray(childIds).map((childId) =>
        this.normalizeChildId(childId),
      );
      commandObj.context = { child_ids: childIdsArray };
    }

    const response = await this.send(commandObj, sendOptions);
    const results = processResponse(
      commandObj,
      JSON.parse(response) as unknown,
    );
    return results;
  }

  /**
   * Sends a SMART method request to device.
   *
   * - Requests default to `device.defaultSendOptions.transport` when it is
   *   `klap` or `aes`, otherwise they fall back to `klap`.
   * - If `childIds` is specified, the request is wrapped in SMART `control_child`.
   */
  async sendSmartCommand(
    method: string,
    params?: Record<string, unknown> | null,
    childIds: string[] | string | undefined = this.childId,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    const smartSendOptions = { ...sendOptions };
    if (smartSendOptions.transport === undefined) {
      const defaultTransport = this.defaultSendOptions.transport;
      smartSendOptions.transport =
        defaultTransport === 'klap' || defaultTransport === 'aes'
          ? defaultTransport
          : 'klap';
    }

    const childId = this.getSingleSmartChildId(childIds);
    const request = this.createSmartRequestPayload({ method, params });
    const requestToSend =
      childId !== undefined
        ? this.createSmartRequestPayload({
            method: 'control_child',
            params: {
              device_id: childId,
              requestData: {
                method: request.method,
                ...(request.params !== undefined
                  ? { params: request.params }
                  : {}),
              },
            },
          })
        : request;

    const responseString = await this.send(requestToSend, smartSendOptions);
    let responseObj: unknown;
    try {
      responseObj = JSON.parse(responseString);
    } catch {
      throw new Error(`Could not parse SMART response: ${responseString}`);
    }

    if (childId !== undefined) {
      Device.assertSmartSuccess(responseObj, 'control_child', requestToSend);
      if (
        !isObjectLike(responseObj) ||
        !('result' in responseObj) ||
        !isObjectLike(responseObj.result) ||
        !('responseData' in responseObj.result)
      ) {
        throw new Error(
          `Unexpected SMART control_child response: ${responseString}`,
        );
      }
      return Device.processSmartResponse(
        responseObj.result.responseData,
        method,
        requestToSend,
      );
    }

    return Device.processSmartResponse(responseObj, method, requestToSend);
  }

  /**
   * Sends a SMART `multipleRequest` and returns a map keyed by SMART method.
   */
  async sendSmartRequests(
    requests: SmartMethodRequest[],
    childIds: string[] | string | undefined = this.childId,
    sendOptions?: SendOptions,
  ): Promise<SmartMethodResponseMap> {
    if (requests.length === 0) {
      return {};
    }

    const response = await this.sendSmartCommand(
      'multipleRequest',
      {
        requests: requests.map((request) => ({
          method: request.method,
          ...(request.params !== undefined ? { params: request.params } : {}),
        })),
      },
      childIds,
      sendOptions,
    );

    if (!isObjectLike(response)) {
      throw new Error(
        `Unexpected SMART multipleRequest response: ${JSON.stringify(
          response,
        )}`,
      );
    }
    return response as SmartMethodResponseMap;
  }

  private createSmartRequestPayload(
    request: SmartMethodRequest,
  ): SmartRequestPayload {
    return {
      method: request.method,
      ...(request.params !== undefined ? { params: request.params } : {}),
      request_time_milis: Date.now(),
      terminal_uuid: this.smartTerminalUuid,
    };
  }

  private getSingleSmartChildId(
    childIds: string[] | string | undefined,
  ): string | undefined {
    if (childIds === undefined) {
      return undefined;
    }
    const childIdArray = castArray(childIds).map((childId) =>
      this.normalizeChildId(childId),
    );
    if (childIdArray.length > 1) {
      throw new Error('SMART control_child supports a single child id');
    }
    return childIdArray[0];
  }

  private static assertSmartSuccess(
    response: unknown,
    method: string,
    request: SmartRequestPayload,
  ): SmartResponse {
    if (!isSmartResponse(response)) {
      throw new Error(`Unexpected SMART response: ${JSON.stringify(response)}`);
    }
    if (response.error_code !== 0) {
      throw new SmartError(
        `SMART request failed`,
        response.error_code,
        method,
        JSON.stringify(response),
        JSON.stringify(request),
      );
    }
    return response;
  }

  private static processSmartResponse(
    response: unknown,
    method: string,
    request: SmartRequestPayload,
  ): unknown {
    const smartResponse = Device.assertSmartSuccess(response, method, request);

    if (method !== 'multipleRequest') {
      return smartResponse.result;
    }

    if (
      !isObjectLike(smartResponse.result) ||
      !('responses' in smartResponse.result) ||
      !Array.isArray(smartResponse.result.responses)
    ) {
      throw new Error(
        `Unexpected SMART multipleRequest response: ${JSON.stringify(
          smartResponse,
        )}`,
      );
    }

    const multiResults: SmartMethodResponseMap = {};
    smartResponse.result.responses.forEach((responseEntry: unknown) => {
      if (
        !isObjectLike(responseEntry) ||
        typeof responseEntry.method !== 'string' ||
        typeof responseEntry.error_code !== 'number'
      ) {
        throw new Error(
          `Unexpected SMART response entry: ${JSON.stringify(responseEntry)}`,
        );
      }
      if (responseEntry.error_code !== 0) {
        throw new SmartError(
          `SMART request failed`,
          responseEntry.error_code,
          responseEntry.method,
          JSON.stringify(responseEntry),
          JSON.stringify(request),
        );
      }

      multiResults[responseEntry.method] =
        'result' in responseEntry ? responseEntry.result : undefined;
    });
    return multiResults;
  }

  protected normalizeChildId(childId: string): string {
    if (childId.length === 1) {
      return `${this.deviceId}0${childId}`;
    }
    if (childId.length === 2) {
      return this.deviceId + childId;
    }

    return childId;
  }

  /**
   * Gets device's SysInfo.
   *
   * Requests `system.sysinfo` from device. Does not support childId.
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async getSysInfo(sendOptions?: SendOptions): Promise<Sysinfo> {
    this.log.debug('[%s] device.getSysInfo()', this.alias);
    const response = extractResponse<Sysinfo>(
      await this.sendCommand(
        '{"system":{"get_sysinfo":{}}}',
        undefined,
        sendOptions,
      ),
      '',
      isSysinfo,
    );

    this.setSysInfo(response);
    return this.sysInfo;
  }

  /**
   * Change device's alias (name).
   *
   * Sends `system.set_dev_alias` command. Supports childId.
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async setAlias(alias: string, sendOptions?: SendOptions): Promise<boolean> {
    if (this.shouldUseSmartMethods(sendOptions)) {
      await this.sendSmartCommand(
        'set_device_info',
        { nickname: Buffer.from(alias, 'utf8').toString('base64') },
        undefined,
        sendOptions,
      );
      this.setAliasProperty(alias);
      return true;
    }

    await this.sendCommand(
      {
        [this.apiModules.system]: {
          set_dev_alias: { alias },
        },
      },
      this.childId,
      sendOptions,
    );
    this.setAliasProperty(alias);
    return true;
  }

  protected abstract setAliasProperty(alias: string): void;

  /**
   * Set device's location.
   *
   * Sends `system.set_dev_location` command. Does not support childId.
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async setLocation(
    latitude: number,
    longitude: number,
    sendOptions?: SendOptions,
  ): Promise<Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const latitude_i = Math.round(latitude * 10000);
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const longitude_i = Math.round(longitude * 10000);
    const response = await this.sendCommand(
      {
        [this.apiModules.system]: {
          set_dev_location: { latitude, longitude, latitude_i, longitude_i },
        },
      },
      undefined,
      sendOptions,
    );
    if (isObjectLike(response)) return response;
    throw new Error('Unexpected Response');
  }

  /**
   * Gets device's model.
   *
   * Requests `system.sysinfo` and returns model name. Does not support childId.
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async getModel(sendOptions?: SendOptions): Promise<string> {
    const sysInfo = await this.getSysInfo(sendOptions);
    return sysInfo.model;
  }

  /**
   * Reboot device.
   *
   * Sends `system.reboot` command. Does not support childId.
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async reboot(delay: number, sendOptions?: SendOptions): Promise<unknown> {
    if (this.shouldUseSmartMethods(sendOptions)) {
      return this.sendSmartCommand(
        'device_reboot',
        { delay },
        undefined,
        sendOptions,
      );
    }

    return this.sendCommand(
      {
        [this.apiModules.system]: { reboot: { delay } },
      },
      undefined,
      sendOptions,
    );
  }

  /**
   * Reset device.
   *
   * Sends `system.reset` command. Does not support childId.
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async reset(delay: number, sendOptions?: SendOptions): Promise<unknown> {
    if (this.shouldUseSmartMethods(sendOptions)) {
      return this.sendSmartCommand('device_reset', undefined, undefined, sendOptions);
    }

    return this.sendCommand(
      {
        [this.apiModules.system]: { reset: { delay } },
      },
      undefined,
      sendOptions,
    );
  }

  abstract getInfo(sendOptions?: SendOptions): Promise<Record<string, unknown>>;
}

export default Device;
