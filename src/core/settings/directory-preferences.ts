import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  type DirectoryPreferencesErrorCode,
  DirectoryPreferencesErrorCodeSchema,
  type DirectoryPreferencesResult,
  DirectoryPreferencesResultSchema,
  GetDirectoryPreferencesRequestSchema,
  MutateDirectoryPreferencesRequestSchema,
} from '@shared/schemas/directory-preferences'
import type { SettingsManager } from './settings-manager'

export function directoryPreferenceFailure(
  error: unknown
): Extract<DirectoryPreferencesResult, { ok: false }> {
  const directoryCode = DirectoryPreferencesErrorCodeSchema.safeParse(
    (error as { directoryCode?: unknown } | null)?.directoryCode
  )
  let code: DirectoryPreferencesErrorCode = 'unavailable'
  if (directoryCode.success) code = directoryCode.data
  else {
    switch ((error as NodeJS.ErrnoException | null)?.code) {
      case 'ENOENT':
        code = 'notFound'
        break
      case 'ENOTDIR':
        code = 'notDirectory'
        break
      case 'EPERM':
      case 'EACCES':
      case 'EROFS':
        code = 'permissionDenied'
        break
      case 'ENAMETOOLONG':
        code = 'tooLarge'
        break
      case 'EINVAL':
        code = 'invalidPath'
        break
    }
  }
  return { ok: false, error: { code } }
}

export async function resolveDesktopDirectory(value: string): Promise<string> {
  if (!path.isAbsolute(value) || value.includes('\0')) {
    throw Object.assign(new Error('Invalid directory'), { code: 'EINVAL' })
  }
  const canonical = await realpath(value)
  if (!(await stat(canonical)).isDirectory()) {
    throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' })
  }
  await access(canonical, constants.R_OK | constants.X_OK)
  return canonical
}

/** Both shells validate their own path boundary before the serialized action. */
export function createDirectoryPreferencesHandlers(
  settingsManager: SettingsManager,
  resolveDirectory: (value: string) => Promise<string> = resolveDesktopDirectory
) {
  return {
    get: async (raw: unknown): Promise<DirectoryPreferencesResult> => {
      if (!GetDirectoryPreferencesRequestSchema.safeParse(raw).success) {
        return { ok: false, error: { code: 'invalidPath' } }
      }
      try {
        return DirectoryPreferencesResultSchema.parse({
          ok: true,
          value: settingsManager.getApp().directoryPreferences,
        })
      } catch {
        return { ok: false, error: { code: 'unavailable' } }
      }
    },
    mutate: async (raw: unknown): Promise<DirectoryPreferencesResult> => {
      const parsed = MutateDirectoryPreferencesRequestSchema.safeParse(raw)
      if (!parsed.success) return { ok: false, error: { code: 'invalidPath' } }
      try {
        const action = parsed.data
        if (
          action.action === 'addFavorite' ||
          action.action === 'recordRecent'
        ) {
          action.path = await resolveDirectory(action.path)
        }
        return DirectoryPreferencesResultSchema.parse(
          await settingsManager.mutateDirectoryPreferences(action)
        )
      } catch (error) {
        return directoryPreferenceFailure(error)
      }
    },
  }
}
