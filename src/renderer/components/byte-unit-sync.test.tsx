import {
  setByteUnitSystem,
  useByteFormat,
} from '@renderer/hooks/use-byte-format'
import { transport } from '@renderer/lib/transport'
import type {
  EventListener,
  TransportConnectionListener,
} from '@renderer/lib/transport/types'
import { Events } from '@shared/protocol/events'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ByteUnitSync } from './byte-unit-sync'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    onConnectionChange: vi.fn(),
    platform: 'darwin',
  },
}))

let onChange: EventListener
let onConnectionChange: TransportConnectionListener
const stopConnectionSync = vi.fn()

function Values() {
  const { formatBytes, formatSpeed } = useByteFormat()
  return (
    <output>
      {formatBytes(1_048_576)} · {formatSpeed(1_048_576)}
    </output>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  setByteUnitSystem('decimal')
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
  Object.defineProperty(transport, 'platform', {
    value: 'darwin',
    configurable: true,
  })
  vi.mocked(transport.invoke).mockResolvedValue({
    app: { byteUnitSystem: 'binary' },
  })
  vi.mocked(transport.on).mockImplementation((event, listener) => {
    if (event === Events.ByteUnitSystemChanged) onChange = listener
  })
  vi.mocked(transport.onConnectionChange!).mockImplementation((listener) => {
    onConnectionChange = listener
    return stopConnectionSync
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setByteUnitSystem('decimal')
})

it('hydrates and updates mounted size and speed displays without a reload', async () => {
  render(
    <>
      <ByteUnitSync />
      <Values />
    </>
  )
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toBe('1.00 MiB · 1.0 MiB/s')
  )
  act(() => onChange({ byteUnitSystem: 'decimal' }))
  expect(screen.getByRole('status').textContent).toBe('1.05 MB · 1.0 MB/s')
  act(() => onChange({ byteUnitSystem: 'invalid' }))
  expect(screen.getByRole('status').textContent).toBe('1.05 MB · 1.0 MB/s')
})

it('subscribes first and ignores snapshots older than a live update', async () => {
  let resolveSnapshot!: (value: unknown) => void
  vi.mocked(transport.invoke).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveSnapshot = resolve
      })
  )
  render(
    <>
      <ByteUnitSync />
      <Values />
    </>
  )
  expect(vi.mocked(transport.on).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(transport.invoke).mock.invocationCallOrder[0]!
  )
  act(() => onChange({ byteUnitSystem: 'binary' }))
  await act(async () => resolveSnapshot({ app: { byteUnitSystem: 'decimal' } }))
  expect(screen.getByRole('status').textContent).toBe('1.00 MiB · 1.0 MiB/s')
})

it('refreshes after reconnect and removes subscriptions on unmount', async () => {
  const { unmount } = render(
    <>
      <ByteUnitSync />
      <Values />
    </>
  )
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toBe('1.00 MiB · 1.0 MiB/s')
  )
  vi.mocked(transport.invoke).mockResolvedValue({
    app: { byteUnitSystem: 'decimal' },
  })
  act(() => onConnectionChange({ state: 'connected' }))
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toBe('1.05 MB · 1.0 MB/s')
  )
  unmount()
  expect(transport.off).toHaveBeenCalledWith(
    Events.ByteUnitSystemChanged,
    onChange
  )
  expect(stopConnectionSync).toHaveBeenCalledOnce()
})

it.each([
  ['darwin', '1.05 MB · 1.0 MB/s'],
  ['win32', '1.00 MiB · 1.0 MiB/s'],
  ['linux', '1.00 MiB · 1.0 MiB/s'],
  ['web', '1.05 MB · 1.0 MB/s'],
] as const)('hydrates system defaults on %s', async (platform, expected) => {
  Object.defineProperty(transport, 'platform', {
    value: platform,
    configurable: true,
  })
  vi.mocked(transport.invoke).mockResolvedValue({
    app: { byteUnitSystem: 'system' },
  })
  render(
    <>
      <ByteUnitSync />
      <Values />
    </>
  )
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toBe(expected)
  )
})
