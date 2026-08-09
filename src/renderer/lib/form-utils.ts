import {
  APP_RESTART_REQUIRED_KEYS,
  ENGINE_RESTART_REQUIRED_KEYS,
} from '@shared/constants/restart-keys'
import type {
  AppSettings,
  EngineSettings,
  MotrixAppSettings,
} from '@shared/types/settings'

type DirtyTree = boolean | { [key: string]: DirtyTree | undefined }

export function pickDirty<T>(
  values: T,
  dirty: DirtyTree | undefined
): Partial<T> | undefined {
  if (!dirty) return undefined
  if (dirty === true) return values as Partial<T>
  if (typeof dirty !== 'object' || values == null) return undefined

  const out: Record<string, unknown> = {}
  let hasAny = false
  for (const key of Object.keys(dirty)) {
    const child = pickDirty(
      (values as Record<string, unknown>)[key],
      (dirty as Record<string, DirtyTree>)[key]
    )
    if (child !== undefined) {
      out[key] = child
      hasAny = true
    }
  }
  return hasAny ? (out as Partial<T>) : undefined
}

export function patchHasRestartKeys(patch: Partial<AppSettings>): boolean {
  const enginePatch = patch.engine
  if (
    enginePatch &&
    Object.keys(enginePatch).some((k) =>
      ENGINE_RESTART_REQUIRED_KEYS.has(k as keyof EngineSettings)
    )
  ) {
    return true
  }
  const appPatch = patch.app
  if (
    appPatch &&
    Object.keys(appPatch).some((k) =>
      APP_RESTART_REQUIRED_KEYS.has(k as keyof MotrixAppSettings)
    )
  ) {
    return true
  }
  return false
}
