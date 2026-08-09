import type {
  AfterCompleteContextDTO,
  BeforeCreateBtContextDTO,
  BeforeCreateHttpContextDTO,
  BeforeFinalizeContextDTO,
  CtxJsonValue,
  OnErrorContextDTO,
} from '@shared/types/plugin-hooks'

export interface PluginMetadata {
  get<T extends CtxJsonValue>(key: string): T | undefined
  has(key: string): boolean
  getAll(): Record<string, CtxJsonValue>
  keys(): ReadonlyArray<string>
  set(key: string, value: CtxJsonValue): void
  delete(key: string): void
}

export type ReadonlyPluginMetadata = Omit<PluginMetadata, 'set' | 'delete'>

export interface HookCtxRuntime<TDto> {
  readonly dto: TDto
  readonly signal: AbortSignal
  readonly metadata: PluginMetadata | ReadonlyPluginMetadata
  /** writes a staged patch; host commits on chain success */
  update?(patch: Record<string, unknown>): void
}

export type BeforeCreateHttpCtx = HookCtxRuntime<BeforeCreateHttpContextDTO> & {
  update(
    patch: Partial<{
      uris: string[]
      filename: string
      connections: number
      headers: Array<{ name: string; value: string }>
      proxy: string
    }>
  ): void
}

export type BeforeCreateBtCtx = HookCtxRuntime<BeforeCreateBtContextDTO>

export type BeforeFinalizeCtx = HookCtxRuntime<BeforeFinalizeContextDTO> & {
  update(patch: Partial<{ filePath: string }>): void
}

export type AfterCompleteCtx = HookCtxRuntime<AfterCompleteContextDTO>

export type OnErrorCtx = HookCtxRuntime<OnErrorContextDTO>

export function makeBeforeCreateHttp(
  dto: BeforeCreateHttpContextDTO,
  metadata: PluginMetadata | ReadonlyPluginMetadata,
  signal: AbortSignal,
  staged: { update: (patch: Record<string, unknown>) => void }
): BeforeCreateHttpCtx {
  return { dto, metadata, signal, update: staged.update }
}

export function makeBeforeCreateBt(
  dto: BeforeCreateBtContextDTO,
  metadata: PluginMetadata | ReadonlyPluginMetadata,
  signal: AbortSignal
): BeforeCreateBtCtx {
  return { dto, metadata, signal }
}

export function makeBeforeFinalize(
  dto: BeforeFinalizeContextDTO,
  metadata: PluginMetadata | ReadonlyPluginMetadata,
  signal: AbortSignal,
  staged: { update: (patch: Record<string, unknown>) => void }
): BeforeFinalizeCtx {
  return { dto, metadata, signal, update: staged.update }
}

export function makeAfterComplete(
  dto: AfterCompleteContextDTO,
  metadata: ReadonlyPluginMetadata,
  signal: AbortSignal
): AfterCompleteCtx {
  return { dto, metadata, signal }
}

export function makeOnError(
  dto: OnErrorContextDTO,
  metadata: ReadonlyPluginMetadata,
  signal: AbortSignal
): OnErrorCtx {
  return { dto, metadata, signal }
}
