import type { AnyDevice, SendOptions } from '../client';
import { isObjectLike } from '../utils';

export type TimerRule = {
  id?: string;
  name?: string;
  enable?: number;
  act?: number;
  delay?: number;
};

export type TimerRuleInput = {
  name?: string;
  enable: boolean;
  powerState: boolean | 0 | 1;
  delay: number;
};

export default class Timer {
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
      !this.device.hasComponent('auto_off', this.childId)
    ) {
      throw new Error('Timer module is not supported for this device scope');
    }
  }

  private assertSmartPowerStateSupported(powerState: boolean | 0 | 1): void {
    if (powerState === true || powerState === 1) {
      throw new Error(
        'SMART auto_off only supports powerState=false (turn off after delay)',
      );
    }
  }

  private getEnableBoolean(config: Record<string, unknown>): boolean {
    if (typeof config.enable === 'boolean') {
      return config.enable;
    }
    if (typeof config.enable === 'number') {
      return config.enable !== 0;
    }
    return false;
  }

  private getDelayMinutes(config: Record<string, unknown>): number {
    return typeof config.delay_min === 'number' ? config.delay_min : 0;
  }

  private toAutoOffDelayMinutes(delaySeconds: number): number {
    return Math.max(1, Math.ceil(delaySeconds / 60));
  }

  private toLegacyRule(config: Record<string, unknown>): TimerRule {
    const delayMin = this.getDelayMinutes(config);
    return {
      id: 'auto_off',
      name: 'auto_off',
      enable: this.getEnableBoolean(config) ? 1 : 0,
      act: 0,
      delay: delayMin * 60,
    };
  }

  private async getAutoOffConfig(
    sendOptions?: SendOptions,
  ): Promise<Record<string, unknown>> {
    const response = await this.device.sendSmartCommand(
      'get_auto_off_config',
      undefined,
      this.childId,
      sendOptions,
    );
    if (!isObjectLike(response)) {
      throw new Error(
        `Unexpected SMART auto_off config response: ${JSON.stringify(response)}`,
      );
    }
    return response as Record<string, unknown>;
  }

  private async setAutoOffConfig(
    config: {
      enable: boolean;
      delay_min: number;
    },
    sendOptions?: SendOptions,
  ): Promise<void> {
    await this.device.sendSmartCommand(
      'set_auto_off_config',
      config,
      this.childId,
      sendOptions,
    );
  }

  /**
   * Get Countdown Timer Rule (only one allowed).
   *
   * Requests `count_down.get_rules`. Supports childId.
   * @param  {string[]|string|number[]|number} [childIds] for multi-outlet devices, which outlet(s) to target
   * @param  {SendOptions} [sendOptions]
   * @throws {@link ResponseError}
   */
  async getRules(sendOptions?: SendOptions): Promise<unknown> {
    if (this.isSmartPath(sendOptions)) {
      await this.ensureSmartSupported(sendOptions);
      const config = await this.getAutoOffConfig(sendOptions);
      return {
        err_code: 0,
        rule_list: [this.toLegacyRule(config)],
      };
    }

    return this.device.sendCommand(
      {
        [this.apiModuleName]: { get_rules: {} },
      },
      this.childId,
      sendOptions,
    );
  }

  /**
   * Add Countdown Timer Rule (only one allowed).
   *
   * Sends count_down.add_rule command. Supports childId.
   * @param  {Object}       options
   * @param  {number}       options.delay                delay in seconds
   * @param  {boolean}      options.powerState           turn on or off device
   * @param  {string}      [options.name='timer']        rule name
   * @param  {boolean}     [options.enable=true]         rule enabled
   * @param  {boolean}     [options.deleteExisting=true] send `delete_all_rules` command before adding

   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async addRule(
    {
      delay,
      powerState,
      name = 'timer',
      enable = true,
      deleteExisting = true,
    }: TimerRuleInput & { deleteExisting: boolean },
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    if (this.isSmartPath(sendOptions)) {
      await this.ensureSmartSupported(sendOptions);
      this.assertSmartPowerStateSupported(powerState);

      if (!deleteExisting) {
        const existingConfig = await this.getAutoOffConfig(sendOptions);
        if (this.getEnableBoolean(existingConfig)) {
          throw new Error(
            'SMART auto_off has a single rule; disable existing rule first or use deleteExisting=true',
          );
        }
      }

      await this.setAutoOffConfig(
        {
          enable,
          delay_min: this.toAutoOffDelayMinutes(delay),
        },
        sendOptions,
      );
      return { err_code: 0, id: 'auto_off' };
    }

    if (deleteExisting) await this.deleteAllRules(sendOptions);
    return this.device.sendCommand(
      {
        [this.apiModuleName]: {
          add_rule: {
            enable: enable ? 1 : 0,
            delay,
            act: powerState ? 1 : 0,
            name,
          },
        },
      },
      this.childId,
      sendOptions,
    );
  }

  /**
   * Edit Countdown Timer Rule (only one allowed).
   *
   * Sends count_down.edit_rule command. Supports childId.
   * @param  {Object}       options
   * @param  {string}       options.id               rule id
   * @param  {number}       options.delay            delay in seconds
   * @param  {number}       options.powerState       turn on or off device
   * @param  {string}      [options.name='timer']    rule name
   * @param  {Boolean}     [options.enable=true]     rule enabled
   *
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async editRule(
    {
      id,
      delay,
      powerState,
      name = 'timer',
      enable = true,
    }: TimerRuleInput & { id: string },
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    if (this.isSmartPath(sendOptions)) {
      await this.ensureSmartSupported(sendOptions);
      this.assertSmartPowerStateSupported(powerState);

      await this.setAutoOffConfig(
        {
          enable,
          delay_min: this.toAutoOffDelayMinutes(delay),
        },
        sendOptions,
      );
      return { err_code: 0, id };
    }

    return this.device.sendCommand(
      {
        [this.apiModuleName]: {
          edit_rule: {
            id,
            enable: enable ? 1 : 0,
            delay,
            act: powerState ? 1 : 0,
            name,
          },
        },
      },
      this.childId,
      sendOptions,
    );
  }

  /**
   * Delete Countdown Timer Rule (only one allowed).
   *
   * Sends count_down.delete_all_rules command. Supports childId.
   * @param  {SendOptions} [sendOptions]
   * @returns {Promise<Object, ResponseError>} parsed JSON response
   */
  async deleteAllRules(sendOptions?: SendOptions): Promise<unknown> {
    if (this.isSmartPath(sendOptions)) {
      await this.ensureSmartSupported(sendOptions);
      const current = await this.getAutoOffConfig(sendOptions);
      await this.setAutoOffConfig(
        {
          enable: false,
          delay_min: this.getDelayMinutes(current),
        },
        sendOptions,
      );
      return { err_code: 0 };
    }

    return this.device.sendCommand(
      {
        [this.apiModuleName]: { delete_all_rules: {} },
      },
      this.childId,
      sendOptions,
    );
  }
}
