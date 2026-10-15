import { transport } from '@renderer/lib/transport'
import { Queries } from '@shared/protocol/queries'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  STARTUP_STATUS_TIMEOUT_MS,
  useAutoLaunchStatus,
} from './use-auto-launch-status'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn() },
}))

afterEach(() => {
  vi.useRealTimers()
  vi.mocked(transport.invoke).mockReset()
})

describe('Windows startup authority observation', () => {
  it('discards older replies and observations from a closed dialog', async () => {
    const replies: Array<(value: unknown) => void> = []
    vi.mocked(transport.invoke).mockImplementation(
      () => new Promise((resolve) => replies.push(resolve))
    )
    const { result, rerender } = renderHook(
      ({ active }) => useAutoLaunchStatus(active),
      { initialProps: { active: true } }
    )
    await waitFor(() => expect(replies).toHaveLength(1))
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(replies).toHaveLength(2))
    await act(async () => replies[1]({ authority: 'application' }))
    expect(result.current.status).toEqual({ authority: 'application' })
    await act(async () => replies[0]({ authority: 'unsupported' }))
    expect(result.current.status).toEqual({ authority: 'application' })

    let opened!: Promise<void>
    act(() => {
      opened = result.current.openSettings()
    })
    await waitFor(() => expect(replies).toHaveLength(3))
    rerender({ active: false })
    await act(async () => {
      replies[2]({ ok: false })
      await opened
    })
    expect(result.current.openFailed).toBe(false)
  })

  it('bounds a missing reply and allows a new query without accepting late data', async () => {
    vi.useFakeTimers()
    let late!: (value: unknown) => void
    vi.mocked(transport.invoke)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            late = resolve
          })
      )
      .mockResolvedValue({ authority: 'application' })
    const { result } = renderHook(() => useAutoLaunchStatus(true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_STATUS_TIMEOUT_MS)
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.status).toBeNull()
    await act(async () => result.current.refresh())
    expect(result.current.status).toEqual({ authority: 'application' })
    await act(async () => late({ authority: 'unsupported' }))
    expect(result.current.status).toEqual({ authority: 'application' })
    expect(transport.invoke).toHaveBeenCalledTimes(2)
    expect(transport.invoke).toHaveBeenCalledWith(Queries.GetAutoLaunchStatus)
  })
})
