import '@renderer/lib/i18n'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { EngineFailureReason, EngineState } from '@shared/types/engine'
import type { AppNotification } from '@shared/types/notification'
import { NotificationKinds } from '@shared/types/notification'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotificationToasts } from './use-notification-toasts'

const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}

const { transportInvokeMock } = vi.hoisted(() => ({
  transportInvokeMock: vi.fn(),
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    on: vi.fn((ch: string, cb: (...args: unknown[]) => void) => {
      listeners[ch] = listeners[ch] ?? []
      listeners[ch].push(cb)
    }),
    off: vi.fn((ch: string, cb: (...args: unknown[]) => void) => {
      listeners[ch] = (listeners[ch] ?? []).filter((l) => l !== cb)
    }),
    invoke: transportInvokeMock,
  },
}))

const { toastAddMock, toastCloseMock } = vi.hoisted(() => ({
  toastAddMock: vi.fn(),
  toastCloseMock: vi.fn(),
}))
vi.mock('@renderer/components/ui/toast', () => ({
  toast: { add: toastAddMock, close: toastCloseMock },
}))

const { requestEngineDiagnosticsMock } = vi.hoisted(() => ({
  requestEngineDiagnosticsMock: vi.fn(),
}))
vi.mock('@renderer/features/engine-diagnostics/controller', () => ({
  ENGINE_FAILURE_TOAST_ID: 'engine-start-failed',
  requestEngineDiagnostics: requestEngineDiagnosticsMock,
}))

function fire(channel: string, payload: unknown) {
  for (const l of listeners[channel] ?? []) l(payload)
}

function notification(
  overrides: Partial<AppNotification> = {}
): AppNotification {
  return {
    id: 'n1',
    sourceKey: 'src1',
    kind: 'task-error',
    severity: 'error',
    titleKey: 'notification.taskError.title',
    titleParams: { name: 'file.zip' },
    bodyKey: null,
    bodyParams: null,
    taskId: 't1',
    createdAt: Date.now(),
    readAt: null,
    ...overrides,
  }
}

