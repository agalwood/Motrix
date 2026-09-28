import {
  requestDirectoryDraft,
  useRevisionedDirectoryDraft,
} from '@renderer/features/directory-preferences/use-directory-preferences-draft'
import { pickDirty } from '@renderer/lib/form-utils'
import { notifySettingsSaved } from '@renderer/lib/settings-save'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  downloadsSettingsResultSchema,
  downloadsSettingsSchema,
} from '@shared/schemas/downloads-settings'
import type { FieldPath, UseFormReturn } from 'react-hook-form'
import type { DownloadsFields } from './downloads-form'

// Leaf paths preserve exact user intent during conflict rebases. Arrays (days,
// process names, providers) are replaced as a whole, just like settings patches.
function flatten(value: object, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object' && !Array.isArray(child))
      Object.assign(result, flatten(child, path))
    else result[path] = child
  }
  return result
}
function expand(values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(values)) {
    const keys = path.split('.')
    let target = result
    for (const key of keys.slice(0, -1)) {
      target[key] ??= {}
      target = target[key] as Record<string, unknown>
    }
    target[keys[keys.length - 1]] = value
  }
  return result
}

export function useDownloadsSettingsDraft(
  form: UseFormReturn<DownloadsFields>
) {
  return useRevisionedDirectoryDraft<Record<string, unknown>>({
    getAppDraft: () => ({
      values: flatten(form.getValues()),
      dirty: flatten(
        pickDirty(form.getValues(), form.formState.dirtyFields) ?? {}
      ),
    }),
    onAppRebase: (baseline, intent) => {
      form.reset(downloadsSettingsSchema.parse(expand(baseline)))
      for (const [path, value] of Object.entries(intent))
        form.setValue(path as FieldPath<DownloadsFields>, value as never, {
          shouldDirty: true,
        })
    },
    request: async (channel, args) => {
      const result = await requestDirectoryDraft(
        channel === 'load'
          ? Queries.GetDownloadsSettingsDraft
          : Commands.SaveDownloadsSettings,
        channel === 'load'
          ? {}
          : {
              expectedRevision: args.expectedRevision,
              settings: expand(args.app ?? {}),
              directories: args.directories,
            },
        downloadsSettingsResultSchema
      )
      const adapt = (snapshot: {
        revision: string
        settings: DownloadsFields
        directoryPreferences: { favorites: string[]; recent: string[] }
      }) => ({ ...snapshot, app: flatten(snapshot.settings) })
      return result.ok
        ? { ...result, value: adapt(result.value) }
        : {
            ...result,
            snapshot: result.snapshot ? adapt(result.snapshot) : undefined,
          }
    },
    onSaved: notifySettingsSaved,
  })
}
