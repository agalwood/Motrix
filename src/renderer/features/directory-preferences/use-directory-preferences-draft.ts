import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { DirectoryPreferences } from '@shared/schemas/directory-preferences'
import {
  type GeneralSettingsApp,
  type GeneralSettingsErrorCode,
  GeneralSettingsResultSchema,
  type GeneralSettingsSnapshot,
  type SaveGeneralSettingsRequest,
} from '@shared/schemas/general-settings'
import { useCallback, useEffect, useRef, useState } from 'react'

export const DIRECTORY_DRAFT_TIMEOUT = 20_000
export const GENERAL_SETTINGS_SAVE_ATTEMPTS = 3

type AppPatch = SaveGeneralSettingsRequest['app']
type AppKey = keyof GeneralSettingsApp
interface AppDraft {
  values: GeneralSettingsApp
  dirty: AppPatch
}
interface Options {
  getAppDraft?: () => AppDraft
  onAppRebase?: (baseline: GeneralSettingsApp, intent: AppPatch) => void
}

export function directoryPreferenceEdits(
  baseline: DirectoryPreferences,
  draft: DirectoryPreferences
): SaveGeneralSettingsRequest['directories'] {
  return {
    addFavorites: draft.favorites.filter(
      (path) => !baseline.favorites.includes(path)
    ),
    removeFavorites: baseline.favorites.filter(
      (path) => !draft.favorites.includes(path)
    ),
    removeRecent: baseline.recent.filter(
      (path) => !draft.recent.includes(path)
    ),
  }
}

async function request(
  channel:
    | typeof Queries.GetGeneralSettingsDraft
    | typeof Commands.SaveGeneralSettings,
  args: unknown
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => transport.invoke(channel, args)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('General settings request timed out')),
          DIRECTORY_DRAFT_TIMEOUT
        )
      }),
    ])
    return GeneralSettingsResultSchema.parse(value)
  } finally {
    clearTimeout(timer)
  }
}

type State = {
  baseline: GeneralSettingsSnapshot | null
  preferences: DirectoryPreferences
  loading: boolean
  saving: boolean
  error: GeneralSettingsErrorCode | null
}
type Intent = {
  favorites: Map<string, boolean>
  removeRecent: Set<string>
  app: AppPatch
}

function applyDirectoryIntent(
  authority: DirectoryPreferences,
  intent: Intent
): DirectoryPreferences {
  return {
    favorites: [
      ...authority.favorites.filter(
        (path) => intent.favorites.get(path) !== false
      ),
      ...[...intent.favorites]
        .filter(
          ([path, present]) => present && !authority.favorites.includes(path)
        )
        .map(([path]) => path),
    ],
    recent: authority.recent.filter((path) => !intent.removeRecent.has(path)),
  }
}

