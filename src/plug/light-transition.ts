import type { SendOptions } from '../client';
import { isObjectLike } from '../utils';
import type Plug from './index';

type TransitionState = {
  enable?: boolean;
  duration?: number;
  max_duration?: number;
};

export type LightTransitionInfo = {
  enable?: boolean;
  duration?: number;
  on_state?: TransitionState;
  off_state?: TransitionState;
} & Record<string, unknown>;

/**
 * SMART gradual on/off transitions (`on_off_gradually`).
 */
export default class LightTransition {
  constructor(
    readonly device: Plug,
    readonly childId: string | undefined = undefined,
  ) {}

  private async ensureSupported(sendOptions?: SendOptions): Promise<void> {
    await this.device.negotiateSmartComponents(sendOptions);
    if (!this.device.supportsLightTransition) {
      throw new Error(
        'LightTransition module is not supported for this device scope',
      );
    }
  }

  /**
   * Requests SMART `get_on_off_gradually_info`.
   */
  async getInfo(sendOptions?: SendOptions): Promise<LightTransitionInfo> {
    await this.ensureSupported(sendOptions);
    const response = await this.device.sendSmartCommand(
      'get_on_off_gradually_info',
      undefined,
      this.childId,
      sendOptions,
    );
    if (!isObjectLike(response)) {
      throw new Error(
        `Unexpected light transition response: ${response as string}`,
      );
    }
    return response as LightTransitionInfo;
  }

  /**
   * Sends SMART `set_on_off_gradually_info`.
   */
  async setInfo(
    params: Record<string, unknown>,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    await this.ensureSupported(sendOptions);
    return this.device.sendSmartCommand(
      'set_on_off_gradually_info',
      params,
      this.childId,
      sendOptions,
    );
  }

  /**
   * Enables/disables gradual transitions.
   */
  async setEnabled(enable: boolean, sendOptions?: SendOptions): Promise<unknown> {
    const current = await this.getInfo(sendOptions);
    if (
      isObjectLike(current.on_state) ||
      isObjectLike(current.off_state)
    ) {
      const params: Record<string, unknown> = {
        on_state: {
          ...(isObjectLike(current.on_state)
            ? (current.on_state as Record<string, unknown>)
            : {}),
          enable,
        },
        off_state: {
          ...(isObjectLike(current.off_state)
            ? (current.off_state as Record<string, unknown>)
            : {}),
          enable,
        },
      };
      return this.setInfo(params, sendOptions);
    }
    return this.setInfo({ enable }, sendOptions);
  }

  /**
   * Sets gradual turn-on duration (seconds) for devices exposing `on_state`.
   */
  async setTurnOnTransition(
    seconds: number,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    return this.setStateTransition('on_state', seconds, sendOptions);
  }

  /**
   * Sets gradual turn-off duration (seconds) for devices exposing `off_state`.
   */
  async setTurnOffTransition(
    seconds: number,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    return this.setStateTransition('off_state', seconds, sendOptions);
  }

  private async setStateTransition(
    stateKey: 'on_state' | 'off_state',
    seconds: number,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    const current = await this.getInfo(sendOptions);
    const targetState = current[stateKey];

    if (isObjectLike(targetState)) {
      const params = {
        [stateKey]: {
          ...(targetState as Record<string, unknown>),
          enable: seconds > 0,
          duration: seconds,
        },
      };
      return this.setInfo(params, sendOptions);
    }

    return this.setInfo(
      {
        enable: seconds > 0,
        duration: seconds,
      },
      sendOptions,
    );
  }
}
