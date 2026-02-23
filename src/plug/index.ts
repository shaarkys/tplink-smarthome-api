/* eslint-disable no-underscore-dangle */
import type { SendOptions } from '../client';
import Device, {
  isPlugSysinfo,
  type CommonSysinfo,
  type DeviceConstructorOptions,
  type Sysinfo,
} from '../device';
import Cloud, { isCloudInfo, type CloudInfo } from '../shared/cloud';
import Emeter, { RealtimeNormalized } from '../shared/emeter';
import Time from '../shared/time';
import {
  ResponseError,
  extractResponse,
  hasErrCode,
  isDefinedAndNotNull,
  isObjectLike,
  type HasErrCode,
} from '../utils';
import Away from './away';
import Dimmer from './dimmer';
import Fan from './fan';
import LightPreset from './light-preset';
import LightTransition from './light-transition';
import OverheatProtection from './overheat-protection';
import Schedule from './schedule';
import SmartLed from './smart-led';
import Timer from './timer';

export type PlugChild = {
  id: string;
  alias: string;
  state: number;
  category?: string;
  model?: string;
  brightness?: number;
  auto_off_status?: string;
  auto_off_remain_time?: number;
  fan_speed_level?: number;
  fan_sleep_mode_on?: boolean;
  overheat_status?: string;
  overheated?: boolean;
  components?: string[];
};

export type SmartComponentInfo = {
  id: string;
  ver_code: number;
};

export type SysinfoChildren = {
  children?: PlugChild[];
};

export type PlugSysinfo = CommonSysinfo &
  SysinfoChildren &
  (
    | {
        type:
          | 'IOT.SMARTPLUGSWITCH'
          | 'IOT.RANGEEXTENDER.SMARTPLUG'
          | 'SMART.KASASWITCH'
          | 'SMART.TAPOSWITCH';
      }
    | { mic_type: 'IOT.SMARTPLUGSWITCH' }
  ) &
  ({ mac: string } | { ethernet_mac: string }) & {
    feature?: string;
    led_off?: 0 | 1;
    relay_state?: 0 | 1;
    device_on?: boolean;
    dev_name?: string;
    brightness?: number;
    auto_off_status?: string;
    auto_off_remain_time?: number;
    fan_speed_level?: number;
    fan_sleep_mode_on?: boolean;
    overheat_status?: string;
    overheated?: boolean;
    components?: string[];
  };

export function hasSysinfoChildren(
  candidate: Sysinfo,
): candidate is Sysinfo & Required<SysinfoChildren> {
  return (
    'children' in candidate &&
    candidate.children !== undefined &&
    // eslint rule false positive
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    candidate.children.length > 0
  );
}

export interface PlugConstructorOptions extends DeviceConstructorOptions {
  sysInfo: PlugSysinfo;
  /**
   * Watts
   * @defaultValue 0.1
   */
  inUseThreshold?: number;
  /**
   * If passed a string between 0 and 99 it will prepend the deviceId
   */
  childId?: string;
}

export interface PlugEvents {
  /**
   * Plug's Energy Monitoring Details were updated from device. Fired regardless if status was changed.
   * @event Plug#emeter-realtime-update
   */
  'emeter-realtime-update': (value: RealtimeNormalized) => void;
  /**
   * Plug's relay was turned on.
   */
  'power-on': () => void;
  /**
   * Plug's relay was turned off.
   */
  'power-off': () => void;
  /**
   * Plug's relay state was updated from device. Fired regardless if status was changed.
   */
  'power-update': (value: boolean) => void;
  /**
   * Plug's relay was turned on _or_ power draw exceeded `inUseThreshold`
   */
  'in-use': () => void;
  /**
   * Plug's relay was turned off _or_ power draw fell below `inUseThreshold`
   */
  'not-in-use': () => void;
  /**
   * Plug's in-use state was updated from device. Fired regardless if status was changed.
   */
  'in-use-update': (value: boolean) => void;

  'brightness-change': (value: number) => void;
  'brightness-update': (value: number) => void;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
declare interface Plug {
  on<U extends keyof PlugEvents>(event: U, listener: PlugEvents[U]): this;

  emit<U extends keyof PlugEvents>(
    event: U,
    ...args: Parameters<PlugEvents[U]>
  ): boolean;
}

/**
 * Plug Device.
 *
 * TP-Link models: HS100, HS105, HS107, HS110, HS200, HS210, HS220, HS300.
 *
 * Models with multiple outlets (HS107, HS300) will have a children property.
 * If Plug is instantiated with a childId it will control the outlet associated with that childId.
 * Some functions only apply to the entire device, and are noted below.
 *
 * Emits events after device status is queried, such as {@link Plug#getSysInfo} and {@link Plug#emeter.getRealtime}.
 * @extends Device
 * @extends EventEmitter
 * @fires  Plug#power-on
 * @fires  Plug#power-off
 * @fires  Plug#power-update
 * @fires  Plug#in-use
 * @fires  Plug#not-in-use
 * @fires  Plug#in-use-update
 * @fires  Plug#emeter-realtime-update
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
class Plug extends Device {
  protected override _sysInfo: PlugSysinfo;

  #children: Map<string, PlugChild> = new Map();

  #componentVersions: Map<string, number> = new Map();

  #childComponentVersions: Map<string, Map<string, number>> = new Map();

  #componentsNegotiated = false;

  #child?: PlugChild;

  #childId?: string;

  inUseThreshold = 0.1;

  emitEventsEnabled = true;

  /**
   * @internal
   */
  lastState = { inUse: false, relayState: false };

