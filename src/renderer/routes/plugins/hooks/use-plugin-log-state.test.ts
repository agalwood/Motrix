import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePluginLogState } from './use-plugin-log-state'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@renderer/lib/transport', () => ({ transport: { invoke } }))

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('plugin diagnostic state', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    invoke.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('restores the host state on remount and stops displaying verbose at expiry', async () => {
    invoke.mockResolvedValue({ verbose: true, expiresAt: 11_000 })
    const first = renderHook(() => usePluginLogState('alice.demo'))
    await flush()
    expect(first.result.current.verbose).toBe(true)
    first.unmount()
    const second = renderHook(() => usePluginLogState('alice.demo'))
    await flush()
    expect(second.result.current.verbose).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(second.result.current.verbose).toBe(false)
    expect(invoke).not.toHaveBeenCalledWith(
      Commands.SetPluginLogVerbose,
      expect.anything()
    )
    second.unmount()
  })

  it('keeps the switch off on a failed enable and allows a retry', async () => {
    invoke.mockImplementation((channel) =>
      channel === Queries.GetPluginLogState
        ? Promise.resolve({ verbose: false, expiresAt: null })
        : Promise.reject(new Error('offline'))
    )
    const { result, unmount } = renderHook(() =>
      usePluginLogState('alice.demo')
    )
    await flush()
    await act(async () => {
      await result.current.setVerbose(true)
    })
    expect(result.current.verbose).toBe(false)
    expect(result.current.pending).toBe(false)
    invoke.mockResolvedValue({ verbose: true, expiresAt: 3_610_000 })
    await act(async () => {
      await result.current.setVerbose(true)
    })
    expect(result.current.verbose).toBe(true)
    unmount()
  })

  it('ignores a stale snapshot after a successful toggle', async () => {
    let resolve!: (value: unknown) => void
    invoke.mockImplementation((channel) =>
      channel === Queries.GetPluginLogState
        ? new Promise((done) => {
            resolve = done
          })
        : Promise.resolve({ verbose: true, expiresAt: 3_610_000 })
    )
    const { result, unmount } = renderHook(() =>
      usePluginLogState('alice.demo')
    )
    await act(async () => {
      await result.current.setVerbose(true)
    })
    await act(async () => {
      resolve({ verbose: false, expiresAt: null })
    })
    expect(result.current.verbose).toBe(true)
    unmount()
  })

  it('does not show another plugin’s state after navigation', async () => {
    let resolve!: (value: unknown) => void
    invoke.mockImplementation((_channel, { pluginId }) =>
      pluginId === 'alice.demo'
        ? new Promise((done) => {
            resolve = done
          })
        : Promise.resolve({ verbose: false, expiresAt: null })
    )
    const { result, rerender, unmount } = renderHook(
      ({ pluginId }) => usePluginLogState(pluginId),
      { initialProps: { pluginId: 'alice.demo' } }
    )
    rerender({ pluginId: 'bob.demo' })
    await flush()
    await act(async () => {
      resolve({ verbose: true, expiresAt: 3_610_000 })
    })
    expect(result.current.verbose).toBe(false)
    unmount()
  })
})
