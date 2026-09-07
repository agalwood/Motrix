import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { AppError } from '@shared/errors'
import {
  type DirectoryPreferencesResult,
  DirectoryPreferencesResultSchema,
} from '@shared/schemas/directory-preferences'
import {
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

/** Validate all new destinations before one queue-owned settings transaction. */
export function createSaveGeneralSettingsHandler(
  settings: SettingsManager,
  options: GeneralSettingsOptions = {}
) {
  let sideEffectTail: Promise<void> = Promise.resolve()
  return async (raw: unknown): Promise<DirectoryPreferencesResult> => {
    const parsed = SaveGeneralSettingsRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: { code: 'invalidPath' } }
    try {
      const request = parsed.data
      const resolveFavorite = options.resolveFavorite ?? resolveDesktopDirectory
      request.directories.addFavorites = await Promise.all(
        request.directories.addFavorites.map((path) => resolveFavorite(path))
      )
      if (request.app.defaultSaveDir !== undefined) {
        request.app.defaultSaveDir = await (
          options.resolveDefaultDirectory ?? resolveDesktopDefaultDirectory
        )(request.app.defaultSaveDir)
      }
      const result = await settings.saveGeneralSettings(request)
      if (!result.ok) return result
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
      return DirectoryPreferencesResultSchema.parse(result)
    } catch (error) {
      return directoryPreferenceFailure(
        error instanceof AppError && error.cause ? error.cause : error
      )
    }
  }
}
