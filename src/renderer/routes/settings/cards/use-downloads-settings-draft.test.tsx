import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { downloadsSettingsResult } from '@test-utils/downloads-settings'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useForm } from 'react-hook-form'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DOWNLOADS_DEFAULTS, type DownloadsFields } from './downloads-form'
import { useDownloadsSettingsDraft } from './use-downloads-settings-draft'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))
vi.mock('@renderer/lib/settings-save', () => ({ notifySettingsSaved: vi.fn() }))
beforeEach(() => vi.mocked(transport.invoke).mockReset())
function openDraft() {
  return renderHook(() => {
    const form = useForm<DownloadsFields>({ defaultValues: DOWNLOADS_DEFAULTS })
    const draft = useDownloadsSettingsDraft(form)
    return { form, draft }
  })
}
describe('Downloads draft rebase', () => {
  it('merges exact nested intent with a newer sibling value and directory history', async () => {
    const base = downloadsSettingsResult()
    const newer = downloadsSettingsResult(
      {
        speedLimit: {
          ...DOWNLOADS_DEFAULTS.speedLimit,
          base: { upload: 700, download: 0 },
        },
      },
      { favorites: [], recent: ['/newer'] }
    )
    newer.value.revision = '00000000-0000-4000-8000-000000000002'
    let saved = 0
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetDownloadsSettingsDraft) return base
      if (++saved === 1)
        return { ok: false, error: { code: 'conflict' }, snapshot: newer.value }
      return newer
    })
    const { result } = openDraft()
    await waitFor(() => expect(result.current.draft.ready).toBe(true))
    act(() =>
      result.current.form.setValue('speedLimit.base.download', 250, {
        shouldDirty: true,
      })
    )
    await act(async () => {
      expect(await result.current.draft.save()).toBe(true)
    })
    const calls = vi
      .mocked(transport.invoke)
      .mock.calls.filter(
        ([channel]) => channel === Commands.SaveDownloadsSettings
      )
    expect(calls).toHaveLength(2)
    expect(calls[1][1]).toEqual({
      expectedRevision: newer.value.revision,
      settings: { speedLimit: { base: { download: 250 } } },
      directories: { addFavorites: [], removeFavorites: [], removeRecent: [] },
    })
    expect(result.current.form.getValues('speedLimit.base.upload')).toBe(700)
    expect(result.current.draft.preferences.recent).toEqual(['/newer'])
  })
  it('keeps an explicit reversal after a committed reply is lost', async () => {
    let authority = downloadsSettingsResult()
    let lost = true
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetDownloadsSettingsDraft) return authority
      if (lost) {
        lost = false
        authority = downloadsSettingsResult({
          speedLimit: {
            ...DOWNLOADS_DEFAULTS.speedLimit,
            base: { upload: 0, download: 250 },
          },
        })
        authority.value.revision = '00000000-0000-4000-8000-000000000002'
        throw Error('lost reply')
      }
      return authority
    })
    const { result } = openDraft()
    await waitFor(() => expect(result.current.draft.ready).toBe(true))
    act(() =>
      result.current.form.setValue('speedLimit.base.download', 250, {
        shouldDirty: true,
      })
    )
    await act(async () => {
      expect(await result.current.draft.save()).toBe(false)
    })
    act(() =>
      result.current.form.setValue('speedLimit.base.download', 0, {
        shouldDirty: true,
      })
    )
    await act(async () => {
      expect(await result.current.draft.save()).toBe(true)
    })
    expect(transport.invoke).toHaveBeenLastCalledWith(
      Commands.SaveDownloadsSettings,
      expect.objectContaining({
        settings: { speedLimit: { base: { download: 0 } } },
      })
    )
  })
})