  readonly apiModules = {
    system: 'system',
    cloud: 'cnCloud',
    schedule: 'schedule',
    timesetting: 'time',
    emeter: 'emeter',
    netif: 'netif',
    lightingservice: '',
  };

  away: Away;

  cloud: Cloud;

  dimmer: Dimmer;

  fan: Fan;

  lightPreset: LightPreset;

  lightTransition: LightTransition;

  overheatProtection: OverheatProtection;

  emeter: Emeter;

  schedule: Schedule;

  smartLed: SmartLed;

  time: Time;

  timer: Timer;

  /**
   * Created by {@link Client} - Do not instantiate directly.
   *
   * See [Device constructor]{@link Device} for common options.
   */
  constructor(options: PlugConstructorOptions) {
    super({
      client: options.client,
      _sysInfo: options.sysInfo,
      host: options.host,
      port: options.port,
      logger: options.logger,
      defaultSendOptions: options.defaultSendOptions,
      credentials: options.credentials,
      credentialsHash: options.credentialsHash,
    });

    const { sysInfo, inUseThreshold = 0.1, childId } = options;

    this.log.debug('plug.constructor()');

    /**
     * @borrows Away#getRules as Plug.away#getRules
     * @borrows Away#addRule as Plug.away#addRule
     * @borrows Away#editRule as Plug.away#editRule
     * @borrows Away#deleteAllRules as Plug.away#deleteAllRules
     * @borrows Away#deleteRule as Plug.away#deleteRule
     * @borrows Away#setOverallEnable as Plug.away#setOverallEnable
     */
    this.away = new Away(this, 'anti_theft', childId);

    /**
     * @borrows Cloud#getInfo as Plug.cloud#getInfo
     * @borrows Cloud#bind as Plug.cloud#bind
     * @borrows Cloud#unbind as Plug.cloud#unbind
     * @borrows Cloud#getFirmwareList as Plug.cloud#getFirmwareList
     * @borrows Cloud#setServerUrl as Plug.cloud#setServerUrl
     */
    this.cloud = new Cloud(this, 'cnCloud');

    /**
     * @borrows Dimmer#setBrightness as Plug.dimmer#setBrightness
     * @borrows Dimmer#getDefaultBehavior as Plug.dimmer#getDefaultBehavior
     * @borrows Dimmer#getDimmerParameters as Plug.dimmer#getDimmerParameters
     * @borrows Dimmer#setDimmerTransition as Plug.dimmer#setDimmerTransition
     * @borrows Dimmer#setDoubleClickAction as Plug.dimmer#setDoubleClickAction
     * @borrows Dimmer#setFadeOffTime as Plug.dimmer#setFadeOffTime
     * @borrows Dimmer#setFadeOnTime as Plug.dimmer#setFadeOnTime
     * @borrows Dimmer#setGentleOffTime as Plug.dimmer#setGentleOffTime
     * @borrows Dimmer#setGentleOnTime as Plug.dimmer#setGentleOnTime
     * @borrows Dimmer#setLongPressAction as Plug.dimmer#setLongPressAction
     * @borrows Dimmer#setSwitchState as Plug.dimmer#setSwitchState
     */
    this.dimmer = new Dimmer(this, 'smartlife.iot.dimmer', childId);

    this.fan = new Fan(this, childId);

    this.lightPreset = new LightPreset(this, childId);

    this.lightTransition = new LightTransition(this, childId);

    this.overheatProtection = new OverheatProtection(this, childId);

    /**
     * @borrows Emeter#realtime as Plug.emeter#realtime
     * @borrows Emeter#getRealtime as Plug.emeter#getRealtime
     * @borrows Emeter#getDayStats as Plug.emeter#getDayStats
     * @borrows Emeter#getMonthStats as Plug.emeter#getMonthStats
     * @borrows Emeter#eraseStats as Plug.emeter#eraseStats
     */
    this.emeter = new Emeter(this, 'emeter', childId);

    /**
     * @borrows Schedule#getNextAction as Plug.schedule#getNextAction
     * @borrows Schedule#getRules as Plug.schedule#getRules
     * @borrows Schedule#getRule as Plug.schedule#getRule
     * @borrows PlugSchedule#addRule as Plug.schedule#addRule
     * @borrows PlugSchedule#editRule as Plug.schedule#editRule
     * @borrows Schedule#deleteAllRules as Plug.schedule#deleteAllRules
     * @borrows Schedule#deleteRule as Plug.schedule#deleteRule
     * @borrows Schedule#setOverallEnable as Plug.schedule#setOverallEnable
     * @borrows Schedule#getDayStats as Plug.schedule#getDayStats
     * @borrows Schedule#getMonthStats as Plug.schedule#getMonthStats
     * @borrows Schedule#eraseStats as Plug.schedule#eraseStats
     */
    this.schedule = new Schedule(this, 'schedule', childId);

    /**
     * @borrows Time#getTime as Plug.time#getTime
     * @borrows Time#getTimezone as Plug.time#getTimezone
     */
    this.time = new Time(this, 'time');

    /**
     * @borrows Timer#getRules as Plug.timer#getRules
     * @borrows Timer#addRule as Plug.timer#addRule
     * @borrows Timer#editRule as Plug.timer#editRule
     * @borrows Timer#deleteAllRules as Plug.timer#deleteAllRules
     */
    this.timer = new Timer(this, 'count_down', childId);

    this.smartLed = new SmartLed(this, childId);

    this._sysInfo = sysInfo;
    this.setSysInfo(sysInfo);

    this.inUseThreshold = inUseThreshold;

    if (isDefinedAndNotNull(childId)) this.setChildId(childId);

    this.lastState.inUse = this.inUse;
    this.lastState.relayState = this.relayState;
  }

