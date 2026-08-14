import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { ApplicationMenuSnapshot } from '@shared/schemas/application-menu'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  platform: 'win32' as NodeJS.Platform | 'web',
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    get platform() {
      return mocks.platform
    },
    invoke: mocks.invoke,
    on: mocks.on,
    off: mocks.off,
  },
}))

import { useApplicationMenu } from './use-application-menu'

function snapshot(
  revision: number,
  label = `Item ${revision}`
): ApplicationMenuSnapshot {
  return {
    revision,
    items: [
      {
        id: `item-${revision}`,
        type: 'normal',
        label,
        enabled: true,
        visible: true,
      },
    ],
  }
}

describe('useApplicationMenu', () => {
  beforeEach(() => {
    mocks.platform = 'win32'
    mocks.invoke.mockReset().mockResolvedValue(snapshot(1))
    mocks.on.mockReset()
    mocks.off.mockReset()
  })

  it('subscribes before loading the initial snapshot', async () => {
    renderHook(() => useApplicationMenu())

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1))
    expect(mocks.on).toHaveBeenCalledWith(
      Events.ApplicationMenuChanged,
      expect.any(Function)
    )
    expect(mocks.on.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invoke.mock.invocationCallOrder[0] ?? 0
    )
    expect(mocks.invoke).toHaveBeenCalledWith(Queries.GetApplicationMenu)
  })

  it('does not let a slow query roll an event snapshot backward', async () => {
    let resolveQuery: ((value: ApplicationMenuSnapshot) => void) | undefined
    mocks.invoke.mockReturnValue(
      new Promise<ApplicationMenuSnapshot>((resolve) => {
        resolveQuery = resolve
      })
    )

    const { result } = renderHook(() => useApplicationMenu())
    const onChanged = mocks.on.mock.calls[0]?.[1] as (
      value: ApplicationMenuSnapshot
    ) => void

    act(() => onChanged(snapshot(4, 'Newer event')))
    expect(result.current.snapshot?.revision).toBe(4)

    await act(async () => {
      resolveQuery?.(snapshot(3, 'Older query'))
      await Promise.resolve()
    })
    expect(result.current.snapshot?.revision).toBe(4)
    expect(result.current.snapshot?.items[0]?.label).toBe('Newer event')
  })

  it('ignores malformed and lower-revision change events', async () => {
    const { result } = renderHook(() => useApplicationMenu())
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1))
    const onChanged = mocks.on.mock.calls[0]?.[1] as (value: unknown) => void

    act(() => {
      onChanged(snapshot(2))
      onChanged({ revision: 99, items: [{ id: 'incomplete' }] })
      onChanged(snapshot(1))
    })

    expect(result.current.snapshot?.revision).toBe(2)
  })

  it('refreshes on demand and executes the typed request', async () => {
    const { result } = renderHook(() => useApplicationMenu())
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1))

    mocks.invoke.mockResolvedValueOnce(snapshot(2))
    await act(() => result.current.refresh())
    expect(result.current.snapshot?.revision).toBe(2)

    const request = {
      itemId: 'file.quit',
      revision: 2,
      trigger: 'menu' as const,
      selectedTaskId: null,
      modifiers: { alt: false, control: true, meta: false, shift: false },
    }
    mocks.invoke.mockResolvedValueOnce({ ok: true })
    await act(() => result.current.executeItem(request))
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      Commands.ExecuteApplicationMenuItem,
      request
    )
  })

  it('refreshes but never auto-retries an execution rejected as stale', async () => {
    const { result } = renderHook(() => useApplicationMenu())
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1))
    mocks.invoke.mockClear()

    const request = {
      itemId: 'task.delete',
      revision: 1,
      trigger: 'menu' as const,
      selectedTaskId: 'task-1',
    }
    mocks.invoke
      .mockRejectedValueOnce(new Error('Application menu snapshot is stale'))
      .mockResolvedValueOnce(snapshot(2))

    await act(() => result.current.executeItem(request))

    expect(mocks.invoke).toHaveBeenNthCalledWith(
      1,
      Commands.ExecuteApplicationMenuItem,
      request
    )
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, Queries.GetApplicationMenu)
    expect(mocks.invoke).toHaveBeenCalledTimes(2)
    expect(result.current.snapshot?.revision).toBe(2)
  })

  it('unsubscribes the same listener on cleanup', () => {
    const { unmount } = renderHook(() => useApplicationMenu())
    const listener = mocks.on.mock.calls[0]?.[1]
    unmount()
    expect(mocks.off).toHaveBeenCalledWith(
      Events.ApplicationMenuChanged,
      listener
    )
  })

  it('refreshes when the window regains focus', async () => {
    renderHook(() => useApplicationMenu())
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1))

    window.dispatchEvent(new Event('focus'))

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2))
    expect(mocks.invoke).toHaveBeenLastCalledWith(Queries.GetApplicationMenu)
  })

  it('does not subscribe or query on macOS', () => {
    mocks.platform = 'darwin'
    renderHook(() => useApplicationMenu())
    expect(transport.platform).toBe('darwin')
    expect(mocks.on).not.toHaveBeenCalled()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
