import '@testing-library/jest-dom/vitest'
import { applyRendererLocale, i18n } from '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LanguageSync } from './language-sync'

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (...args: unknown[]) => void>(),
  platform: 'darwin' as NodeJS.Platform | 'web',
  connectionListener: undefined as
    | ((event: { state: 'connecting' | 'connected' | 'disconnected' }) => void)
    | undefined,
  stopConnectionSync: vi.fn(),
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(),
    on: vi.fn((channel: string, callback: (...args: unknown[]) => void) => {
      mocks.listeners.set(channel, callback)
    }),
    off: vi.fn(),
    onConnectionChange: vi.fn(
      (
        callback: (event: {
          state: 'connecting' | 'connected' | 'disconnected'
        }) => void
      ) => {
        mocks.connectionListener = callback
        return mocks.stopConnectionSync
      }
    ),
    get platform() {
      return mocks.platform
    },
  },
}))

describe('LanguageSync', () => {
  beforeEach(async () => {
    mocks.listeners.clear()
    mocks.platform = 'darwin'
    mocks.connectionListener = undefined
    vi.clearAllMocks()
    vi.mocked(transport.invoke).mockReset()
    vi.mocked(transport.invoke).mockResolvedValue({
      app: { language: 'en-US' },
    })
    await applyRendererLocale('en-US')
  })

  it('applies host locale events and unsubscribes on unmount', async () => {
    const view = render(<LanguageSync />)
    const listener = mocks.listeners.get(Events.LocaleChanged)

    expect(listener).toBeDefined()
    act(() => listener?.({ language: 'zh-CN' }))

    await waitFor(() => expect(i18n.resolvedLanguage).toBe('zh-CN'))
    expect(document.documentElement).toHaveAttribute('lang', 'zh-CN')

    view.unmount()
    expect(transport.off).toHaveBeenCalledWith(Events.LocaleChanged, listener)
  })

  it('ignores malformed locale events', async () => {
    render(<LanguageSync />)
    const listener = mocks.listeners.get(Events.LocaleChanged)

    act(() => listener?.({ language: 'not-a-locale' }))

    await Promise.resolve()
    expect(i18n.resolvedLanguage).toBe('en-US')
  })

  it('reconciles persisted settings once when an Electron window mounts', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      app: { language: 'zh-CN' },
    })

    render(<LanguageSync windowId="main" />)

    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(Queries.GetSettings)
    )
    await waitFor(() => expect(i18n.resolvedLanguage).toBe('zh-CN'))
    expect(transport.onConnectionChange).not.toHaveBeenCalled()
  })

  it('reconciles persisted settings whenever the web transport connects', async () => {
    mocks.platform = 'web'
    vi.mocked(transport.invoke)
      .mockResolvedValueOnce({ app: { language: 'zh-CN' } })
      .mockResolvedValueOnce({ app: { language: 'en-US' } })
    render(<LanguageSync windowId="main" />)

    act(() => mocks.connectionListener?.({ state: 'connected' }))

    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(Queries.GetSettings)
    )
    await waitFor(() => expect(i18n.resolvedLanguage).toBe('zh-CN'))

    act(() => {
      mocks.connectionListener?.({ state: 'connecting' })
      mocks.connectionListener?.({ state: 'connected' })
    })
    await waitFor(() => expect(transport.invoke).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(i18n.resolvedLanguage).toBe('en-US'))
  })

  it('does not let a stale web reconciliation overwrite a newer event', async () => {
    mocks.platform = 'web'
    let resolveSettings: ((value: unknown) => void) | undefined
    vi.mocked(transport.invoke).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSettings = resolve
        })
    )
    render(<LanguageSync windowId="main" />)

    act(() => mocks.connectionListener?.({ state: 'connected' }))
    const listener = mocks.listeners.get(Events.LocaleChanged)
    act(() => listener?.({ language: 'zh-CN' }))
    await waitFor(() => expect(i18n.resolvedLanguage).toBe('zh-CN'))

    await act(async () => {
      resolveSettings?.({ app: { language: 'en-US' } })
      await Promise.resolve()
    })
    expect(i18n.resolvedLanguage).toBe('zh-CN')
  })

  it('reconciles the disclaimer locale when onboarding reconnects', async () => {
    mocks.platform = 'web'
    vi.mocked(transport.invoke).mockResolvedValue({ language: 'zh-CN' })
    render(<LanguageSync windowId="onboarding" />)

    act(() => mocks.connectionListener?.({ state: 'connected' }))

    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(Queries.GetDisclaimerState)
    )
    await waitFor(() => expect(i18n.resolvedLanguage).toBe('zh-CN'))
    expect(mocks.listeners.get(Events.LocaleChanged)).toBeDefined()
  })
})
