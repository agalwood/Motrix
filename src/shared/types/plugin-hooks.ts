import type {
  AfterCompleteContextV1,
  BeforeCreateBtContextV1,
  BeforeCreateHttpContextV1,
  BeforeFinalizeContextV1,
  DeliveryEnvelopeV1,
  ErrorDescriptorV1,
  HookEffectsV1,
  HookInvocationScopeV1,
  HookJsonValue,
  HookMetadataOperation,
  HookMetadataSnapshot,
  OnErrorContextV1,
  PluginTaskSnapshotV1,
} from '../schemas/plugin-hooks'

export type CtxJsonValue = HookJsonValue
export type PluginHookTask = PluginTaskSnapshotV1
export type PluginHookError = ErrorDescriptorV1
export type PluginHookDelivery = DeliveryEnvelopeV1
export type PluginHookInvocationScope = HookInvocationScopeV1
export type PluginHookEffects = HookEffectsV1
export type PluginHookMetadataOperation = HookMetadataOperation
export type PluginHookMetadataSnapshot = HookMetadataSnapshot

export type BeforeCreateHttpContextDTO = BeforeCreateHttpContextV1
export type BeforeCreateBtContextDTO = BeforeCreateBtContextV1
export type BeforeFinalizeContextDTO = BeforeFinalizeContextV1
export type AfterCompleteContextDTO = AfterCompleteContextV1
export type OnErrorContextDTO = OnErrorContextV1