  override get sysInfo(): PlugSysinfo {
    return this._sysInfo;
  }

  /**
   * @internal
   */
  override setSysInfo(sysInfo: PlugSysinfo): void {
    super.setSysInfo(sysInfo);
    this.setComponentVersionsFromList(sysInfo.components);
    if (sysInfo.children) {
      this.setChildren(sysInfo.children);
    }
    const brightness = this.getBrightnessValue();
    if (brightness !== undefined) {
      this.dimmer.setBrightnessValue(brightness);
    }
    this.log.debug('[%s] plug sysInfo set', this.alias);
    this.emitEvents();
  }

  /**
   * Returns children as a map keyed by childId. From cached results from last retrieval of `system.sysinfo.children`.
   */
  get children(): Map<string, PlugChild> {
    return this.#children;
  }

  private setChildren(children: PlugChild[] | Map<string, PlugChild>): void {
    if (Array.isArray(children)) {
      this.#children = new Map(
        children.map((child) => {
          // eslint-disable-next-line no-param-reassign
          child.id = this.normalizeChildId(child.id);
          return [child.id, child];
        }),
      );
    } else if (children instanceof Map) {
      this.#children = children;
    }

    const currentChildIds = new Set(this.#children.keys());
    Array.from(this.#childComponentVersions.keys()).forEach((childId) => {
      if (!currentChildIds.has(childId)) {
        this.#childComponentVersions.delete(childId);
      }
    });

