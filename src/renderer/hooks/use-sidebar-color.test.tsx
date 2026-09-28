import { refreshRendererSettings } from '@renderer/lib/settings-refresh'
import { useSidebarColorState } from '@renderer/lib/sidebar-color'
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/app-settings'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useSidebarColor } from './use-sidebar-color'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    onConnectionChange: vi.fn(() => () => {}),
  },
}))
beforeEach(() => {
  vi.clearAllMocks()
  useSidebarColorState.setState({
    saved: DEFAULT_APP_SETTINGS.sidebarColor,
    preview: null,
    revision: 0,
  })
})
it('hydrates, previews, restores, and refreshes the saved tint after reconnect', async () => {
  vi.mocked(transport.invoke).mockResolvedValue({
    app: { sidebarColor: 'pink' },
  })
  const { unmount } = renderHook(useSidebarColor)
  await waitFor(() =>
    expect(document.documentElement.dataset.sidebarColor).toBe('pink')
  )
  act(() => useSidebarColorState.setState({ preview: 'cyan' }))
  expect(document.documentElement.dataset.sidebarColor).toBe('cyan')
  vi.mocked(transport.invoke).mockResolvedValue({
    app: { sidebarColor: 'gold' },
  })
  const change = vi
    .mocked(transport.on)
    .mock.calls.find(([event]) => event === Events.SidebarColorChanged)![1]
  await act(async () => change())
  expect(document.documentElement.dataset.sidebarColor).toBe('cyan')
  act(() => useSidebarColorState.setState({ preview: null }))
  expect(document.documentElement.dataset.sidebarColor).toBe('gold')
  vi.mocked(transport.invoke).mockResolvedValue({
    app: { sidebarColor: 'green' },
  })
  await act(async () => {
    for (const [callback] of vi.mocked(transport.onConnectionChange!).mock
      .calls) {
      callback({ state: 'connected' })
    }
  })
  expect(document.documentElement.dataset.sidebarColor).toBe('green')
  unmount()
  expect(transport.off).toHaveBeenCalledWith(Events.SidebarColorChanged, change)
})
it('does not let a delayed snapshot overwrite a just-saved color', async () => {
  let resolve!: (value: unknown) => void
  vi.mocked(transport.invoke).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  renderHook(useSidebarColor)
  act(() => useSidebarColorState.setState({ saved: 'violet', revision: 1 }))
  await act(async () => resolve({ app: { sidebarColor: 'gray' } }))
  expect(document.documentElement.dataset.sidebarColor).toBe('violet')
})

it('refreshes saved colors without a host event after a local settings save', async () => {
  vi.mocked(transport.invoke).mockResolvedValue({
    app: { sidebarColor: 'gray' },
  })
  renderHook(useSidebarColor)
  await waitFor(() =>
    expect(document.documentElement.dataset.sidebarColor).toBe('gray')
  )
  vi.mocked(transport.invoke).mockResolvedValue({
    app: { sidebarColor: 'blue' },
  })
  await act(async () => refreshRendererSettings())
  expect(document.documentElement.dataset.sidebarColor).toBe('blue')
})

it('follows system accent changes in Auto and leaves manual choices independent', async () => {
  const { Queries } = await import('@shared/protocol/queries')
  let accent: string | null = '#ff0000'
  vi.mocked(transport.invoke).mockImplementation(async (channel) =>
    channel === Queries.GetSystemAccentColor
      ? accent
      : { app: { sidebarColor: 'auto' } }
  )
  renderHook(useSidebarColor)
  await waitFor(() =>
    expect(document.documentElement.dataset.sidebarColor).toBe('auto')
  )
  expect(document.documentElement.style.getPropertyValue('--sidebar-hue')).toBe(
    '0'
  )
  const refresh = vi
    .mocked(transport.on)
    .mock.calls.find(([event]) => event === Events.SystemAccentColorChanged)![1]
  accent = '#00ff00'
  await act(async () => refresh())
  expect(document.documentElement.style.getPropertyValue('--sidebar-hue')).toBe(
    '120'
  )
  act(() => useSidebarColorState.setState({ preview: 'pink' }))
  accent = '#0000ff'
  await act(async () => refresh())
  expect(document.documentElement.dataset.sidebarColor).toBe('pink')
  expect(document.documentElement.style.getPropertyValue('--sidebar-hue')).toBe(
    ''
  )
  act(() => useSidebarColorState.setState({ preview: null }))
  expect(document.documentElement.dataset.sidebarColor).toBe('auto')
  accent = null
  await act(async () => refresh())
  expect(document.documentElement.dataset.sidebarColor).toBe('gray')
})

it.each([undefined, 'unknown'])(
  'uses the cyan default for missing or invalid saved color %s',
  async (sidebarColor) => {
    vi.mocked(transport.invoke).mockResolvedValue({ app: { sidebarColor } })
    renderHook(useSidebarColor)
    await waitFor(() =>
      expect(document.documentElement.dataset.sidebarColor).toBe('cyan')
    )
  }
)
