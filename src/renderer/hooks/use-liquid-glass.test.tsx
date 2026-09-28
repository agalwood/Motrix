import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useLiquidGlass } from './use-liquid-glass'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    onConnectionChange: vi.fn(() => () => {}),
  },
}))

beforeEach(() => vi.clearAllMocks())

it('reads the saved setting and refreshes after changes and reconnects', async () => {
  vi.mocked(transport.invoke).mockResolvedValue({
    app: { liquidGlassEffect: true },
  })
  const { result, unmount } = renderHook(useLiquidGlass)
  await waitFor(() => expect(result.current).toBe(true))
  expect(transport.invoke).toHaveBeenCalledWith(Queries.GetSettings)
  const change = vi
    .mocked(transport.on)
    .mock.calls.find(([event]) => event === Events.LiquidGlassChanged)![1]
  vi.mocked(transport.invoke).mockResolvedValue({
    app: { liquidGlassEffect: false },
  })
  await act(async () => change())
  expect(result.current).toBe(false)
  vi.mocked(transport.invoke).mockResolvedValue({
    app: { liquidGlassEffect: true },
  })
  await act(async () => {
    vi.mocked(transport.onConnectionChange!).mock.calls[0][0]({
      state: 'connected',
    })
  })
  expect(result.current).toBe(true)
  unmount()
  expect(transport.off).toHaveBeenCalledWith(Events.LiquidGlassChanged, change)
})

it('does not overwrite a newer preference with a stale initial snapshot', async () => {
  let resolveInitial!: (value: unknown) => void
  vi.mocked(transport.invoke)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInitial = resolve
        })
    )
    .mockResolvedValue({ app: { liquidGlassEffect: false } })
  const { result } = renderHook(useLiquidGlass)
  const change = vi.mocked(transport.on).mock.calls[0][1]
  await act(async () => change())
  await act(async () => resolveInitial({ app: { liquidGlassEffect: true } }))
  expect(result.current).toBe(false)
})
