import type { SendOptions } from '../client';
import type Plug from './index';

const MOTION_RANGE_NAMES = ['Far', 'Mid', 'Near', 'Custom'] as const;

export type MotionRangeName = (typeof MOTION_RANGE_NAMES)[number];

export type MotionConfigResponse = {
  array: number[];
  cold_time: number;
  enable: boolean | number;
  err_code: number;
  max_adc: number;
  min_adc: number;
  trigger_index: number;
  version?: string;
};

export type MotionAdcValueResponse = {
  err_code: number;
  value: number;
};

export type MotionState = {
  adcMax: number;
  adcMid: number;
  adcMin: number;
  adcValue: number;
  enabled: boolean;
  inactivityTimeout: number;
  pirPercent: number;
  pirTriggered: boolean;
  pirValue: number;
  rangeIndex: number;
  rangeName?: MotionRangeName;
  threshold: number;
};

/**
 * Legacy PIR motion module found on wall switches such as KS200M.
 */
export default class Motion {
  #config?: MotionConfigResponse;

  #adcValue?: number;

  constructor(
    readonly device: Plug,
    readonly apiModuleName: string,
    readonly childId: string | undefined = undefined,
  ) {}

  private assertLegacyOnlyMethod(
    methodName: string,
    sendOptions?: SendOptions,
  ): void {
    if (this.device.shouldUseSmartMethods(sendOptions)) {
      throw new Error(`${methodName} is not supported for SMART switches.`);
    }
  }

  private static normalizeRange(range: MotionRangeName | number): number {
    if (typeof range === 'number') {
      return Math.max(0, Math.floor(range));
    }

    const normalized = range.trim().toLowerCase();
    const foundIndex = MOTION_RANGE_NAMES.findIndex(
      (candidate) => candidate.toLowerCase() === normalized,
    );
    if (foundIndex === -1) {
      throw new Error(
        `Invalid motion range "${range}". Expected one of ${MOTION_RANGE_NAMES.join(', ')}`,
      );
    }
    return foundIndex;
  }

  private getRangeThreshold(index: number): number | undefined {
    const array = this.#config?.array;
    if (!Array.isArray(array)) {
      return undefined;
    }
    return array[index];
  }

  private getAdcMid(): number | undefined {
    const config = this.#config;
    if (
      config == null ||
      typeof config.min_adc !== 'number' ||
      typeof config.max_adc !== 'number'
    ) {
      return undefined;
    }
    return Math.floor(Math.abs(config.max_adc - config.min_adc) / 2);
  }

  private getStateFromCache(): MotionState | undefined {
    if (this.#config == null || this.#adcValue === undefined) {
      return undefined;
    }

    const adcMid = this.getAdcMid();
    if (adcMid === undefined) {
      return undefined;
    }

    const rangeIndex = this.#config.trigger_index;
    const threshold = this.getRangeThreshold(rangeIndex) ?? 0;
    const pirValue = adcMid - this.#adcValue;
    const divisor =
      pirValue < 0
        ? adcMid - this.#config.min_adc
        : this.#config.max_adc - adcMid;
    const pirPercent = divisor === 0 ? 0 : (pirValue / divisor) * 100;
    const enabled = Boolean(this.#config.enable);

    return {
      adcMax: this.#config.max_adc,
      adcMid,
      adcMin: this.#config.min_adc,
      adcValue: this.#adcValue,
      enabled,
      inactivityTimeout: this.#config.cold_time,
      pirPercent,
      pirTriggered: enabled && Math.abs(pirPercent) > 100 - threshold,
      pirValue,
      rangeIndex,
      rangeName: MOTION_RANGE_NAMES[rangeIndex],
      threshold,
    };
  }

  get config(): MotionConfigResponse | undefined {
    return this.#config;
  }

  get state(): MotionState | undefined {
    return this.getStateFromCache();
  }

  async getConfig(sendOptions?: SendOptions): Promise<MotionConfigResponse> {
    this.assertLegacyOnlyMethod('Motion#getConfig', sendOptions);
    const response = (await this.device.sendCommand(
      {
        [this.apiModuleName]: {
          get_config: {},
        },
      },
      this.childId,
      sendOptions,
    )) as MotionConfigResponse;
    this.#config = response;
    return response;
  }

  async getAdcValue(sendOptions?: SendOptions): Promise<number> {
    this.assertLegacyOnlyMethod('Motion#getAdcValue', sendOptions);
    const response = (await this.device.sendCommand(
      {
        [this.apiModuleName]: {
          get_adc_value: {},
        },
      },
      this.childId,
      sendOptions,
    )) as MotionAdcValueResponse;
    this.#adcValue =
      typeof response.value === 'number' ? response.value : undefined;
    return this.#adcValue ?? 0;
  }

  async getInfo(sendOptions?: SendOptions): Promise<MotionState | undefined> {
    this.assertLegacyOnlyMethod('Motion#getInfo', sendOptions);
    const response = (await this.device.sendCommand(
      {
        [this.apiModuleName]: {
          get_config: {},
          get_adc_value: {},
        },
      },
      this.childId,
      sendOptions,
    )) as {
      [key: string]: {
        get_config?: MotionConfigResponse;
        get_adc_value?: MotionAdcValueResponse;
      };
    };

    const pir = response[this.apiModuleName];
    if (pir?.get_config) {
      this.#config = pir.get_config;
    }
    if (typeof pir?.get_adc_value?.value === 'number') {
      this.#adcValue = pir.get_adc_value.value;
    }
    return this.getStateFromCache();
  }

  async setEnabled(
    value: boolean,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    this.assertLegacyOnlyMethod('Motion#setEnabled', sendOptions);
    const response = await this.device.sendCommand(
      {
        [this.apiModuleName]: {
          set_enable: { enable: value ? 1 : 0 },
        },
      },
      this.childId,
      sendOptions,
    );
    if (this.#config) {
      this.#config = { ...this.#config, enable: value ? 1 : 0 };
    }
    return response;
  }

  async setRange(
    range: MotionRangeName | number,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    this.assertLegacyOnlyMethod('Motion#setRange', sendOptions);
    const index = Motion.normalizeRange(range);
    const response = await this.device.sendCommand(
      {
        [this.apiModuleName]: {
          set_trigger_sens: { index },
        },
      },
      this.childId,
      sendOptions,
    );
    if (this.#config) {
      this.#config = { ...this.#config, trigger_index: index };
    }
    return response;
  }

  async setThreshold(
    value: number,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    this.assertLegacyOnlyMethod('Motion#setThreshold', sendOptions);
    const response = await this.device.sendCommand(
      {
        [this.apiModuleName]: {
          set_trigger_sens: {
            index: 3,
            value,
          },
        },
      },
      this.childId,
      sendOptions,
    );
    if (this.#config) {
      const nextArray = Array.isArray(this.#config.array)
        ? [...this.#config.array]
        : [];
      nextArray[3] = value;
      this.#config = {
        ...this.#config,
        array: nextArray,
        trigger_index: 3,
      };
    }
    return response;
  }

  async setInactivityTimeout(
    timeout: number,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    this.assertLegacyOnlyMethod('Motion#setInactivityTimeout', sendOptions);
    const response = await this.device.sendCommand(
      {
        [this.apiModuleName]: {
          set_cold_time: { cold_time: timeout },
        },
      },
      this.childId,
      sendOptions,
    );
    if (this.#config) {
      this.#config = { ...this.#config, cold_time: timeout };
    }
    return response;
  }
}
