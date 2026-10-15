import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/background/MessageBus', () => ({ send: vi.fn() }))
vi.mock('@/shared/platformCapabilities', () => ({
  supportsAutoOpenPopup: () => true,
}))

import * as MessageBus from '@/background/MessageBus'
import { useQuickSettings } from '@/popup/useQuickSettings'
import { extensionBrowser } from '@/shared/browser'
import type { NotificationsConfig } from '@/shared/notifications'
import { withSiteExcluded } from '@/shared/siteExclusion'
import { CONSENT_VERSION, type TakeoverConfig } from '@/shared/takeover'

const send = vi.mocked(MessageBus.send)

const TAKEOVER: TakeoverConfig = {
  enabled: false,
  openTaskPanelAfterSubmit: true,
  consentAckVersion: 0,
  defaultAction: 'chrome',
  rules: [
    {
      id: 'large-files',
      match: { minSizeMB: 25, mimePatterns: ['application/*'] },
      action: 'ask',
    },
  ],
}

const NOTIFICATIONS: NotificationsConfig = {
  master: true,
  confirm: false,
  error: true,
  reminder: true,
}

function mockSuccessfulBus(): void {
  send.mockImplementation(async (kind: string, payload) => {
    if (kind === 'bg.hasPairedBackend') return { paired: true }
    if (kind === 'bg.getTakeoverConfig') return structuredClone(TAKEOVER)
    if (
      kind === 'bg.patchTakeoverEnabled' ||
      kind === 'bg.patchTaskPanelPreference'
    )
      return { ...TAKEOVER, ...payload }
    if (kind === 'bg.patchSiteExclusion') {
      const { domain, excluded } = payload as {
        domain: string
        excluded: boolean
      }
      return withSiteExcluded(TAKEOVER, domain, excluded)
    }
    if (kind === 'bg.getNotificationsConfig') {
      return structuredClone(NOTIFICATIONS)
    }
    return { ok: true }
  })
}

