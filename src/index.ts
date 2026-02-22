export {
  default as Bulb,
  type BulbConstructorOptions,
  type BulbEvents,
  type BulbSysinfo,
  type BulbSysinfoLightState,
} from './bulb';
export type {
  LightState,
  LightStateInput,
  default as Lighting,
} from './bulb/lighting';
export type {
  default as BulbSchedule,
  BulbScheduleRule,
  BulbScheduleRuleInput,
} from './bulb/schedule';

export {
  default as Client,
  type AnyDevice,
  type AnyDeviceDiscovery,
  type AnyDeviceOptionsConstructable,
  type ClientConstructorOptions,
  type ClientEvents,
  type DeviceDiscovery,
  type DeviceOptionsDiscovery,
  type DiscoveryDevice,
  type DiscoveryOptions,
  type SendOptions,
  type SmartMethodRequest,
  type SmartRequestPayload,
} from './client';

export {
  default as Device,
  type ApiModuleNamespace,
  type CommonSysinfo,
  type DeviceConstructorOptions,
  type DeviceEvents,
  type SmartMethodResponseMap,
  type Sysinfo,
} from './device';
export type { default as Netif } from './device/netif';

export {
  default as Plug,
  type PlugChild,
  type PlugConstructorOptions,
  type PlugEvents,
  type PlugSysinfo,
  type SmartComponentInfo,
  type SysinfoChildren,
} from './plug';
export type { default as Away, AwayRule, AwayRuleInput } from './plug/away';
export type {
  default as Dimmer,
  DimmerActionInput,
  DimmerTransitionInput,
} from './plug/dimmer';
export type { default as Fan } from './plug/fan';
export type {
  default as LightPreset,
  SmartPresetRules,
} from './plug/light-preset';
export type {
  default as LightTransition,
  LightTransitionInfo,
} from './plug/light-transition';
export type { default as OverheatProtection } from './plug/overheat-protection';
export type {
  default as PlugSchedule,
  PlugScheduleRule,
  PlugScheduleRuleInput,
} from './plug/schedule';
export type { default as SmartLed, SmartLedInfo } from './plug/smart-led';
export type { default as Timer, TimerRuleInput } from './plug/timer';

export type { default as Cloud, CloudInfo } from './shared/cloud';
export type {
  default as Emeter,
  Realtime,
  RealtimeNormalized,
  RealtimeV1,
  RealtimeV2,
} from './shared/emeter';
export type {
  HasRuleListWithRuleIds,
  ScheduleDateStart,
  ScheduleNextAction,
  ScheduleNextActionResponse,
  ScheduleRule,
  ScheduleRuleInputTime,
  ScheduleRuleResponse,
  ScheduleRuleWithId,
  ScheduleRules,
  ScheduleRulesResponse,
  WDay,
} from './shared/schedule';
export type { default as Time } from './shared/time';

export type { LogLevelMethodNames, Logger } from './logger';
export type { CredentialOptions, Credentials } from './credentials';

export { default as SmartError } from './smart-error';
export { ResponseError, type HasErrCode } from './utils';
