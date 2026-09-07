import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  DIRECTORY_DRAFT_TIMEOUT,
  useDirectoryPreferencesDraft,
} from './use-directory-preferences-draft'

vi.mock('@renderer/lib/transport', () => ({ transport: { invoke: vi.fn() } }))
const initial = { favorites: ['/old'], recent: ['/seen'] }
const ok = (value = initial) => ({ ok: true, value })
beforeEach(() =>
  vi.mocked(transport.invoke).mockReset().mockResolvedValue(ok())
)
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('survives StrictMode effect replay and ignores the superseded initial response', async () => {
  let first!: (value: unknown) => void
  vi.mocked(transport.invoke)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first = resolve
        })
    )
    .mockResolvedValueOnce(ok({ favorites: ['/latest'], recent: [] }))
  const { result } = renderHook(useDirectoryPreferencesDraft, {
    wrapper: StrictMode,
  })
  await waitFor(() => expect(result.current.ready).toBe(true))
  expect(result.current.preferences.favorites).toEqual(['/latest'])
  await act(async () => first(ok()))
  expect(result.current.preferences.favorites).toEqual(['/latest'])
})

it('bounds an initial read locally and cannot submit before a valid baseline arrives', async () => {
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
  expect(result.current.ready).toBe(false)
  expect(await result.current.save({ notifyOnError: false })).toBe(false)
  await act(async () => release(ok()))
  expect(result.current.ready).toBe(false)
  await act(async () => result.current.refresh())
  expect(result.current.ready).toBe(true)
})

it('retains a timed-out Save draft without replaying the atomic command', async () => {
  const { result } = renderHook(useDirectoryPreferencesDraft)
  await waitFor(() => expect(result.current.ready).toBe(true))
  act(() => result.current.setPreferences({ favorites: [], recent: [] }))
  vi.useFakeTimers()
  let release!: (value: unknown) => void
  vi.mocked(transport.invoke).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  let saving!: Promise<boolean>
  act(() => {
    saving = result.current.save({ notifyOnError: false })
  })
  await act(async () => vi.advanceTimersByTimeAsync(DIRECTORY_DRAFT_TIMEOUT))
  expect(await saving).toBe(false)
  expect(result.current.error).toBe('unavailable')
  expect(result.current.preferences).toEqual({ favorites: [], recent: [] })
  await act(async () => release(ok()))
  expect(result.current.preferences).toEqual({ favorites: [], recent: [] })
  expect(
    vi.mocked(transport.invoke).mock.calls.map(([channel]) => channel)
  ).toEqual([Queries.GetDirectoryPreferences, Commands.SaveGeneralSettings])
})

it('explicit Retry rebases draft removals while preserving remote additions', async () => {
  const { result } = renderHook(useDirectoryPreferencesDraft)
  await waitFor(() => expect(result.current.ready).toBe(true))
  act(() =>
    result.current.setPreferences({ favorites: ['/local'], recent: [] })
  )
  vi.mocked(transport.invoke).mockResolvedValueOnce(
    ok({ favorites: ['/old', '/remote'], recent: ['/new-use', '/seen'] })
  )
  await act(async () => result.current.refresh())
  expect(result.current.preferences).toEqual({
    favorites: ['/remote', '/local'],
    recent: ['/new-use'],
  })
  await act(async () => {
    await result.current.save()
  })
  expect(transport.invoke).toHaveBeenCalledWith(Commands.SaveGeneralSettings, {
    app: {},
    directories: {
      addFavorites: ['/local'],
      removeFavorites: ['/old'],
      removeRecent: ['/seen'],
    },
  })
})
