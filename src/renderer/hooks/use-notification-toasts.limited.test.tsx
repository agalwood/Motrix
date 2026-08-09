import { Toast } from '@base-ui/react/toast'
import { toast } from '@renderer/components/ui/toast'
import { Events } from '@shared/protocol/events'
import type { AppNotification } from '@shared/types/notification'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@renderer/lib/i18n'
import { useNotificationToasts } from './use-notification-toasts'

/**
 * F9 regression coverage against the REAL Base UI toast manager + store —
 * `use-notification-toasts.test.tsx` mocks `@renderer/components/ui/toast`
 * entirely, which can only assert that `close()` then `add()` were called
 * (see its own F9 test); it cannot observe whether the resulting toast is
 * actually un-hidden. Base UI's `ToastStore.addToast` upserts a same-id
 * toast IN PLACE (no `applyLimited` recompute, no repositioning) unless the
 * existing entry is already `transitionStatus: 'ending'` — which is
 * exactly what `close()` sets immediately before `add()` runs. This file
 * mounts the hook under a real `<Toast.Provider toastManager={toast}>` and
 * reads the live store state via `Toast.useToastManager()` to prove the
 * previously-limited toast is un-hidden and moved back to the front.
 */

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

function wrapper({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider toastManager={toast} limit={5}>
      {children}
    </Toast.Provider>
  )
}

function renderProbe() {
  return renderHook(
    () => {
      useNotificationToasts()
      return Toast.useToastManager()
    },
    { wrapper }
  )
}

describe('useNotificationToasts (F9, real toast manager + store)', () => {
  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k]
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })

  afterEach(() => {
    act(() => {
      toast.close()
    })
    vi.restoreAllMocks()
  })

  it('a coalesced notification-error toast buried by a burst of 5 timeout:0 toasts re-promotes to the front and un-hides on the next error', () => {
    const { result } = renderProbe()

    // First error: creates the coalesced toast at the front.
    act(() => {
      fire(Events.NotificationAdded, notification())
    })
    expect(
      result.current.toasts.find((t) => t.id === 'notification-error')
    ).toMatchObject({ limited: false })

    // A burst of 5 persistent toasts (e.g. pairing prompts) stacks on top,
    // each one pushing the coalesced error toast one slot further back —
    // Base UI prepends every new toast to the front of the array.
    act(() => {
      for (let i = 0; i < 5; i++) {
        toast.add({ id: `filler-${i}`, title: `filler ${i}`, timeout: 0 })
      }
    })
    expect(result.current.toasts).toHaveLength(6)
    expect(
      result.current.toasts.find((t) => t.id === 'notification-error')
    ).toMatchObject({ limited: true })

    // A SECOND error: without F9's close-then-add, Base UI's same-id add()
    // would update this toast in place — still `limited: true`, still at
    // the back. With the fix, it re-promotes to the front and un-hides.
    act(() => {
      fire(
        Events.NotificationAdded,
        notification({ titleParams: { name: 'second.zip' } })
      )
    })

    expect(result.current.toasts).toHaveLength(6)
    expect(result.current.toasts[0]).toMatchObject({
      id: 'notification-error',
      limited: false,
    })
    const buriedFiller = result.current.toasts.find((t) => t.id === 'filler-0')
    expect(buriedFiller).toMatchObject({ limited: true })
  })
})
