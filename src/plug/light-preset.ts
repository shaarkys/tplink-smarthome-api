import type { SendOptions } from '../client';
import { isObjectLike } from '../utils';
import type Plug from './index';

export type SmartPresetRules = {
  brightness?: number[];
  states?: Record<string, unknown>[];
} & Record<string, unknown>;

/**
 * SMART light preset module exposed by devices/channels with `preset`.
 */
export default class LightPreset {
  constructor(
    readonly device: Plug,
    readonly childId: string | undefined = undefined,
  ) {}

  /**
   * Requests SMART `get_preset_rules`.
   */
  async getPresetRules(sendOptions?: SendOptions): Promise<SmartPresetRules> {
    const response = await this.device.sendSmartCommand(
      'get_preset_rules',
      undefined,
      this.childId,
      sendOptions,
    );
    if (!isObjectLike(response)) {
      throw new Error(`Unexpected preset rules response: ${response as string}`);
    }
    return response as SmartPresetRules;
  }

  /**
   * Sends SMART `set_preset_rules`.
   */
  async setPresetRules(
    rules: Record<string, unknown>,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    return this.device.sendSmartCommand(
      'set_preset_rules',
      rules,
      this.childId,
      sendOptions,
    );
  }

  /**
   * Sends SMART `edit_preset_rules`.
   */
  async editPresetRule(
    index: number,
    state: Record<string, unknown>,
    sendOptions?: SendOptions,
  ): Promise<unknown> {
    return this.device.sendSmartCommand(
      'edit_preset_rules',
      { index, state },
      this.childId,
      sendOptions,
    );
  }

  /**
   * Applies a preset by index using the brightness preset list.
   */
  async setPreset(index: number, sendOptions?: SendOptions): Promise<unknown> {
    const rules = await this.getPresetRules(sendOptions);
    if (!Array.isArray(rules.brightness)) {
      throw new Error('Preset brightness list is not available');
    }
    const brightness = rules.brightness[index];
    if (typeof brightness !== 'number') {
      throw new Error(`Preset index ${index} is out of range`);
    }

    const params = { brightness };
    const response = await this.device.sendSmartCommand(
      'set_device_info',
      params,
      this.childId,
      sendOptions,
    );
    this.device.applySmartDeviceInfoPartial(params, this.childId);
    return response;
  }
}
