import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { AppError } from '@shared/errors'
import {
  type GeneralSettingsResult,
  GeneralSettingsResultSchema,
  type GeneralSettingsSnapshot,
  GetGeneralSettingsDraftRequestSchema,
  type SaveGeneralSettingsRequest,
  SaveGeneralSettingsRequestSchema,
} from '@shared/schemas/general-settings'
import {
  directoryPreferenceFailure,
  resolveDesktopDirectory,
} from './directory-preferences'
import type { SettingsManager } from './settings-manager'

interface GeneralSettingsOptions {
  resolveFavorite?: (path: string) => Promise<string>
  resolveDefaultDirectory?: (path: string) => Promise<string>
  applySavedApp?: (
    patch: SaveGeneralSettingsRequest['app']
  ) => Promise<void> | void
}

async function resolveDesktopDefaultDirectory(path: string): Promise<string> {
  const canonical = await resolveDesktopDirectory(path)
  await access(canonical, constants.W_OK | constants.X_OK)
  return canonical
}

export function createGetGeneralSettingsDraftHandler(
  settings: SettingsManager
) {
  return async (raw: unknown): Promise<GeneralSettingsResult> => {
    if (!GetGeneralSettingsDraftRequestSchema.safeParse(raw).success)
      return { ok: false, error: { code: 'invalidPath' } }
    return { ok: true, value: settings.getGeneralSettingsSnapshot() }
  }
}

/** Validate all new destinations before one queue-owned settings transaction. */
export function createSaveGeneralSettingsHandler(
  settings: SettingsManager,
  options: GeneralSettingsOptions = {}
) {
  let sideEffectTail: Promise<void> = Promise.resolve()
  return async (raw: unknown): Promise<GeneralSettingsResult> => {
    const parsed = SaveGeneralSettingsRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: { code: 'invalidPath' } }
    let committed: GeneralSettingsSnapshot | undefined
    try {
      const request = parsed.data
      const resolveFavorite = options.resolveFavorite ?? resolveDesktopDirectory
      request.directories.addFavorites = await Promise.all(
        request.directories.addFavorites.map(async (path) => {
          const resolved = await resolveFavorite(path)
          // Draft deltas use exact keys. Changing a key during an uncertain
          // write would make its later removal indistinguishable from a remote add.
          if (resolved !== path)
            throw Object.assign(new Error('Noncanonical favorite'), {
              code: 'EINVAL',
            })
          return path
        })
      )
      if (request.app.defaultSaveDir !== undefined) {
        request.app.defaultSaveDir = await (
          options.resolveDefaultDirectory ?? resolveDesktopDefaultDirectory
        )(request.app.defaultSaveDir)
      }
      const result = await settings.saveGeneralSettings(request)
      if (!result.ok) return result
      committed = result.value
      // Runtime effects follow the durable commit. Reapplying submitted fields
      // on retries also repairs a prior effect failure after a successful save.
      const apply = sideEffectTail.then(() =>
        options.applySavedApp?.(request.app)
      )
      sideEffectTail = apply.then(
        () => undefined,
        () => undefined
      )
      await apply
      return GeneralSettingsResultSchema.parse(result)
    } catch (error) {
      const failure = directoryPreferenceFailure(
        error instanceof AppError && error.cause ? error.cause : error
      )
      return { ...failure, ...(committed ? { snapshot: committed } : {}) }
    }
  }
}