/** A draft owns explicit intent; a queue-checked revision fences uncertain writes. */
export function useDirectoryPreferencesDraft(options: Options = {}) {
  const [state, setState] = useState<State>({
    baseline: null,
    preferences: { favorites: [], recent: [] },
    loading: true,
    saving: false,
    error: null,
  })
  const latest = useRef(state)
  const callbacks = useRef(options)
  callbacks.current = options
  const mounted = useRef(false)
  const generation = useRef(0)
  const saving = useRef(false)
  // A reply can be lost after committing. Keep submitted keys even when the
  // user restores their old values, and until a successful CAS fences the write.
  const submitted = useRef({
    favorites: new Set<string>(),
    recent: new Set<string>(),
    app: new Set<AppKey>(),
  })
  const update = useCallback((patch: Partial<State>) => {
    latest.current = { ...latest.current, ...patch }
    setState(latest.current)
  }, [])
  const captureIntent = useCallback((): Intent => {
    const current = latest.current
    const baseline = current.baseline?.directoryPreferences ?? {
      favorites: [],
      recent: [],
    }
    const edits = directoryPreferenceEdits(baseline, current.preferences)
    const paths = new Set([
      ...submitted.current.favorites,
      ...edits.addFavorites,
      ...edits.removeFavorites,
    ])
    const appDraft = callbacks.current.getAppDraft?.()
    const app: AppPatch = { ...appDraft?.dirty }
    if (appDraft) {
      for (const key of submitted.current.app)
        Object.assign(app, { [key]: appDraft.values[key] })
    }
    return {
      favorites: new Map(
        [...paths].map((path) => [
          path,
          current.preferences.favorites.includes(path),
        ])
      ),
      removeRecent: new Set([
        ...submitted.current.recent,
        ...edits.removeRecent,
      ]),
      app,
    }
  }, [])
  const rebase = useCallback(
    (authority: GeneralSettingsSnapshot, intent: Intent) => {
      update({
        baseline: authority,
        preferences: applyDirectoryIntent(
          authority.directoryPreferences,
          intent
        ),
      })
      callbacks.current.onAppRebase?.(authority.app, intent.app)
    },
    [update]
  )

  const refresh = useCallback(async () => {
    if (saving.current) return
    const current = ++generation.current
    const intent = captureIntent()
    update({ loading: true, error: null })
    try {
      const result = await request(Queries.GetGeneralSettingsDraft, {})
      if (!mounted.current || current !== generation.current) return
      if (result.ok) rebase(result.value, intent)
      else update({ error: result.error.code })
    } catch {
      if (mounted.current && current === generation.current)
        update({ error: 'unavailable' })
    } finally {
      if (mounted.current && current === generation.current)
        update({ loading: false })
    }
  }, [captureIntent, rebase, update])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      generation.current++
    }
  }, [refresh])

  const setPreferences = useCallback(
    (preferences: DirectoryPreferences) => {
      if (!saving.current) update({ preferences })
    },
    [update]
  )

  const save = async () => {
    let authority = latest.current.baseline
    if (!authority || latest.current.loading || saving.current) return false
    const intent = captureIntent()
    for (const path of intent.favorites.keys())
      submitted.current.favorites.add(path)
    for (const path of intent.removeRecent) submitted.current.recent.add(path)
    for (const key of Object.keys(intent.app) as AppKey[])
      submitted.current.app.add(key)
    const current = ++generation.current
    saving.current = true
    update({ saving: true, error: null })
    try {
      for (
        let attempt = 0;
        attempt < GENERAL_SETTINGS_SAVE_ATTEMPTS;
        attempt++
      ) {
        // Never short-circuit an empty delta: it must advance the host revision
        // before a previously timed-out request is allowed to finish validation.
        const result = await request(Commands.SaveGeneralSettings, {
          expectedRevision: authority.revision,
          app: intent.app,
          directories: directoryPreferenceEdits(
            authority.directoryPreferences,
            applyDirectoryIntent(authority.directoryPreferences, intent)
          ),
        })
        if (!mounted.current || current !== generation.current) return false
        if (result.ok) {
          submitted.current = {
            favorites: new Set(),
            recent: new Set(),
            app: new Set(),
          }
          rebase(result.value, {
            favorites: new Map(),
            removeRecent: new Set(),
            app: {},
          })
          return true
        }
        if (result.snapshot) {
          authority = result.snapshot
          rebase(authority, intent)
        }
        if (
          result.error.code !== 'conflict' ||
          !result.snapshot ||
          attempt + 1 === GENERAL_SETTINGS_SAVE_ATTEMPTS
        ) {
          update({ error: result.error.code })
          return false
        }
      }
    } catch {
      if (mounted.current && current === generation.current)
        update({ error: 'unavailable' })
    } finally {
      if (mounted.current && current === generation.current) {
        saving.current = false
        update({ saving: false })
      }
    }
    return false
  }

  return {
    ...state,
    ready: state.baseline !== null,
    setPreferences,
    refresh,
    save,
  }
}
