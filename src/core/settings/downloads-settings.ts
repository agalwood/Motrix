import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { AppError } from '@shared/errors'
import {
  type DownloadsSettingsResult,
  saveDownloadsSettingsRequestSchema,
} from '@shared/schemas/downloads-settings'
import { GetGeneralSettingsDraftRequestSchema } from '@shared/schemas/general-settings'
import type { SettingsUpdateResult } from '@shared/schemas/settings-update'
import type { EngineSettings } from '@shared/types/settings'
import {
  directoryPreferenceFailure,
  resolveDesktopDirectory,
} from './directory-preferences'
import type { SettingsManager } from './settings-manager'

export function createGetDownloadsSettingsDraftHandler(
  settings: SettingsManager
) {
  return async (raw: unknown): Promise<DownloadsSettingsResult> => {
    if (!GetGeneralSettingsDraftRequestSchema.safeParse(raw).success)
      return { ok: false, error: { code: 'invalidPath' } }
    return { ok: true, value: settings.getDownloadsSettingsSnapshot() }
  }
}

export function createSaveDownloadsSettingsHandler(
  settings: SettingsManager,
  options: {
    resolveFavorite?: (path: string) => Promise<string>
    resolveDefaultDirectory?: (path: string) => Promise<string>
    apply?: (
      oldEngine: EngineSettings,
      update: SettingsUpdateResult
    ) => Promise<void>
  } = {}
) {
  let tail: Promise<void> = Promise.resolve()
  return async (raw: unknown): Promise<DownloadsSettingsResult> => {
    const parsed = saveDownloadsSettingsRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: { code: 'invalidPath' } }
    try {
      const request = parsed.data
      for (const path of request.directories.addFavorites) {
        const resolved = await (
          options.resolveFavorite ?? resolveDesktopDirectory
        )(path)
        if (resolved !== path)
          throw Object.assign(new Error('Noncanonical favorite'), {
            code: 'EINVAL',
          })
      }
      if (request.settings.app?.defaultSaveDir !== undefined) {
        const resolve =
          options.resolveDefaultDirectory ??
          (async (path: string) => {
            const canonical = await resolveDesktopDirectory(path)
            await access(canonical, constants.W_OK | constants.X_OK)
            return canonical
          })
        request.settings.app.defaultSaveDir = await resolve(
          request.settings.app.defaultSaveDir
        )
      }
      const oldEngine = structuredClone(settings.getEngine())
      const result = await settings.saveDownloadsSettings(request)
      if (!result.ok || !result.update) return result
      const update = result.update
      const apply = tail.then(() => options.apply?.(oldEngine, update))
      tail = apply.then(
        () => undefined,
        () => undefined
      )
      try {
        await apply
      } catch {
        update.applicationFailed = true
      }
      return result
    } catch (error) {
      return directoryPreferenceFailure(
        error instanceof AppError && error.cause ? error.cause : error
      )
    }
  }
}