    this.setChildComponentVersionsFromChildren(this.#children);
    this.updateNegotiationFlag();

    if (this.#childId !== undefined) this.setChildId(this.#childId);
  }

  /**
   * Returns childId.
   */
  override get childId(): string | undefined {
    return this.#childId;
  }

  private setChildId(childId: string): void {
    this.#childId = this.normalizeChildId(childId);
    if (this.#childId) {
      this.#child = this.#children.get(this.#childId);
    }
    if (this.#childId && this.#child == null) {
      throw new Error(`Could not find child with childId ${childId}`);
    }
    const brightness = this.getBrightnessValue();
    if (brightness !== undefined) {
      this.dimmer.setBrightnessValue(brightness);
    }
  }

  private getBrightnessValue(): number | undefined {
    if (this.#childId && this.#child?.brightness !== undefined) {
      return this.#child.brightness;
    }
    return this.sysInfo.brightness;
  }

  private getFanSpeedLevelValue(): number | undefined {
    if (this.#childId && this.#child?.fan_speed_level !== undefined) {
      return this.#child.fan_speed_level;
    }
    return this.sysInfo.fan_speed_level;
  }

  private getFanSleepModeOnValue(): boolean | undefined {
    if (this.#childId && this.#child?.fan_sleep_mode_on !== undefined) {
      return this.#child.fan_sleep_mode_on;
    }
    return this.sysInfo.fan_sleep_mode_on;
  }

  private getOverheatedValue(): boolean | undefined {
    const overheatStatus =
      this.#childId && this.#child !== undefined
        ? this.#child.overheat_status
        : this.sysInfo.overheat_status;

    if (typeof overheatStatus === 'string') {
      return overheatStatus !== 'normal';
    }

    const overheated =
      this.#childId && this.#child !== undefined
        ? this.#child.overheated
        : this.sysInfo.overheated;

    if (typeof overheated === 'boolean') {
      return overheated;
    }
    return undefined;
  }

  private getSysInfoTypeValue(): string | undefined {
    const typeValue = 'type' in this.sysInfo ? this.sysInfo.type : undefined;
    if (typeof typeValue === 'string') return typeValue;

    const micTypeValue =
      'mic_type' in this.sysInfo ? this.sysInfo.mic_type : undefined;
    return typeof micTypeValue === 'string' ? micTypeValue : undefined;
  }

  private isSmartProtocolSwitch(): boolean {
    const typeValue = this.getSysInfoTypeValue();
    return typeof typeValue === 'string' && typeValue.startsWith('SMART.');
  }

  private isFanChild(): boolean {
    return this.#child?.category === 'kasa.switch.outlet.sub-fan';
  }

  private normalizeSmartComponentList(
    componentList: unknown,
  ): SmartComponentInfo[] {
    if (!Array.isArray(componentList)) {
      return [];
    }
    return componentList
      .map((entry) => {
        if (typeof entry === 'string') {
          return { id: entry, ver_code: 1 };
        }
        if (isObjectLike(entry) && typeof entry.id === 'string') {
          return {
            id: entry.id,
            ver_code:
              typeof entry.ver_code === 'number' && Number.isInteger(entry.ver_code)
                ? entry.ver_code
                : 1,
          };
        }
        return undefined;
      })
      .filter((entry): entry is SmartComponentInfo => entry !== undefined);
  }

  private updateNegotiationFlag(): void {
    this.#componentsNegotiated =
      this.#componentVersions.size > 0 &&
      (this.#children.size === 0 ||
        this.#childComponentVersions.size >= this.#children.size);
  }

  private setComponentVersionsFromList(componentList: unknown): void {
    const normalized = this.normalizeSmartComponentList(componentList);
    if (normalized.length === 0) {
      return;
    }

    this.#componentVersions.clear();
    normalized.forEach((component) => {
      this.#componentVersions.set(component.id, component.ver_code);
    });
    this.sysInfo.components = normalized.map((component) => component.id);
    this.updateNegotiationFlag();
  }

  private setChildComponentVersions(
    childId: string,
    componentList: unknown,
  ): void {
    const normalizedComponents = this.normalizeSmartComponentList(componentList);
    if (normalizedComponents.length === 0) {
      return;
    }

    const normalizedChildId = this.normalizeChildId(childId);
    const childMap = new Map<string, number>();
    normalizedComponents.forEach((component) => {
      childMap.set(component.id, component.ver_code);
    });
    this.#childComponentVersions.set(normalizedChildId, childMap);

    const child = this.#children.get(normalizedChildId);
    if (child !== undefined) {
      child.components = normalizedComponents.map((component) => component.id);
      this.#children.set(normalizedChildId, child);
      if (this.#childId === normalizedChildId) {
        this.#child = child;
      }
    }
    this.updateNegotiationFlag();
  }

  private setChildComponentVersionsFromChildren(
    children: Map<string, PlugChild>,
  ): void {
    children.forEach((child, childId) => {
      this.setChildComponentVersions(childId, child.components);
    });
  }

  private applySmartChildDeviceList(
    childDeviceList: unknown,
    preserveStates = false,
  ): void {
    if (!Array.isArray(childDeviceList)) {
      return;
    }

    childDeviceList.forEach((entry) => {
      if (!isObjectLike(entry) || typeof entry.device_id !== 'string') {
        return;
      }
      const normalizedChildId = this.normalizeChildId(entry.device_id);
      const child = this.#children.get(normalizedChildId) ?? {
        id: normalizedChildId,
        alias: normalizedChildId,
        state: 0,
      };

      if (typeof entry.alias === 'string') {
        child.alias = entry.alias;
      }
      if (typeof entry.category === 'string') {
        child.category = entry.category;
      }
      if (typeof entry.model === 'string') {
        child.model = entry.model;
      }
      if (typeof entry.device_on === 'boolean') {
        child.state = entry.device_on ? 1 : 0;
      }
      if (typeof entry.state === 'number') {
        child.state = entry.state;
      }
      if (typeof entry.brightness === 'number') {
        child.brightness = entry.brightness;
      }
      if (typeof entry.auto_off_status === 'string') {
        child.auto_off_status = entry.auto_off_status;
      }
      if (typeof entry.auto_off_remain_time === 'number') {
        child.auto_off_remain_time = entry.auto_off_remain_time;
      }
      if (typeof entry.fan_speed_level === 'number') {
        child.fan_speed_level = entry.fan_speed_level;
      }
      if (typeof entry.fan_sleep_mode_on === 'boolean') {
        child.fan_sleep_mode_on = entry.fan_sleep_mode_on;
      }
      if (typeof entry.overheat_status === 'string') {
        child.overheat_status = entry.overheat_status;
      }
      if (typeof entry.overheated === 'boolean') {
        child.overheated = entry.overheated;
      }

      if (preserveStates) {
        const existingChild = this.#children.get(normalizedChildId);
        if (existingChild !== undefined) {
          child.state = existingChild.state;
        }
      }

      this.#children.set(normalizedChildId, child);
    });

    if (this.#childId !== undefined) {
      this.setChildId(this.#childId);
    }
  }

  private applySmartChildComponentList(childComponentList: unknown): void {
    if (!Array.isArray(childComponentList)) {
      return;
    }

    childComponentList.forEach((entry) => {
      if (!isObjectLike(entry) || typeof entry.device_id !== 'string') {
        return;
      }
      this.setChildComponentVersions(entry.device_id, entry.component_list);
    });
  }

  /**
   * Returns SMART component version for current scope or specified child.
   */
  getComponentVersion(
    component: string,
    childId: string | undefined = this.#childId,
  ): number | undefined {
    if (childId !== undefined) {
      const normalizedChildId = this.normalizeChildId(childId);
      const childComponentMap =
        this.#childComponentVersions.get(normalizedChildId);
      if (childComponentMap !== undefined) {
        return childComponentMap.get(component);
      }

      const child = this.#children.get(normalizedChildId);
      if (
        child !== undefined &&
        Array.isArray(child.components) &&
        child.components.includes(component)
      ) {
        return 1;
      }
      return undefined;
    }

    return this.#componentVersions.get(component);
  }

  /**
   * Returns true when SMART component exists for current scope or specified child.
   */
  hasComponent(
    component: string,
    childId: string | undefined = this.#childId,
  ): boolean {
    return this.getComponentVersion(component, childId) !== undefined;
  }

  /**
   * Fetch and apply SMART `component_nego` and child component metadata.
   *
   * This mirrors python-kasa's component-driven module exposure model.
   */
  async negotiateSmartComponents(sendOptions?: SendOptions): Promise<void> {
    if (!this.isSmartProtocolSwitch()) {
      return;
    }
    if (this.#componentsNegotiated) {
      return;
    }

    const requests: { method: string }[] = [{ method: 'component_nego' }];
    if (this.#children.size > 0 || hasSysinfoChildren(this.sysInfo)) {
      requests.push({ method: 'get_child_device_list' });
      requests.push({ method: 'get_child_device_component_list' });
    }

    const responses = await this.sendSmartRequests(
      requests,
      undefined,
      sendOptions,
    );

    const componentNego = responses.component_nego;
    if (isObjectLike(componentNego)) {
      this.setComponentVersionsFromList(componentNego.component_list);
    }

    const childDeviceListResponse = responses.get_child_device_list;
    if (
      isObjectLike(childDeviceListResponse) &&
      'child_device_list' in childDeviceListResponse
    ) {
      this.applySmartChildDeviceList(childDeviceListResponse.child_device_list);
    }

    const childComponentListResponse = responses.get_child_device_component_list;
    if (
      isObjectLike(childComponentListResponse) &&
      'child_component_list' in childComponentListResponse
    ) {
      this.applySmartChildComponentList(
        childComponentListResponse.child_component_list,
      );
    }

    this.#componentsNegotiated = true;
  }

  /**
   * Cached value of `sysinfo.alias` or `sysinfo.children[childId].alias` if childId set.
   */
  override get alias(): string {
    if (this.#childId && this.#child !== undefined) {
      return this.#child.alias;
    }
    return this.sysInfo.alias;
  }

  protected setAliasProperty(alias: string): void {
    if (this.#childId && this.#child !== undefined) {
      this.#child.alias = alias;
    }
    this.sysInfo.alias = alias;
  }

  /**
   * Cached value of `sysinfo.dev_name`.
   */
  get description(): string | undefined {
    return this.sysInfo.dev_name;
  }

  // eslint-disable-next-line class-methods-use-this
  override get deviceType(): 'plug' {
    return 'plug';
  }

  /**
   * Cached value of `sysinfo.deviceId` or `childId` if set.
   */
  override get id(): string {
    if (this.#childId && this.#child !== undefined) {
      return this.#childId;
    }
    return this.sysInfo.deviceId;
  }

  /**
   * Determines if device is in use based on cached `emeter.get_realtime` results.
   *
   * If device supports energy monitoring (e.g. HS110): `power > inUseThreshold`. `inUseThreshold` is specified in Watts
   *
   * Otherwise fallback on relay state: `relay_state === 1` or `sysinfo.children[childId].state === 1`.
   *
   * Supports childId.
   */
  get inUse(): boolean {
    if (
      this.supportsEmeter &&
      'power' in this.emeter.realtime &&
      this.emeter.realtime.power !== undefined
    ) {
      return this.emeter.realtime.power > this.inUseThreshold;
    }
    return this.relayState;
  }

  /**
   * Cached value of `sysinfo.relay_state === 1` or `sysinfo.children[childId].state === 1`.
   * Supports childId.
   * If device supports childId, but childId is not set, then it will return true if any child has `state === 1`.
   * @returns On (true) or Off (false)
   */
  get relayState(): boolean {
    if (this.#childId && this.#child !== undefined) {
      return this.#child.state === 1;
    }
    if (this.#children.size > 0) {
      return (
        Array.from(this.#children.values()).findIndex((child) => {
          return child.state === 1;
        }) !== -1
      );
    }
    if (typeof this.sysInfo.device_on === 'boolean') {
      return this.sysInfo.device_on;
    }
    return this.sysInfo.relay_state === 1;
  }

  protected setRelayState(relayState: boolean): void {
    if (this.#childId && this.#child !== undefined) {
      this.#child.state = relayState ? 1 : 0;
      return;
    }
    if (this.#children.size > 0) {
      for (const child of this.#children.values()) {
        child.state = relayState ? 1 : 0;
      }
      return;
    }
    this.sysInfo.device_on = relayState;
    this.sysInfo.relay_state = relayState ? 1 : 0;
  }

  /**
   * True if cached value of `sysinfo` has `brightness` property.
   * @returns `true` if cached value of `sysinfo` has `brightness` property.
   */
  get supportsDimmer(): boolean {
    if (this.isSmartProtocolSwitch()) {
      return (
        this.getBrightnessValue() !== undefined &&
        (this.hasComponent('brightness') || this.hasComponent('dimmer_calibration'))
      );
    }
    return this.getBrightnessValue() !== undefined;
  }

  /**
   * True if current scope exposes fan control (`fan_control`).
   */
  get supportsFan(): boolean {
    if (this.isSmartProtocolSwitch()) {
      return (
        this.hasComponent('fan_control') &&
        this.getFanSpeedLevelValue() !== undefined
      );
    }

    if (this.#childId && this.#child !== undefined) {
      return (
        this.#child.category === 'kasa.switch.outlet.sub-fan' ||
        this.#child.fan_speed_level !== undefined
      );
    }

    return (
      this.isFanChild() ||
      this.getFanSpeedLevelValue() !== undefined ||
      this.hasComponent('fan_control')
    );
  }

  /**
   * True if current scope exposes SMART preset rules (`preset`).
   */
  get supportsLightPreset(): boolean {
    if (this.isSmartProtocolSwitch()) {
      return this.hasComponent('preset') && this.getBrightnessValue() !== undefined;
    }
    return this.supportsDimmer;
  }

  /**
   * True if current scope exposes gradual on/off transitions (`on_off_gradually`).
   */
  get supportsLightTransition(): boolean {
    if (this.isSmartProtocolSwitch()) {
      return (
        this.hasComponent('on_off_gradually') &&
        this.getBrightnessValue() !== undefined
      );
    }
    return this.supportsDimmer;
  }

  /**
   * True if current scope exposes SMART LED control (`led`).
   */
  get supportsSmartLed(): boolean {
    if (this.isSmartProtocolSwitch()) {
      return this.hasComponent('led');
    }
    return false;
  }

  /**
   * True if current scope exposes overheat protection status.
   */
  get supportsOverheatProtection(): boolean {
    if (this.isSmartProtocolSwitch()) {
      return (
        this.hasComponent('overheat_protection') ||
        this.getOverheatedValue() !== undefined
      );
    }
    return this.getOverheatedValue() !== undefined;
  }

  /**
   * Cached fan speed level from sysInfo / current child.
   */
  get fanSpeedLevel(): number | undefined {
    return this.getFanSpeedLevelValue();
  }

  /**
   * Cached fan sleep mode from sysInfo / current child.
   */
  get fanSleepModeOn(): boolean | undefined {
    return this.getFanSleepModeOnValue();
  }

  /**
   * Cached overheat status from sysInfo / current child.
   */
  get overheated(): boolean | undefined {
    return this.getOverheatedValue();
  }

  /**
   * True if cached value of `sysinfo` has `feature` property that contains 'ENE'.
   * @returns `true` if cached value of `sysinfo` has `feature` property that contains 'ENE'
   */
  get supportsEmeter(): boolean {
    return this.sysInfo.feature !== undefined && typeof this.sysInfo.feature === 'string'
      ? this.sysInfo.feature.includes('ENE')
      : false;
  }

  shouldUseSmartMethods(sendOptions?: SendOptions): boolean {
    if (!this.isSmartProtocolSwitch()) {
      return false;
    }
    const transport = sendOptions?.transport ?? this.defaultSendOptions.transport;
    return transport === 'klap' || transport === 'aes';
  }

  /**
   * @internal
   */
  applySmartDeviceInfoPartial(
    partial: Record<string, unknown>,
    childId: string | undefined = this.#childId,
  ): void {
    const normalizedChildId =
      childId !== undefined ? this.normalizeChildId(childId) : undefined;
    const child =
      normalizedChildId !== undefined
        ? this.#children.get(normalizedChildId)
        : undefined;

    if (child !== undefined) {
      if (typeof partial.device_on === 'boolean') {
        child.state = partial.device_on ? 1 : 0;
      }
      if (typeof partial.brightness === 'number') {
        child.brightness = partial.brightness;
      }
      if (typeof partial.auto_off_status === 'string') {
        child.auto_off_status = partial.auto_off_status;
      }
      if (typeof partial.auto_off_remain_time === 'number') {
        child.auto_off_remain_time = partial.auto_off_remain_time;
      }
      if (typeof partial.fan_speed_level === 'number') {
        child.fan_speed_level = partial.fan_speed_level;
      }
      if (typeof partial.fan_sleep_mode_on === 'boolean') {
        child.fan_sleep_mode_on = partial.fan_sleep_mode_on;
      }
      if (typeof partial.overheat_status === 'string') {
        child.overheat_status = partial.overheat_status;
      }
      if (typeof partial.overheated === 'boolean') {
        child.overheated = partial.overheated;
      }
      this.#child = child;
    } else {
      if (typeof partial.device_on === 'boolean') {
        this.sysInfo.device_on = partial.device_on;
        this.sysInfo.relay_state = partial.device_on ? 1 : 0;
      }
      if (typeof partial.brightness === 'number') {
        this.sysInfo.brightness = partial.brightness;
      }
      if (typeof partial.auto_off_status === 'string') {
        this.sysInfo.auto_off_status = partial.auto_off_status;
      }
      if (typeof partial.auto_off_remain_time === 'number') {
        this.sysInfo.auto_off_remain_time = partial.auto_off_remain_time;
      }
      if (typeof partial.fan_speed_level === 'number') {
        this.sysInfo.fan_speed_level = partial.fan_speed_level;
      }
      if (typeof partial.fan_sleep_mode_on === 'boolean') {
        this.sysInfo.fan_sleep_mode_on = partial.fan_sleep_mode_on;
      }
      if (typeof partial.overheat_status === 'string') {
        this.sysInfo.overheat_status = partial.overheat_status;
      }
      if (typeof partial.overheated === 'boolean') {
        this.sysInfo.overheated = partial.overheated;
      }
    }

    const brightness = this.getBrightnessValue();
    if (brightness !== undefined) {
      this.dimmer.setBrightnessValue(brightness);
      return;
    }

    this.emitEvents();
  }

  /**
   * Gets plug's SysInfo.
   *
   * Requests `system.sysinfo` from device. Does not support childId.

   */
  override async getSysInfo(sendOptions?: SendOptions): Promise<PlugSysinfo> {
    if (this.shouldUseSmartMethods(sendOptions)) {
      if (!this.#componentsNegotiated) {
        try {
          await this.negotiateSmartComponents(sendOptions);
        } catch (err) {
          this.log.debug(
            '[%s] smart component negotiation failed: %s',
            this.alias,
            err,
          );
        }
      }
      const response = await this.sendSmartCommand(
        'get_device_info',
        undefined,
        this.#childId,
        sendOptions,
      );
      if (!isObjectLike(response)) {
        throw new Error(`Unexpected SMART response: ${JSON.stringify(response)}`);
      }
      this.applySmartDeviceInfoPartial(
        response as Record<string, unknown>,
        this.#childId,
      );
      return this.sysInfo;
    }

    const response = await super.getSysInfo(sendOptions);

    if (!isPlugSysinfo(response)) {
      throw new Error(`Unexpected Response: ${JSON.stringify(response)}`);
    }
    return this.sysInfo;
  }

  /**
   * Requests common Plug status details in a single request.
   * - `system.get_sysinfo`
   * - `cloud.get_sysinfo`
   * - `emeter.get_realtime`
   * - `schedule.get_next_action`
   *
   * This command is likely to fail on some devices when using UDP transport.
   * This defaults to TCP transport unless overridden in sendOptions.
   *
   * Supports childId.
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async getInfo(sendOptions?: SendOptions): Promise<{
    sysInfo: Record<string, unknown>;
    cloud: { info: Record<string, unknown> };
    emeter: { realtime: Record<string, unknown> };
    schedule: { nextAction: Record<string, unknown> };
  }> {
    // force TCP unless overridden here
    const sendOptionsForGetInfo: SendOptions =
      sendOptions == null ? {} : sendOptions;
    if (!('transport' in sendOptionsForGetInfo))
      sendOptionsForGetInfo.transport = 'tcp';

    let data: unknown;
    try {
      data = await this.sendCommand(
        '{"emeter":{"get_realtime":{}},"schedule":{"get_next_action":{}},"system":{"get_sysinfo":{}},"cnCloud":{"get_info":{}}}',
        this.#childId,
        sendOptionsForGetInfo,
      );
    } catch (err) {
      // Ignore emeter section errors as not all devices support it
      if (
        err instanceof ResponseError &&
        err.modules.length === 1 &&
        err.modules[0] === 'emeter'
      ) {
        data = JSON.parse(err.response);
      } else {
        throw err;
      }
    }

    const sysinfo = extractResponse<PlugSysinfo>(
      data,
      'system.get_sysinfo',
      isPlugSysinfo,
    );
    this.setSysInfo(sysinfo);

    const cloudInfo = extractResponse<CloudInfo & HasErrCode>(
      data,
      'cnCloud.get_info',
      (c) => isCloudInfo(c) && hasErrCode(c),
    );
    this.cloud.info = cloudInfo;

    if (
      isObjectLike(data) &&
      'emeter' in data &&
      isObjectLike(data.emeter) &&
      'get_realtime' in data.emeter &&
      isObjectLike(data.emeter.get_realtime)
    ) {
      this.emeter.setRealtime(data.emeter.get_realtime);
    }

    const scheduleNextAction = extractResponse<HasErrCode>(
      data,
      'schedule.get_next_action',
      hasErrCode,
    );
    this.schedule.nextAction = scheduleNextAction;

    return {
      sysInfo: this.sysInfo,
      cloud: { info: this.cloud.info },
      emeter: { realtime: this.emeter.realtime },
      schedule: { nextAction: this.schedule.nextAction },
    };
  }

  /**
   * Same as {@link Plug#inUse}, but requests current `emeter.get_realtime`. Supports childId.
   * @returns parsed JSON response
   * @throws {@link ResponseError}
   */
  async getInUse(sendOptions?: SendOptions): Promise<boolean> {
    if (this.supportsEmeter) {
      await this.emeter.getRealtime(sendOptions);
    } else {
      await this.getSysInfo(sendOptions);
    }
    return this.inUse;
  }

  /**
   * Get Plug LED state (night mode).
   *
   * Requests `system.sysinfo` and returns true if `led_off === 0`. Does not support childId.
   * @param  {SendOptions} [sendOptions]
   * @returns LED State, true === on
   * @throws {@link ResponseError}
   */
  async getLedState(sendOptions?: SendOptions): Promise<boolean> {
    if (this.shouldUseSmartMethods(sendOptions)) {
      return this.smartLed.getLedState(sendOptions);
    }
    const sysInfo = await this.getSysInfo(sendOptions);
    return sysInfo.led_off === undefined || sysInfo.led_off === 0;
  }

  /**
   * Turn Plug LED on/off (night mode). Does not support childId.
   *
   * Sends `system.set_led_off` command.
   * @param   value - LED State, true === on
   * @throws {@link ResponseError}
   */
  async setLedState(value: boolean, sendOptions?: SendOptions): Promise<true> {
    if (this.shouldUseSmartMethods(sendOptions)) {
      return this.smartLed.setLedState(value, sendOptions);
    }

    await this.sendCommand(
      `{"system":{"set_led_off":{"off":${value ? 0 : 1}}}}`,
      undefined,
      sendOptions,
    );
    this.sysInfo.led_off = value ? 0 : 1;
    return true;
  }

  /**
   * Get Plug relay state (on/off).
   *
   * Requests `system.get_sysinfo` and returns true if On. Calls {@link Plug#relayState}. Supports childId.
   * @throws {@link ResponseError}
   */
  async getPowerState(sendOptions?: SendOptions): Promise<boolean> {
    await this.getSysInfo(sendOptions);
    return this.relayState;
  }

  /**
   * Turns Plug relay on/off.
   *
   * Sends `system.set_relay_state` command. Supports childId.
   * @throws {@link ResponseError}
   */
  async setPowerState(
    value: boolean,
    sendOptions?: SendOptions,
  ): Promise<true> {
    if (this.shouldUseSmartMethods(sendOptions)) {
      await this.sendSmartCommand(
        'set_device_info',
        { device_on: value },
        this.#childId,
        sendOptions,
      );
      this.applySmartDeviceInfoPartial({ device_on: value }, this.#childId);
      return true;
    }

    await this.sendCommand(
      `{"system":{"set_relay_state":{"state":${value ? 1 : 0}}}}`,
      this.#childId,
      sendOptions,
    );
    this.setRelayState(value);
    this.emitEvents();
    return true;
  }

  /**
   * Toggles Plug relay state.
   *
   * Requests `system.get_sysinfo` sets the power state to the opposite `relay_state === 1 and returns the new power state`. Supports childId.
   * @throws {@link ResponseError}
   */
  async togglePowerState(sendOptions?: SendOptions): Promise<boolean> {
    const powerState = await this.getPowerState(sendOptions);
    await this.setPowerState(!powerState, sendOptions);
    return !powerState;
  }

  /**
   * Blink Plug LED.
   *
   * Sends `system.set_led_off` command alternating on and off number of `times` at `rate`,
   * then sets the led to its pre-blink state. Does not support childId.
   *
   * Note: `system.set_led_off` is particularly slow, so blink rate is not guaranteed.
   * @throws {@link ResponseError}
   */
  async blink(
    times = 5,
    rate = 1000,
    sendOptions?: SendOptions,
  ): Promise<boolean> {
    const delay = (t: number): Promise<void> => {
      return new Promise((resolve) => {
        setTimeout(resolve, t);
      });
    };

    const origLedState = await this.getLedState(sendOptions);
    let lastBlink: number;

    let currLedState = false;
    for (let i = 0; i < times * 2; i += 1) {
      currLedState = !currLedState;
      lastBlink = Date.now();
      // eslint-disable-next-line no-await-in-loop
      await this.setLedState(currLedState, sendOptions);
      const timeToWait = rate / 2 - (Date.now() - lastBlink);
      if (timeToWait > 0) {
        // eslint-disable-next-line no-await-in-loop
        await delay(timeToWait);
      }
    }
    if (currLedState !== origLedState) {
      await this.setLedState(origLedState, sendOptions);
    }
    return true;
  }

  private emitEvents(): void {
    if (!this.emitEventsEnabled) {
      return;
    }

    const { inUse, relayState } = this;

    this.log.debug(
      '[%s] plug.emitEvents() inUse: %s relayState: %s lastState: %j',
      this.alias,
      inUse,
      relayState,
      this.lastState,
    );
    if (this.lastState.inUse !== inUse) {
      this.lastState.inUse = inUse;
      if (inUse) {
        this.emit('in-use');
      } else {
        this.emit('not-in-use');
      }
    }
    this.emit('in-use-update', inUse);

    if (this.lastState.relayState !== relayState) {
      this.lastState.relayState = relayState;
      if (relayState) {
        this.emit('power-on');
      } else {
        this.emit('power-off');
      }
    }
    this.emit('power-update', relayState);

    if (this.supportsDimmer) {
      this.dimmer.emitEvents();
    }
  }
}

export default Plug;