describe('useQuickSettings', () => {
  beforeEach(() => {
    send.mockReset()
    extensionBrowser.tabs.query = vi.fn(async () => [
      { id: 4, url: 'https://files.example.com/private?token=secret' },
    ]) as never
  })

  it('loads both background-owned configs', async () => {
    mockSuccessfulBus()
    const { result } = renderHook(() => useQuickSettings())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.takeover).toEqual(TAKEOVER)
    expect(result.current.notifications).toEqual(NOTIFICATIONS)
    expect(result.current.error).toBeNull()
    expect(result.current.currentSite).toBe('files.example.com')
  })

  it('patches the task panel preference while takeover is off or remote', async () => {
    mockSuccessfulBus()
    const { result } = renderHook(() => useQuickSettings(false))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.setOpenTaskPanelAfterSubmit(false)
    })
    expect(send).toHaveBeenCalledWith('bg.patchTaskPanelPreference', {
      openTaskPanelAfterSubmit: false,
    })
    expect(result.current.takeover).toEqual({
      ...TAKEOVER,
      openTaskPanelAfterSubmit: false,
    })
  })

  it('toggles the displayed domain exclusion without sending the page URL or changing other settings', async () => {
    mockSuccessfulBus()
    const { result } = renderHook(() => useQuickSettings())
    await waitFor(() =>
      expect(result.current.currentSite).toBe('files.example.com')
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.setCurrentSiteExcluded(true)
    })
    expect(send).toHaveBeenCalledWith('bg.patchSiteExclusion', {
      domain: 'files.example.com',
      excluded: true,
    })
    expect(result.current.excludedSite).toBe('files.example.com')
    expect(result.current.takeover?.rules).toContainEqual(TAKEOVER.rules[0])
    await act(async () => {
      await result.current.setCurrentSiteExcluded(false)
    })
    expect(result.current.excludedSite).toBeNull()
    expect(result.current.takeover).toEqual(TAKEOVER)
  })

  it('rolls back a failed site exclusion save', async () => {
    mockSuccessfulBus()
    const { result } = renderHook(() => useQuickSettings())
    await waitFor(() => expect(result.current.loading).toBe(false))
    send.mockRejectedValueOnce(new Error('storage failed'))
    await act(async () => {
      await result.current.setCurrentSiteExcluded(true)
    })
    expect(result.current.excludedSite).toBeNull()
    expect(result.current.error?.operation).toBe('save')
  })

  it('blocks remote toggles and consent without overwriting the retained local preference', async () => {
    mockSuccessfulBus()
    const { result, rerender } = renderHook(
      ({ supported }) => useQuickSettings(supported),
      { initialProps: { supported: true } }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.requestTakeoverEnabled(true)
    })
    expect(result.current.consentRequired).toBe(true)
    rerender({ supported: false })
    expect(result.current.consentRequired).toBe(false)
    await act(async () => {
      await result.current.confirmTakeoverConsent()
      await result.current.requestTakeoverEnabled(true)
    })
    expect(
      send.mock.calls.filter(([kind]) => kind === 'bg.patchTakeoverEnabled')
    ).toHaveLength(0)
    expect(result.current.takeover).toEqual(TAKEOVER)
    rerender({ supported: true })
    expect(result.current.takeover).toEqual(TAKEOVER)
    expect(result.current.takeoverSupported).toBe(true)
  })

  it('requires explicit consent before first enable and preserves all fields', async () => {
    mockSuccessfulBus()
    const { result } = renderHook(() => useQuickSettings())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.requestTakeoverEnabled(true)
    })

    expect(result.current.consentRequired).toBe(true)
    expect(result.current.takeover?.enabled).toBe(false)
    expect(
      send.mock.calls.filter(([kind]) => kind === 'bg.patchTakeoverEnabled')
    ).toHaveLength(0)

    await act(async () => {
      await result.current.confirmTakeoverConsent()
    })

    expect(result.current.consentRequired).toBe(false)
    expect(result.current.takeover).toEqual({
      ...TAKEOVER,
      enabled: true,
      consentAckVersion: CONSENT_VERSION,
    })
    expect(send).toHaveBeenCalledWith('bg.patchTakeoverEnabled', {
      enabled: true,
      consentAckVersion: CONSENT_VERSION,
    })
  })

  it('changes one notification flag without resetting the others', async () => {
    mockSuccessfulBus()
    const { result } = renderHook(() => useQuickSettings())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.setNotification('confirm', true)
    })

    const expected = { ...NOTIFICATIONS, confirm: true }
    expect(result.current.notifications).toEqual(expected)
    expect(send).toHaveBeenCalledWith('bg.setNotificationsConfig', expected)
  })

  it('rolls an optimistic update back and exposes save errors', async () => {
    send.mockImplementation(async (kind: string) => {
      if (kind === 'bg.hasPairedBackend') return { paired: true }
      if (kind === 'bg.getTakeoverConfig') {
        return { ...TAKEOVER, consentAckVersion: CONSENT_VERSION }
      }
      if (kind === 'bg.getNotificationsConfig') return NOTIFICATIONS
      if (kind === 'bg.patchTakeoverEnabled') throw new Error('storage failed')
      return { ok: true }
    })
    const { result } = renderHook(() => useQuickSettings())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.requestTakeoverEnabled(true)
    })

    expect(result.current.takeover?.enabled).toBe(false)
    expect(result.current.error).toEqual({
      operation: 'save',
      message: 'storage failed',
    })
  })

  it('exposes load errors and can retry', async () => {
    let fail = true
    send.mockImplementation(async (kind: string) => {
      if (fail) throw new Error('background unavailable')
      if (kind === 'bg.hasPairedBackend') return { paired: true }
      if (kind === 'bg.getTakeoverConfig') return TAKEOVER
      if (kind === 'bg.getNotificationsConfig') return NOTIFICATIONS
      return { ok: true }
    })
    const { result } = renderHook(() => useQuickSettings())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toEqual({
      operation: 'load',
      message: 'background unavailable',
    })

    fail = false
    await act(async () => {
      await result.current.reload()
    })

    expect(result.current.takeover).toEqual(TAKEOVER)
    expect(result.current.notifications).toEqual(NOTIFICATIONS)
    expect(result.current.error).toBeNull()
  })
})

it('requires pairing before consent, then accepts pairing completed elsewhere', async () => {
  mockSuccessfulBus()
  const implementation = send.getMockImplementation()!
  let paired = false
  send.mockImplementation(async (kind, payload) =>
    kind === 'bg.hasPairedBackend' ? { paired } : implementation(kind, payload)
  )
  const { result } = renderHook(() => useQuickSettings())
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(async () => {
    await result.current.requestTakeoverEnabled(true)
  })
  expect(result.current.pairingRequired).toBe(true)
  expect(result.current.consentRequired).toBe(false)
  expect(result.current.takeover?.enabled).toBe(false)
  expect(
    send.mock.calls.some(([kind]) => kind === 'bg.patchTakeoverEnabled')
  ).toBe(false)
  act(() => result.current.cancelTakeoverPairing())
  expect(result.current.pairingRequired).toBe(false)
  paired = true
  await act(async () => {
    await result.current.requestTakeoverEnabled(true)
  })
  expect(result.current.consentRequired).toBe(true)
  paired = false
  await act(async () => {
    await result.current.confirmTakeoverConsent()
  })
  expect(result.current.pairingRequired).toBe(true)
  expect(result.current.consentRequired).toBe(false)
  expect(result.current.takeover?.enabled).toBe(false)
})
