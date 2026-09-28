import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type {
  GeneralSettingsSnapshot,
  SaveGeneralSettingsRequest,
} from '@shared/schemas/general-settings'
import { generalSettingsSnapshot } from '@test-utils/general-settings'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  DIRECTORY_DRAFT_TIMEOUT,
  GENERAL_SETTINGS_SAVE_ATTEMPTS,
  useDirectoryPreferencesDraft,
} from './use-directory-preferences-draft'

vi.mock('@renderer/lib/transport', () => ({ transport: { invoke: vi.fn() } }))
const initial = { favorites: ['/old'], recent: ['/seen'] }
const ok = (preferences = initial) => ({
  ok: true as const,
  value: generalSettingsSnapshot(preferences),
})
beforeEach(() => {
  vi.mocked(transport.invoke).mockReset().mockResolvedValue(ok())
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function host() {
  let revision = 1
  let snapshot = generalSettingsSnapshot(initial)
  const bump = () => {
    snapshot.revision = `00000000-0000-4000-8000-${String(++revision).padStart(12, '0')}`
  }
  const commit = (raw: unknown) => {
    const request = raw as SaveGeneralSettingsRequest
    if (request.expectedRevision !== snapshot.revision)
      return {
        ok: false as const,
        error: { code: 'conflict' as const },
        snapshot: structuredClone(snapshot),
      }
    const { app, directories } = request
    snapshot.app = { ...snapshot.app, ...app }
    snapshot.directoryPreferences = {
      favorites: [
        ...new Set([
          ...snapshot.directoryPreferences.favorites.filter(
            (p) => !directories.removeFavorites.includes(p)
          ),
          ...directories.addFavorites,
        ]),
      ],
      recent: snapshot.directoryPreferences.recent.filter(
        (p) => !directories.removeRecent.includes(p)
      ),
    }
    bump()
    return { ok: true as const, value: structuredClone(snapshot) }
  }
  vi.mocked(transport.invoke).mockImplementation(async (channel, request) =>
    channel === Queries.GetGeneralSettingsDraft
      ? { ok: true, value: structuredClone(snapshot) }
      : commit(request)
  )
  return {
    commit,
    get: () => snapshot,
    replace: (next: GeneralSettingsSnapshot) => {
      snapshot = next
      bump()
    },
  }
}

it('survives StrictMode replay and ignores the superseded initial snapshot', async () => {
  let release!: (value: unknown) => void
  vi.mocked(transport.invoke)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    .mockResolvedValueOnce(ok({ favorites: ['/latest'], recent: [] }))
  const { result } = renderHook(useDirectoryPreferencesDraft, {
    wrapper: StrictMode,
  })
  await waitFor(() => expect(result.current.ready).toBe(true))
  await act(async () => release(ok()))
  expect(result.current.preferences.favorites).toEqual(['/latest'])
})

it('bounds initial reads and requires a valid snapshot before Save', async () => {
  vi.useFakeTimers()
  let release!: (value: unknown) => void
  vi.mocked(transport.invoke).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const { result } = renderHook(useDirectoryPreferencesDraft)
  await act(async () => vi.advanceTimersByTimeAsync(DIRECTORY_DRAFT_TIMEOUT))
  expect(result.current.error).toBe('unavailable')
  expect(await result.current.save()).toBe(false)
  await act(async () => release(ok()))
  expect(result.current.ready).toBe(false)
  await act(async () => result.current.refresh())
  expect(result.current.ready).toBe(true)
})

it('restores a deleted favorite after a committed reply was lost, preserving unrelated remote additions', async () => {
  const h = host()
  const { result } = renderHook(useDirectoryPreferencesDraft)
  await waitFor(() => expect(result.current.ready).toBe(true))
  act(() =>
    result.current.setPreferences({ favorites: [], recent: initial.recent })
  )
  vi.mocked(transport.invoke).mockImplementationOnce(
    async (_channel, request) => {
      h.commit(request)
      throw new Error('reply lost')
    }
  )
  await act(async () => expect(await result.current.save()).toBe(false))
  h.replace({
    ...h.get(),
    directoryPreferences: {
      favorites: ['/remote'],
      recent: ['/new-use', '/seen'],
    },
  })
  act(() => result.current.setPreferences(initial))
  await act(async () => expect(await result.current.save()).toBe(true))
  expect(h.get().directoryPreferences).toEqual({
    favorites: ['/remote', '/old'],
    recent: ['/new-use', '/seen'],
  })
})

it('fences an original request still validating when a compensating no-op succeeds first', async () => {
  const h = host()
  const { result } = renderHook(useDirectoryPreferencesDraft)
  await waitFor(() => expect(result.current.ready).toBe(true))
  act(() =>
    result.current.setPreferences({ ...initial, favorites: ['/old', '/new'] })
  )
  let release!: () => void
  let lateResult: unknown
  vi.mocked(transport.invoke).mockImplementationOnce(
    (_channel, request) =>
      new Promise((resolve) => {
        release = () => {
          lateResult = h.commit(request)
          resolve(lateResult)
        }
      })
  )
  vi.useFakeTimers()
  let first!: Promise<boolean>
  act(() => {
    first = result.current.save()
  })
  await act(async () => vi.advanceTimersByTimeAsync(DIRECTORY_DRAFT_TIMEOUT))
  expect(await first).toBe(false)
  act(() => result.current.setPreferences(initial))
  await act(async () => expect(await result.current.save()).toBe(true))
  await act(async () => release())
  expect(lateResult).toMatchObject({ ok: false, error: { code: 'conflict' } })
  expect(h.get().directoryPreferences).toEqual(initial)
  expect(result.current.preferences).toEqual(initial)
})

it('retains reverted submitted intent through Retry even when it equals the refreshed host value', async () => {
  const h = host()
  const { result } = renderHook(useDirectoryPreferencesDraft)
  await waitFor(() => expect(result.current.ready).toBe(true))
  act(() =>
    result.current.setPreferences({ ...initial, favorites: ['/old', '/new'] })
  )
  vi.mocked(transport.invoke).mockRejectedValueOnce(
    new Error('unknown request')
  )
  await act(async () => result.current.save())
  act(() => result.current.setPreferences(initial))
  await act(async () => result.current.refresh())
  const before = h.get().revision
  await act(async () => expect(await result.current.save()).toBe(true))
  expect(h.get().revision).not.toBe(before)
  const request = vi
    .mocked(transport.invoke)
    .mock.calls.at(-1)?.[1] as SaveGeneralSettingsRequest
  expect(request.directories).toEqual({
    addFavorites: [],
    removeFavorites: [],
    removeRecent: [],
  })
})

it('rebases explicit removals against a refreshed snapshot while keeping new remote rows', async () => {
  const h = host()
  const { result } = renderHook(useDirectoryPreferencesDraft)
  await waitFor(() => expect(result.current.ready).toBe(true))
  act(() =>
    result.current.setPreferences({ favorites: ['/local'], recent: [] })
  )
  h.replace({
    ...h.get(),
    directoryPreferences: {
      favorites: ['/old', '/remote'],
      recent: ['/new-use', '/seen'],
    },
  })
  await act(async () => result.current.refresh())
  expect(result.current.preferences).toEqual({
    favorites: ['/remote', '/local'],
    recent: ['/new-use'],
  })
  await act(async () => result.current.save())
  expect(h.get().directoryPreferences).toEqual(result.current.preferences)
})

it('retries runtime fields after an acknowledged commit and restores an originally clean boolean', async () => {
  const h = host()
  let values = { ...h.get().app }
  let dirty: SaveGeneralSettingsRequest['app'] = {}
  const rebase = vi.fn((baseline, intent) => {
    values = { ...baseline, ...intent }
    dirty = {}
  })
  const { result } = renderHook(() =>
    useDirectoryPreferencesDraft({
      getAppDraft: () => ({ values, dirty }),
      onAppRebase: rebase,
    })
  )
  await waitFor(() => expect(result.current.ready).toBe(true))
  values.notifyOnError = false
  dirty = { notifyOnError: false }
  vi.mocked(transport.invoke).mockImplementationOnce(
    async (_channel, request) => {
      const saved = h.commit(request)
      return {
        ok: false,
        error: { code: 'unavailable' },
        snapshot: saved.ok ? saved.value : saved.snapshot,
      }
    }
  )
  await act(async () => expect(await result.current.save()).toBe(false))
  expect(dirty).toEqual({})
  // Even matching the known committed baseline must repeat the submitted field
  // so its runtime effect can be reapplied.
  await act(async () => expect(await result.current.save()).toBe(true))
  expect(vi.mocked(transport.invoke).mock.calls.at(-1)?.[1]).toMatchObject({
    app: { notifyOnError: false },
  })
  values.notifyOnError = true
  dirty = { notifyOnError: true }
  vi.mocked(transport.invoke).mockImplementationOnce(
    async (_channel, request) => {
      h.commit(request)
      throw new Error('lost')
    }
  )
  await act(async () => result.current.save())
  values.notifyOnError = false
  dirty = {}
  await act(async () => expect(await result.current.save()).toBe(true))
  expect(h.get().app.notifyOnError).toBe(false)
})

it('stops after bounded conflicts without discarding the current draft', async () => {
  host()
  const { result } = renderHook(useDirectoryPreferencesDraft)
  await waitFor(() => expect(result.current.ready).toBe(true))
  act(() =>
    result.current.setPreferences({ favorites: ['/local'], recent: [] })
  )
  vi.mocked(transport.invoke).mockImplementation(async () => ({
    ok: false,
    error: { code: 'conflict' },
    snapshot: generalSettingsSnapshot({
      favorites: ['/old', '/remote'],
      recent: ['/seen'],
    }),
  }))
  await act(async () => expect(await result.current.save()).toBe(false))
  expect(result.current.error).toBe('conflict')
  expect(result.current.preferences).toEqual({
    favorites: ['/remote', '/local'],
    recent: [],
  })
  expect(
    vi
      .mocked(transport.invoke)
      .mock.calls.filter(
        ([channel]) => channel === Commands.SaveGeneralSettings
      )
  ).toHaveLength(GENERAL_SETTINGS_SAVE_ATTEMPTS)
})
