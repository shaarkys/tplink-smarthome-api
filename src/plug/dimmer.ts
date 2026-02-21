import type { SendOptions } from '../client';
import type Plug from './index';

export interface DimmerTransitionInput {
  /**
   * 0-100
   */
  brightness?: number;
  /**
   * "gentle_on_off", etc.
   */
  mode?: string;
  /**
   * duration in seconds
   */
  duration?: number;
}

export interface DimmerActionInput {
  mode?: string;
  index?: number;
}

/**
 * Dimmer
 *
 * TP-Link models: HS220 and child-dimmer channels exposed on some multi-channel switches.
 */
export default class Dimmer {
  /**
   * @internal
   */
  lastState = { brightness: -1 };

  /**
   * @internal
   */
  #brightness = 0;

  constructor(
    readonly device: Plug,
    readonly apiModuleName: string,
    readonly childId: string | undefined = undefined,
  ) {}

  /**
   * Cached value of `sysinfo.brightness`.
   */
  get brightness(): number {
    return this.#brightness;
  }

  /**
   * @internal
   */
  setBrightnessValue(brightness: number): void {
    this.#brightness = brightness;
    this.device.log.debug('[%s] plug.dimmer brightness set', this.device.alias);
    this.emitEvents();
  }

  /**
   * Sets Plug to the specified `brightness`.
   *
   * Sends `dimmer.set_brightness` command. Supports childId when configured on `Plug`.
   * @param   brightness - 0-100
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async setBrightness(
    brightness: number,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    const results = this.device.sendCommand(
      {
        [this.apiModuleName]: {
          set_brightness: { brightness },
        },
      },
      this.childId,
      sendOptions,
    );

    this.setBrightnessValue(brightness);

    return results;
  }

  /**
   * Get Plug/Dimmer default behavior configuration.
   *
   * Requests `dimmer.get_default_behavior`. Supports childId when configured on `Plug`.
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async getDefaultBehavior(sendOptions?: SendOptions): Promise<unknown> {
    return this.device.sendCommand(
      {
        [this.apiModuleName]: {
          get_default_behavior: {},
        },
      },
      this.childId,
      sendOptions,
    );
  }

  /**
   * Get Plug/Dimmer parameters configuration.
   *
   * Requests `dimmer.get_dimmer_parameters`. Supports childId when configured on `Plug`.
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async getDimmerParameters(sendOptions?: SendOptions): Promise<unknown> {
    return this.device.sendCommand(
      {
        [this.apiModuleName]: {
          get_dimmer_parameters: {},
        },
      },
      this.childId,
      sendOptions,
    );
  }

  /**
   * Transitions Plug to the specified `brightness`.
   *
   * Sends `dimmer.set_dimmer_transition` command. Supports childId when configured on `Plug`.
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async setDimmerTransition(
    dimmerTransition: DimmerTransitionInput,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    const { brightness, mode, duration } = dimmerTransition;

    const results = this.device.sendCommand(
      {
        [this.apiModuleName]: {
          set_dimmer_transition: {
            brightness,
            mode,
            duration,
          },
        },
      },
      this.childId,
      sendOptions,
    );

    if (brightness !== undefined) this.setBrightnessValue(brightness);

    return results;
  }

  /**
   * Set Plug/Dimmer `default_behavior` configuration for `double_click`.
   *
   * Sends `dimmer.set_double_click_action`. Supports childId when configured on `Plug`.
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async setDoubleClickAction(
    { mode, index }: DimmerActionInput,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    return this.setAction(
      {
        actionName: 'set_double_click_action',
        mode,
        index,
      },
      sendOptions,
    );
  }

  private async setAction(
    {
      actionName,
      mode,
      index,
    }: {
      actionName: string;
      mode?: string;
      index?: number;
    },
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    return this.device.sendCommand(
      {
        [this.apiModuleName]: {
          [actionName]: { mode, index },
        },
      },
      this.childId,
      sendOptions,
    );
  }

  /**
   * Set Plug `dimmer_parameters` for `fadeOffTime`.
   *
   * Sends `dimmer.set_fade_off_time`. Supports childId when configured on `Plug`.
   * @param   fadeTime - duration in ms
   * @param   sendOptions
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async setFadeOffTime(
    fadeTime: number,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    return this.device.sendCommand(
      {
        [this.apiModuleName]: {
          set_fade_off_time: { fadeTime },
        },
      },
      this.childId,
      sendOptions,
    );
  }

  /**
   * Set Plug `dimmer_parameters` for `fadeOnTime`.
   *
   * Sends `dimmer.set_fade_on_time`. Supports childId when configured on `Plug`.
   * @param   fadeTime - duration in ms
   * @param   sendOptions
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async setFadeOnTime(
    fadeTime: number,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    return this.device.sendCommand(
      {
        [this.apiModuleName]: {
          set_fade_on_time: { fadeTime },
        },
      },
      this.childId,
      sendOptions,
    );
  }

  /**
   * Set Plug `dimmer_parameters` for `gentleOffTime`.
   *
   * Sends `dimmer.set_gentle_off_time`. Supports childId when configured on `Plug`.
   * @param   duration - duration in ms
   * @param   sendOptions
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async setGentleOffTime(
    duration: number,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    return this.device.sendCommand(
      {
        [this.apiModuleName]: {
          set_gentle_off_time: { duration },
        },
      },
      this.childId,
      sendOptions,
    );
  }

  /**
   * Set Plug `dimmer_parameters` for `gentleOnTime`.
   *
   * Sends `dimmer.set_gentle_on_time`. Supports childId when configured on `Plug`.
   * @param   duration - duration in ms
   * @param   sendOptions
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async setGentleOnTime(
    duration: number,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    return this.device.sendCommand(
      {
        [this.apiModuleName]: {
          set_gentle_on_time: { duration },
        },
      },
      this.childId,
      sendOptions,
    );
  }

  /**
   * Set Plug/Dimmer `default_behavior` configuration for `long_press`.
   *
   * Sends `dimmer.set_long_press_action`. Supports childId when configured on `Plug`.
   * @param   options
   * @param   options.mode
   * @param   options.index
   * @param   sendOptions
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async setLongPressAction(
    { mode, index }: DimmerActionInput,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    return this.setAction(
      { actionName: 'set_long_press_action', mode, index },
      sendOptions,
    );
  }

  /**
   * Sets Plug to the specified on/off state.
   *
   * Sends `dimmer.set_switch_state` command. Supports childId when configured on `Plug`.
   * @param  {Boolean}     state  true=on, false=off
   * @param  {SendOptions} [sendOptions]
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async setSwitchState(
    state: boolean | 0 | 1,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    return this.device.sendCommand(
      {
        [this.apiModuleName]: {
          set_switch_state: { state: state ? 1 : 0 },
        },
      },
      this.childId,
      sendOptions,
    );
  }

  /**
   * @internal
   */
  public emitEvents(): void {
    const brightness = this.#brightness;

    this.device.log.debug(
      '[%s] plug.dimmer.emitEvents() brightness: %s lastState: %j',
      this.device.alias,
      brightness,
      this.lastState,
    );

    if (this.lastState.brightness !== brightness) {
      this.lastState.brightness = brightness;
      this.device.emit('brightness-change', brightness);
    }
    this.device.emit('brightness-update', brightness);
  }
}
