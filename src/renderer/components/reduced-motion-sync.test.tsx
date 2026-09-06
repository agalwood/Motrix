import {
  getReducedMotion,
  setAppReduceMotion,
} from '@renderer/lib/reduced-motion'
import { transport } from '@renderer/lib/transport'
import type {
  EventListener,
  TransportConnectionListener,
} from '@renderer/lib/transport/types'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReducedMotionSync } from './reduced-motion-sync'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    onConnectionChange: vi.fn(),
  },
}))

let onMotionChanged: EventListener
let onConnectionChange: TransportConnectionListener
let systemReducedMotion = false
const systemListeners = new Set<() => void>()
const stopConnectionSync = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  systemReducedMotion = false
  systemListeners.clear()
  setAppReduceMotion(false)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return systemReducedMotion
      },
      addEventListener: (_event: string, listener: () => void) =>
        systemListeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) =>
        systemListeners.delete(listener),
    }))
  )
  vi.mocked(transport.invoke).mockResolvedValue({
    app: { reduceMotion: false },
  })
  vi.mocked(transport.on).mockImplementation((event, listener) => {
    if (event === Events.ReducedMotionChanged) onMotionChanged = listener
  })
  vi.mocked(transport.onConnectionChange!).mockImplementation((listener) => {
    onConnectionChange = listener
    return stopConnectionSync
  })
})

afterEach(() => {
  cleanup()
  setAppReduceMotion(false)
  delete document.documentElement.dataset.reducedMotion
  vi.unstubAllGlobals()
})

function expectReducedMotion(value: boolean) {
  expect(getReducedMotion()).toBe(value)
  expect(document.documentElement.dataset.reducedMotion).toBe(String(value))
}

describe('ReducedMotionSync', () => {
  it('hydrates the persisted setting and applies live changes', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      app: { reduceMotion: true },
    })
    render(<ReducedMotionSync />)
    await waitFor(() => expectReducedMotion(true))

    act(() => onMotionChanged({ reduceMotion: false }))
    expectReducedMotion(false)
    act(() => onMotionChanged({ reduceMotion: true }))
    expectReducedMotion(true)
  })

  it('subscribes before fetching and ignores an older snapshot after a live event', async () => {
    let resolveSnapshot!: (value: unknown) => void
    vi.mocked(transport.invoke).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve
        })
    )
    render(<ReducedMotionSync />)
    expect(vi.mocked(transport.on).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(transport.invoke).mock.invocationCallOrder[0]!
    )
    act(() => onMotionChanged({ reduceMotion: true }))
    await act(async () => resolveSnapshot({ app: { reduceMotion: false } }))
    expectReducedMotion(true)
  })

  it('reconciles changes missed while the web transport was disconnected', async () => {
    render(<ReducedMotionSync />)
    await waitFor(() => expectReducedMotion(false))
    vi.mocked(transport.invoke).mockResolvedValue({
      app: { reduceMotion: true },
    })

    act(() => onConnectionChange({ state: 'connected' }))
    await waitFor(() => expectReducedMotion(true))
    expect(transport.invoke).toHaveBeenLastCalledWith(Queries.GetSettings)
  })

  it('combines the app switch with live system preferences', async () => {
    render(<ReducedMotionSync />)
    await waitFor(() => expectReducedMotion(false))
    act(() => {
      systemReducedMotion = true
      for (const listener of systemListeners) listener()
    })
    expectReducedMotion(true)
    act(() => onMotionChanged({ reduceMotion: false }))
    expectReducedMotion(true)
    act(() => onMotionChanged({ reduceMotion: true }))
    act(() => {
      systemReducedMotion = false
      for (const listener of systemListeners) listener()
    })
    expectReducedMotion(true)
    act(() => onMotionChanged({ reduceMotion: false }))
    expectReducedMotion(false)
  })

  it('removes listeners and ignores a snapshot resolving after unmount', async () => {
    let resolveSnapshot!: (value: unknown) => void
    vi.mocked(transport.invoke).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve
        })
    )
    const { unmount } = render(<ReducedMotionSync />)
    unmount()
    await act(async () => resolveSnapshot({ app: { reduceMotion: true } }))
    expect(getReducedMotion()).toBe(false)
    expect(transport.off).toHaveBeenCalledWith(
      Events.ReducedMotionChanged,
      onMotionChanged
    )
    expect(stopConnectionSync).toHaveBeenCalledOnce()
    expect(systemListeners.size).toBe(0)
  })

  it('respects the system preference without querying settings during onboarding', () => {
    systemReducedMotion = true
    render(<ReducedMotionSync syncSettings={false} />)
    expectReducedMotion(true)
    expect(transport.invoke).not.toHaveBeenCalled()
  })
})
