import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useCurrentSite } from '@/popup/useCurrentSite'
import { extensionBrowser } from '@/shared/browser'

describe('useCurrentSite', () => {
  it('updates the displayed domain on navigation and tab switches, and clears it on internal pages', async () => {
    const query = vi.fn(async () => [
      { id: 1, url: 'https://one.example/page' },
    ])
    const onActivated = { addListener: vi.fn(), removeListener: vi.fn() }
    const onUpdated = { addListener: vi.fn(), removeListener: vi.fn() }
    Object.assign(extensionBrowser.tabs, { query, onActivated, onUpdated })
    const { result, unmount } = renderHook(() => useCurrentSite())
    await waitFor(() => expect(result.current).toBe('one.example'))
    query.mockResolvedValue([{ id: 1, url: 'https://two.example/secret' }])
    await act(async () => {
      onUpdated.addListener.mock.calls[0]![0](1, {
        url: 'https://two.example/secret',
      })
    })
    expect(result.current).toBe('two.example')
    query.mockResolvedValue([{ id: 2, url: 'chrome://settings' }])
    await act(async () => {
      onActivated.addListener.mock.calls[0]![0]({ tabId: 2 })
    })
    expect(result.current).toBeNull()
    unmount()
    expect(onActivated.removeListener).toHaveBeenCalledWith(
      onActivated.addListener.mock.calls[0]![0]
    )
    expect(onUpdated.removeListener).toHaveBeenCalledWith(
      onUpdated.addListener.mock.calls[0]![0]
    )
  })
})
