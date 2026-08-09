import '@renderer/lib/i18n'
import { Events } from '@shared/protocol/events'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useToastEvents } from './use-toast-events'

const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    on: vi.fn((ch: string, cb: (...args: unknown[]) => void) => {
      listeners[ch] = listeners[ch] ?? []
      listeners[ch].push(cb)
    }),
    off: vi.fn((ch: string, cb: (...args: unknown[]) => void) => {
      listeners[ch] = (listeners[ch] ?? []).filter((l) => l !== cb)
    }),
  },
}))

const { toastAddMock } = vi.hoisted(() => ({ toastAddMock: vi.fn() }))
vi.mock('@renderer/components/ui/toast', () => ({
  toast: { add: toastAddMock, close: vi.fn() },
}))

function fire(channel: string, payload: unknown) {
  for (const l of listeners[channel] ?? []) l(payload)
}

describe('useToastEvents', () => {
  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k]
    toastAddMock.mockReset()
  })

  it('subscribes to Events.ToastShow on mount', () => {
    renderHook(() => useToastEvents())
    expect(listeners[Events.ToastShow]).toHaveLength(1)
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useToastEvents())
    expect(listeners[Events.ToastShow]).toHaveLength(1)
    unmount()
    expect(listeners[Events.ToastShow]).toHaveLength(0)
  })

  it('resolves the i18n key and interpolates params before calling toast.add', () => {
    renderHook(() => useToastEvents())

    act(() => {
      fire(Events.ToastShow, {
        key: 'task.remove.orphanToast',
        params: { path: '/downloads/foo.mp4.motrix' },
      })
    })

    expect(toastAddMock).toHaveBeenCalledTimes(1)
    expect(toastAddMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Task removed. Files kept at /downloads/foo.mp4.motrix.',
        type: 'info',
      })
    )
  })

  it('accepts payloads without params', () => {
    renderHook(() => useToastEvents())

    act(() => {
      fire(Events.ToastShow, { key: 'task.remove.title' })
    })

    expect(toastAddMock).toHaveBeenCalledTimes(1)
    expect(toastAddMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Remove task?', type: 'info' })
    )
  })

  it('ignores malformed payloads silently', () => {
    renderHook(() => useToastEvents())

    act(() => {
      fire(Events.ToastShow, { garbage: true })
      fire(Events.ToastShow, null)
      fire(Events.ToastShow, 'nope')
    })

    expect(toastAddMock).not.toHaveBeenCalled()
  })
})
