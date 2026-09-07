import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  type DirectoryPreferences,
  type DirectoryPreferencesErrorCode,
  DirectoryPreferencesResultSchema,
} from '@shared/schemas/directory-preferences'
import type { SaveGeneralSettingsRequest } from '@shared/schemas/general-settings'
import { useCallback, useEffect, useRef, useState } from 'react'

export const DIRECTORY_DRAFT_TIMEOUT = 20_000

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
    | typeof Queries.GetDirectoryPreferences
    | typeof Commands.SaveGeneralSettings,
  args: unknown
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => transport.invoke(channel, args)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Directory request timed out')),
          DIRECTORY_DRAFT_TIMEOUT
        )
      }),
    ])
    return DirectoryPreferencesResultSchema.parse(value)
  } finally {
    clearTimeout(timer)
  }
}

type State = {
  baseline: DirectoryPreferences | null
  preferences: DirectoryPreferences
  loading: boolean
  saving: boolean
  error: DirectoryPreferencesErrorCode | null
}

/** A form session owns its draft; host events never replace unsaved edits. */
export function useDirectoryPreferencesDraft() {
  const [state, setState] = useState<State>({
    baseline: null,
    preferences: { favorites: [], recent: [] },
    loading: true,
    saving: false,
    error: null,
  })
  const latest = useRef(state)
  latest.current = state
  const mounted = useRef(false)
  const generation = useRef(0)
  const saving = useRef(false)

  const refresh = useCallback(async () => {
    if (saving.current) return
    const current = ++generation.current
    setState((old) => ({ ...old, loading: true, error: null }))
    try {
      const result = await request(Queries.GetDirectoryPreferences, {})
      if (!mounted.current || current !== generation.current) return
      if (!result.ok) {
        setState((old) => ({ ...old, error: result.error.code }))
        return
      }
      setState((old) => {
        if (!old.baseline)
          return { ...old, baseline: result.value, preferences: result.value }
        // An explicit reread keeps local intent while including newly saved rows.
        const edits = directoryPreferenceEdits(old.baseline, old.preferences)
        return {
          ...old,
          baseline: result.value,
          preferences: {
            favorites: [
              ...result.value.favorites.filter(
                (path) => !edits.removeFavorites.includes(path)
              ),
              ...edits.addFavorites.filter(
                (path) => !result.value.favorites.includes(path)
              ),
            ],
            recent: result.value.recent.filter(
              (path) => !edits.removeRecent.includes(path)
            ),
          },
        }
      })
    } catch {
      if (mounted.current && current === generation.current)
        setState((old) => ({ ...old, error: 'unavailable' }))
    } finally {
      if (mounted.current && current === generation.current)
        setState((old) => ({ ...old, loading: false }))
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      generation.current++
    }
  }, [refresh])

  const setPreferences = useCallback((preferences: DirectoryPreferences) => {
    if (saving.current) return
    setState((old) => ({ ...old, preferences }))
  }, [])

  const save = async (app: SaveGeneralSettingsRequest['app'] = {}) => {
    const snapshot = latest.current
    if (!snapshot.baseline || snapshot.loading || saving.current) return false
    const directories = directoryPreferenceEdits(
      snapshot.baseline,
      snapshot.preferences
    )
    if (
      Object.keys(app).length === 0 &&
      Object.values(directories).every((paths) => paths.length === 0)
    )
      return true
    const current = ++generation.current
    saving.current = true
    setState((old) => ({ ...old, saving: true, error: null }))
    try {
      const result = await request(Commands.SaveGeneralSettings, {
        app,
        directories,
      })
      if (!mounted.current || current !== generation.current) return false
      if (!result.ok) {
        setState((old) => ({ ...old, error: result.error.code }))
        return false
      }
      setState((old) => ({
        ...old,
        baseline: result.value,
        preferences: result.value,
      }))
      return true
    } catch {
      if (mounted.current && current === generation.current)
        setState((old) => ({ ...old, error: 'unavailable' }))
      return false
    } finally {
      if (mounted.current && current === generation.current) {
        saving.current = false
        setState((old) => ({ ...old, saving: false }))
      }
    }
  }

  return {
    ...state,
    ready: state.baseline !== null,
    setPreferences,
    refresh,
    save,
  }
}
