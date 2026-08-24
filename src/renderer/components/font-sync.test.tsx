import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyFontFamily, FontSync } from './font-sync'

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
    onConnectionChange: vi.fn((callback) => {
      mocks.connectionListener = callback
      return mocks.stopConnectionSync
    }),
    get platform() {
      return mocks.platform
    },
  },
}))

describe('applyFontFamily', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty('--app-font-family')
  })

  it('removes CSS custom property when font is null, empty, or whitespace', () => {
    document.documentElement.style.setProperty('--app-font-family', 'Roboto')

    applyFontFamily(null)
    expect(
      document.documentElement.style.getPropertyValue('--app-font-family')
    ).toBe('')

    applyFontFamily('')
    expect(
      document.documentElement.style.getPropertyValue('--app-font-family')
    ).toBe('')

    applyFontFamily('   ')
    expect(
      document.documentElement.style.getPropertyValue('--app-font-family')
    ).toBe('')
  })

  it('quotes font names and appends default fallback fonts', () => {
    applyFontFamily('Fira Code')
    expect(
      document.documentElement.style.getPropertyValue('--app-font-family')
    ).toBe('"Fira Code", "Inter Variable", sans-serif')
  })

  it('preserves pre-quoted names and unquoted CSS generic families', () => {
    applyFontFamily('"Custom Font", monospace, sans-serif')
    expect(
      document.documentElement.style.getPropertyValue('--app-font-family')
    ).toBe('"Custom Font", "Inter Variable", sans-serif')
  })

  it('handles comma-separated font strings by taking only the primary font', () => {
    applyFontFamily('Roboto, , sans-serif')
    expect(
      document.documentElement.style.getPropertyValue('--app-font-family')
    ).toBe('"Roboto", "Inter Variable", sans-serif')
  })
})

describe('FontSync', () => {
  beforeEach(() => {
    mocks.listeners.clear()
    mocks.platform = 'darwin'
    mocks.connectionListener = undefined
    document.documentElement.style.removeProperty('--app-font-family')
    vi.clearAllMocks()
    vi.mocked(transport.invoke).mockReset()
    vi.mocked(transport.invoke).mockResolvedValue({
      app: { fontFamily: 'Roboto' },
    })
  })

  it('applies host settings events and unsubscribes on unmount', () => {
    const view = render(<FontSync />)
    const listener = mocks.listeners.get(Events.SettingsChanged)

    expect(listener).toBeDefined()
    act(() => listener?.({ app: { fontFamily: 'Open Sans' } }))

    expect(
      document.documentElement.style.getPropertyValue('--app-font-family')
    ).toBe('"Open Sans", "Inter Variable", sans-serif')

    view.unmount()
    expect(transport.off).toHaveBeenCalledWith(Events.SettingsChanged, listener)
  })

  it('handles top-level vs nested fontFamily in event payloads', () => {
    render(<FontSync />)
    const listener = mocks.listeners.get(Events.SettingsChanged)

    act(() => listener?.({ fontFamily: 'JetBrains Mono' }))
    expect(
      document.documentElement.style.getPropertyValue('--app-font-family')
    ).toBe('"JetBrains Mono", "Inter Variable", sans-serif')

    // Invalid / Unrelated payloads should be ignored
    act(() => {
      listener?.(null)
      listener?.({})
      listener?.({ app: { theme: 'dark' } })
    })
    expect(
      document.documentElement.style.getPropertyValue('--app-font-family')
    ).toBe('"JetBrains Mono", "Inter Variable", sans-serif')
  })

  it('reconciles persisted settings on desktop mount', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      app: { fontFamily: 'Fira Code' },
    })

    render(<FontSync />)

    await waitFor(() => {
      expect(transport.invoke).toHaveBeenCalledWith(Queries.GetSettings)
      expect(
        document.documentElement.style.getPropertyValue('--app-font-family')
      ).toBe('"Fira Code", "Inter Variable", sans-serif')
    })

    expect(transport.onConnectionChange).not.toHaveBeenCalled()
  })

  it('reconciles settings on web connection changes', async () => {
    mocks.platform = 'web'
    vi.mocked(transport.invoke)
      .mockResolvedValueOnce({ app: { fontFamily: 'Lato' } })
      .mockResolvedValueOnce({ app: { fontFamily: 'Roboto' } })

    render(<FontSync />)

    // Connecting or disconnected states should not trigger reconciliation
    act(() => {
      mocks.connectionListener?.({ state: 'connecting' })
      mocks.connectionListener?.({ state: 'disconnected' })
    })
    expect(transport.invoke).not.toHaveBeenCalled()

    // Connected state triggers reconciliation
    act(() => mocks.connectionListener?.({ state: 'connected' }))

    await waitFor(() => {
      expect(transport.invoke).toHaveBeenCalledWith(Queries.GetSettings)
      expect(
        document.documentElement.style.getPropertyValue('--app-font-family')
      ).toBe('"Lato", "Inter Variable", sans-serif')
    })
  })

  it('prevents stale reconciliation responses from overwriting newer updates', async () => {
    mocks.platform = 'web'
    let resolveSettings: ((value: unknown) => void) | undefined
    vi.mocked(transport.invoke).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSettings = resolve
        })
    )
    render(<FontSync />)

    act(() => mocks.connectionListener?.({ state: 'connected' }))
    const listener = mocks.listeners.get(Events.SettingsChanged)
    act(() => listener?.({ app: { fontFamily: 'Comic Sans MS' } }))

    expect(
      document.documentElement.style.getPropertyValue('--app-font-family')
    ).toBe('"Comic Sans MS", "Inter Variable", sans-serif')

    await act(async () => {
      resolveSettings?.({ app: { fontFamily: 'Times New Roman' } })
      await Promise.resolve()
    })

    // Should retain Comic Sans MS because it was set by a newer generation event
    expect(
      document.documentElement.style.getPropertyValue('--app-font-family')
    ).toBe('"Comic Sans MS", "Inter Variable", sans-serif')
  })

  it('handles transport.invoke rejection gracefully', async () => {
    vi.mocked(transport.invoke).mockRejectedValueOnce(new Error('IPC Error'))

    expect(() => render(<FontSync />)).not.toThrow()
    await waitFor(() => {
      expect(transport.invoke).toHaveBeenCalledWith(Queries.GetSettings)
    })
  })
})
