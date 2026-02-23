import type { AnyDevice, SendOptions } from '../client';
import {
  extractResponse,
  hasErrCode,
  isObjectLike,
  type HasErrCode,
} from '../utils';

export type RealtimeV1 = {
  current?: number;
  power?: number;
  total?: number;
  voltage?: number;
};

export type RealtimeV2 = {
  current_ma?: number;
  power_mw?: number;
  total_wh?: number;
  voltage_mv?: number;
};

export type Realtime = RealtimeV1 | RealtimeV2;

export type RealtimeNormalized = RealtimeV1 & RealtimeV2;

export function isRealtime(candidate: unknown): candidate is Realtime {
  return isObjectLike(candidate);
}

export default class Emeter {
  #realtime: Realtime = {};

  constructor(
    readonly device: AnyDevice,
    readonly apiModuleName: string,
    readonly childId: string | undefined = undefined,
  ) {}

  private isSmartPath(sendOptions?: SendOptions): boolean {
    return (
      'shouldUseSmartMethods' in this.device &&
      typeof this.device.shouldUseSmartMethods === 'function' &&
      this.device.shouldUseSmartMethods(sendOptions)
    );
  }

  private async ensureSmartSupported(sendOptions?: SendOptions): Promise<void> {
    if (
      'negotiateSmartComponents' in this.device &&
      typeof this.device.negotiateSmartComponents === 'function'
    ) {
      await this.device.negotiateSmartComponents(sendOptions);
    }
    if (
      'hasComponent' in this.device &&
      typeof this.device.hasComponent === 'function' &&
      !this.device.hasComponent('energy_monitoring', this.childId)
    ) {
      throw new Error('Emeter module is not supported for this device scope');
    }
  }

  private assertSmartStatsUnsupported(
    methodName: string,
    sendOptions?: SendOptions,
  ): void {
    if (this.isSmartPath(sendOptions)) {
      throw new Error(
        `${methodName} is not supported for SMART devices in tplink-smarthome-api yet.`,
      );
    }
  }

  private toSmartRealtimeFromEnergyUsage(
    energyUsage: Record<string, unknown>,
    currentPower: Record<string, unknown> | undefined,
  ): RealtimeNormalized {
    const realtime: RealtimeNormalized = {};

    if (typeof energyUsage.current_power === 'number') {
      realtime.power_mw = energyUsage.current_power;
    }
    if (
      realtime.power_mw === undefined &&
      currentPower !== undefined &&
      typeof currentPower.current_power === 'number'
    ) {
      // Some devices expose current power in watts via get_current_power.
      realtime.power = currentPower.current_power;
    }
    if (typeof energyUsage.today_energy === 'number') {
      realtime.total_wh = energyUsage.today_energy;
    }

    return realtime;
  }

  private async getSmartRealtime(sendOptions?: SendOptions): Promise<Realtime> {
    await this.ensureSmartSupported(sendOptions);

    try {
      const emeterData = await this.device.sendSmartCommand(
        'get_emeter_data',
        undefined,
        this.childId,
        sendOptions,
      );
      if (isRealtime(emeterData)) {
        return emeterData;
      }
    } catch {
      // Fallback to get_energy_usage / get_current_power on devices without
      // get_emeter_data.
    }

    const energyUsageResponse = await this.device.sendSmartCommand(
      'get_energy_usage',
      undefined,
      this.childId,
      sendOptions,
    );
    if (!isObjectLike(energyUsageResponse)) {
      throw new Error(
        `Unexpected SMART energy usage response: ${JSON.stringify(
          energyUsageResponse,
        )}`,
      );
    }

    let currentPowerResponse: Record<string, unknown> | undefined;
    try {
      const response = await this.device.sendSmartCommand(
        'get_current_power',
        undefined,
        this.childId,
        sendOptions,
      );
      if (isObjectLike(response)) {
        currentPowerResponse = response;
      }
    } catch {
      // Optional fallback method; ignore if unavailable.
    }

    return this.toSmartRealtimeFromEnergyUsage(
      energyUsageResponse as Record<string, unknown>,
      currentPowerResponse,
    );
  }

  /**
   * Returns cached results from last retrieval of `emeter.get_realtime`.
   * @returns {Object}
   */
  get realtime(): RealtimeNormalized {
    return this.#realtime;
  }

  /**
   * @private
   */
  setRealtime(realtime: Realtime): void {
    const normRealtime: RealtimeNormalized = { ...realtime }; // will coerce null/undefined to {}

    const normalize = <K extends keyof RealtimeNormalized>(
      key1: K,
      key2: K,
      multiplier: number,
    ): void => {
      const r = normRealtime;
      if (typeof r[key1] === 'number' && r[key2] === undefined) {
        r[key2] = Math.floor((r[key1] as number) * multiplier);
      } else if (r[key1] == null && typeof r[key2] === 'number') {
        r[key1] = (r[key2] as number) / multiplier;
      }
    };

    normalize('current', 'current_ma', 1000);
    normalize('power', 'power_mw', 1000);
    normalize('total', 'total_wh', 1000);
    normalize('voltage', 'voltage_mv', 1000);

    this.#realtime = normRealtime;
    // @ts-expect-error typescript limitation
    this.device.emit('emeter-realtime-update', this.#realtime);
  }

  /**
   * Gets device's current energy stats.
   *
   * Requests `emeter.get_realtime`. Older devices return `current`, `voltage`, etc,
   * while newer devices return `current_ma`, `voltage_mv` etc
   * This will return a normalized response including both old and new style properties for backwards compatibility.
   * Supports childId.
   * @param   sendOptions
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async getRealtime(sendOptions?: SendOptions): Promise<unknown> {
    if (this.isSmartPath(sendOptions)) {
      this.setRealtime(await this.getSmartRealtime(sendOptions));
      return this.realtime;
    }

    this.setRealtime(
      extractResponse<Realtime & HasErrCode>(
        await this.device.sendCommand(
          {
            [this.apiModuleName]: { get_realtime: {} },
          },
          this.childId,
          sendOptions,
        ),
        '',
        (c) => isRealtime(c) && hasErrCode(c),
      ),
    );
    return this.realtime;
  }

  /**
   * Get Daily Emeter Statistics.
   *
   * Sends `emeter.get_daystat` command. Supports childId.
   * @param   year
   * @param   month
   * @param   sendOptions
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async getDayStats(
    year: number,
    month: number,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    this.assertSmartStatsUnsupported('emeter.getDayStats', sendOptions);
    return this.device.sendCommand(
      {
        [this.apiModuleName]: { get_daystat: { year, month } },
      },
      this.childId,
      sendOptions,
    );
  }

  /**
   * Get Monthly Emeter Statistics.
   *
   * Sends `emeter.get_monthstat` command. Supports childId.
   * @param   year
   * @param   sendOptions
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async getMonthStats(
    year: number,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    this.assertSmartStatsUnsupported('emeter.getMonthStats', sendOptions);
    return this.device.sendCommand(
      {
        [this.apiModuleName]: { get_monthstat: { year } },
      },
      this.childId,
      sendOptions,
    );
  }

  /**
   * Erase Emeter Statistics.
   *
   * Sends `emeter.erase_runtime_stat` command. Supports childId.
   * @param   sendOptions
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async eraseStats(sendOptions?: SendOptions): Promise<unknown> {
    this.assertSmartStatsUnsupported('emeter.eraseStats', sendOptions);
    return this.device.sendCommand(
      {
        [this.apiModuleName]: { erase_emeter_stat: {} },
      },
      this.childId,
      sendOptions,
    );
  }
}
