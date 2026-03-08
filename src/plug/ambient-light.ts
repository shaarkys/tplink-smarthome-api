import type { SendOptions } from '../client';
import type Plug from './index';

export type AmbientLightPreset = {
  adc: number;
  name: string;
  value: number;
};

export type AmbientLightDeviceConfig = {
  dark_index?: number;
  enable?: boolean | number;
  hw_id?: number;
  level_array?: AmbientLightPreset[];
  max_adc?: number;
  min_adc?: number;
};

export type AmbientLightConfigResponse = {
  devs: AmbientLightDeviceConfig[];
  err_code: number;
  ver?: string;
};

/**
 * Legacy ambient light (LAS) module found on PIR wall switches such as KS200M.
 */
export default class AmbientLight {
  #config?: AmbientLightDeviceConfig;

  #brightness?: number;

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

  private applyConfig(response: AmbientLightConfigResponse): void {
    if (Array.isArray(response.devs) && response.devs.length > 0) {
      [this.#config] = response.devs;
    }
  }

  get config(): AmbientLightDeviceConfig | undefined {
    return this.#config;
  }

  get presets(): AmbientLightPreset[] | undefined {
    return this.#config?.level_array;
  }

  get enabled(): boolean | undefined {
    if (this.#config?.enable === undefined) {
      return undefined;
    }
    return Boolean(this.#config.enable);
  }

  get brightness(): number | undefined {
    return this.#brightness;
  }

  async getConfig(
    sendOptions?: SendOptions,
  ): Promise<AmbientLightConfigResponse> {
    this.assertLegacyOnlyMethod('AmbientLight#getConfig', sendOptions);
    const response = (await this.device.sendCommand(
      {
        [this.apiModuleName]: {
          get_config: {},
        },
      },
      this.childId,
      sendOptions,
    )) as AmbientLightConfigResponse;
    this.applyConfig(response);
    return response;
  }

  async getCurrentBrightness(sendOptions?: SendOptions): Promise<number> {
    this.assertLegacyOnlyMethod(
      'AmbientLight#getCurrentBrightness',
      sendOptions,
    );
    const response = (await this.device.sendCommand(
      {
        [this.apiModuleName]: {
          get_current_brt: {},
        },
      },
      this.childId,
      sendOptions,
    )) as { err_code: number; value?: number };
    this.#brightness =
      typeof response.value === 'number' ? response.value : undefined;
    return this.#brightness ?? 0;
  }

  async getInfo(
    sendOptions?: SendOptions,
  ): Promise<{
    config: AmbientLightDeviceConfig | undefined;
    brightness: number | undefined;
  }> {
    this.assertLegacyOnlyMethod('AmbientLight#getInfo', sendOptions);
    const response = (await this.device.sendCommand(
      {
        [this.apiModuleName]: {
          get_config: {},
          get_current_brt: {},
        },
      },
      this.childId,
      sendOptions,
    )) as {
      [key: string]: {
        get_config?: AmbientLightConfigResponse;
        get_current_brt?: { err_code: number; value?: number };
      };
    };

    const las = response[this.apiModuleName];
    if (las?.get_config) {
      this.applyConfig(las.get_config);
    }
    if (typeof las?.get_current_brt?.value === 'number') {
      this.#brightness = las.get_current_brt.value;
    }

    return {
      config: this.#config,
      brightness: this.#brightness,
    };
  }

  async setEnabled(
    value: boolean,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    this.assertLegacyOnlyMethod('AmbientLight#setEnabled', sendOptions);
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

  async setBrightnessLimit(
    value: number,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    this.assertLegacyOnlyMethod(
      'AmbientLight#setBrightnessLimit',
      sendOptions,
    );
    return this.device.sendCommand(
      {
        [this.apiModuleName]: {
          set_brt_level: {
            index: 0,
            value,
          },
        },
      },
      this.childId,
      sendOptions,
    );
  }
}