describe('useNotificationToasts', () => {
  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k]
    toastAddMock.mockReset()
    toastCloseMock.mockReset()
    requestEngineDiagnosticsMock.mockReset()
    transportInvokeMock.mockReset()
    // Default mount-time GetEngineStatus query resolves to a healthy
    // engine so bullet 3's one-shot query is a no-op for every test that
    // isn't specifically exercising it.
    transportInvokeMock.mockResolvedValue({
      state: EngineState.Ready,
      failure: null,
    })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('subscribes to Events.NotificationAdded on mount', () => {
    renderHook(() => useNotificationToasts())
    expect(listeners[Events.NotificationAdded]).toHaveLength(1)
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useNotificationToasts())
    expect(listeners[Events.NotificationAdded]).toHaveLength(1)
    unmount()
    expect(listeners[Events.NotificationAdded]).toHaveLength(0)
  })

  it('error + focused document: toasts with the translated title', () => {
    renderHook(() => useNotificationToasts())

    act(() => {
      fire(Events.NotificationAdded, notification())
    })

    expect(toastAddMock).toHaveBeenCalledTimes(1)
    expect(toastAddMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'notification-error',
        title: 'file.zip failed',
        description: undefined,
        type: 'error',
      })
    )
  })

  it('F9: close(FOCUSED_ERROR_TOAST_ID) runs immediately before add() so a coalesced-but-limited toast re-promotes', () => {
    renderHook(() => useNotificationToasts())

    act(() => {
      fire(Events.NotificationAdded, notification())
    })

    expect(toastCloseMock).toHaveBeenCalledTimes(1)
    expect(toastCloseMock).toHaveBeenCalledWith('notification-error')
    expect(toastAddMock).toHaveBeenCalledTimes(1)
    // Order matters: close() must run before add() for Base UI's
    // remove-then-reinsert path (which recomputes `limited`) to fire —
    // calling them in the other order would upsert-in-place instead.
    const closeOrder = toastCloseMock.mock.invocationCallOrder[0]
    const addOrder = toastAddMock.mock.invocationCallOrder[0]
    expect(closeOrder).toBeLessThan(addOrder)
  })

  it('a burst of 3 simultaneous errors upserts through one stable toast id, latest title shown', () => {
    renderHook(() => useNotificationToasts())

    act(() => {
      fire(
        Events.NotificationAdded,
        notification({ titleParams: { name: 'a.zip' } })
      )
      fire(
        Events.NotificationAdded,
        notification({ titleParams: { name: 'b.zip' } })
      )
      fire(
        Events.NotificationAdded,
        notification({ titleParams: { name: 'c.zip' } })
      )
    })

    expect(toastAddMock).toHaveBeenCalledTimes(3)
    const ids = new Set(toastAddMock.mock.calls.map((call) => call[0].id))
    expect(ids).toEqual(new Set(['notification-error']))
    expect(toastAddMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'notification-error',
        title: 'c.zip failed',
      })
    )
  })

  it('error + hidden document: no toast (the OS bridge track owns this case)', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    renderHook(() => useNotificationToasts())

    act(() => {
      fire(Events.NotificationAdded, notification())
    })

    expect(toastAddMock).not.toHaveBeenCalled()
  })

  it('error + visible but unfocused window: no toast', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    renderHook(() => useNotificationToasts())

    act(() => {
      fire(Events.NotificationAdded, notification())
    })

    expect(toastAddMock).not.toHaveBeenCalled()
  })

  it('non-error severity never toasts, even when focused', () => {
    renderHook(() => useNotificationToasts())

    act(() => {
      fire(
        Events.NotificationAdded,
        notification({
          severity: 'info',
          kind: 'task-complete',
          titleKey: 'notification.taskComplete.title',
        })
      )
      fire(
        Events.NotificationAdded,
        notification({ severity: 'warning', kind: 'engine-failure' })
      )
    })

    expect(toastAddMock).not.toHaveBeenCalled()
  })

  it('surfaces the engine compatibility notification as a warning toast', () => {
    renderHook(() => useNotificationToasts())

    act(() => {
      fire(
        Events.NotificationAdded,
        notification({
          severity: 'warning',
          kind: NotificationKinds.EngineCompatibility,
          titleKey: 'notification.engineCompatibility.title',
          titleParams: null,
          bodyKey: 'notification.engineCompatibility.body',
          bodyParams: { version: '1.37.0', limit: '16' },
          taskId: null,
        })
      )
    })

    expect(toastAddMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'notification-error',
        title: 'Non-Motrix aria2 detected',
        description:
          'aria2 1.37.0 is not the Motrix fork. Connection settings are limited to at most 16, and SQLite history persistence is unavailable. Restore the bundled aria2_motrix engine for full support.',
        type: 'warning',
      })
    )
  })

  it('bullet 1: kind engine-failure toasts the STICKY variant via close-then-add, with no foreground gate', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    renderHook(() => useNotificationToasts())

    act(() => {
      fire(
        Events.NotificationAdded,
        notification({
          severity: 'error',
          kind: 'engine-failure',
          titleKey: 'notification.engineFailure.title',
          titleParams: null,
        })
      )
    })

    // No foreground gate for this kind — it toasts even while hidden.
    expect(toastCloseMock).toHaveBeenCalledWith('engine-start-failed')
    expect(toastAddMock).toHaveBeenCalledTimes(1)
    const call = toastAddMock.mock.calls[0][0]
    expect(call).toMatchObject({
      id: 'engine-start-failed',
      type: 'error',
      timeout: 0,
    })
    expect(call.actionProps).toBeTruthy()
    expect(call.actionProps.children).toBe('Diagnose')

    // Never coalesces with the generic FOCUSED_ERROR_TOAST_ID.
    expect(toastAddMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'notification-error' })
    )
  })

  it("bullet 1: the sticky toast's action button closes itself and requests diagnostics", () => {
    renderHook(() => useNotificationToasts())

    act(() => {
      fire(
        Events.NotificationAdded,
        notification({ severity: 'error', kind: 'engine-failure' })
      )
    })

    const call = toastAddMock.mock.calls[0][0]
    toastCloseMock.mockClear()
    call.actionProps.onClick()

    expect(toastCloseMock).toHaveBeenCalledWith('engine-start-failed')
    expect(requestEngineDiagnosticsMock).toHaveBeenCalledTimes(1)
  })

  it('bullet 2: EngineStateChanged Ready closes the sticky engine-failure toast', () => {
    renderHook(() => useNotificationToasts())

    act(() => {
      fire(Events.EngineStateChanged, EngineState.Ready)
    })

    expect(toastCloseMock).toHaveBeenCalledWith('engine-start-failed')
  })

  it('bullet 2: EngineStateChanged Restarting/Failed do NOT close the sticky toast (survives a restart storm)', () => {
    renderHook(() => useNotificationToasts())
    toastCloseMock.mockClear()

    act(() => {
      fire(Events.EngineStateChanged, EngineState.Restarting)
      fire(Events.EngineStateChanged, EngineState.Failed)
      fire(Events.EngineStateChanged, EngineState.Starting)
    })

    expect(toastCloseMock).not.toHaveBeenCalledWith('engine-start-failed')
  })

  it('bullet 3: mount with the engine already Failed shows the sticky toast from a one-shot GetEngineStatus query', async () => {
    transportInvokeMock.mockResolvedValue({
      state: EngineState.Failed,
      failure: {
        reason: EngineFailureReason.PortInUse,
        occurredAt: 1,
        technicalMessage: null,
      },
    })

    await act(async () => {
      renderHook(() => useNotificationToasts())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(transportInvokeMock).toHaveBeenCalledWith(Queries.GetEngineStatus)
    expect(transportInvokeMock).toHaveBeenCalledTimes(1)
    expect(toastAddMock).toHaveBeenCalledTimes(1)
    expect(toastAddMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'engine-start-failed',
        title: 'aria2 engine could not start',
        description:
          'Motrix’s RPC port is occupied, so aria2 engine could not start.',
        type: 'error',
        timeout: 0,
      })
    )
  })

  it('bullet 3: mount with a healthy engine shows no sticky toast', async () => {
    transportInvokeMock.mockResolvedValue({
      state: EngineState.Ready,
      failure: null,
    })

    await act(async () => {
      renderHook(() => useNotificationToasts())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(toastAddMock).not.toHaveBeenCalled()
  })

  it('bullet 3: a rejected GetEngineStatus query is swallowed (no throw, no toast)', async () => {
    transportInvokeMock.mockRejectedValue(new Error('transport not ready'))

    await expect(
      act(async () => {
        renderHook(() => useNotificationToasts())
        await Promise.resolve()
        await Promise.resolve()
      })
    ).resolves.not.toThrow()

    expect(toastAddMock).not.toHaveBeenCalled()
  })

  it('unknown titleKey AND bodyKey both fall back to the raw key', () => {
    renderHook(() => useNotificationToasts())

    act(() => {
      fire(
        Events.NotificationAdded,
        notification({
          titleKey: 'notification.totallyUnknownTitleKey',
          titleParams: null,
          bodyKey: 'notification.totallyUnknownBodyKey',
          bodyParams: null,
        })
      )
    })

    expect(toastAddMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'notification.totallyUnknownTitleKey',
        description: 'notification.totallyUnknownBodyKey',
        type: 'error',
      })
    )
  })

  it('a known bodyKey resolves to its translation', () => {
    renderHook(() => useNotificationToasts())

    act(() => {
      fire(
        Events.NotificationAdded,
        notification({
          bodyKey: 'task.error.reason.networkError',
          bodyParams: null,
        })
      )
    })

    expect(toastAddMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'file.zip failed',
        description: 'Network connection failed',
        type: 'error',
      })
    )
  })
})
