import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { SidebarProvider } from '@renderer/components/ui/sidebar'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { NotificationsNavItem } from './notifications-nav-item'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    onConnectionChange: vi.fn(() => () => {}),
  },
}))

// jsdom 29 + Node 25 do not provide a working window.localStorage.
// SidebarProvider reads/writes SIDEBAR_STATE_KEY, so stub it here.
// matchMedia is also missing in jsdom and used by the mobile hook.
// Mirrors app-sidebar.test.tsx's setup — NotificationsNavItem renders inside
// a real SidebarMenuButton, which needs SidebarContext.
beforeAll(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => {
      store.clear()
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  })
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  )
})

function mockInvoke(count: number) {
  vi.mocked(transport.invoke).mockImplementation(async (ch: string) => {
    if (ch === Queries.ListNotifications) return []
    if (ch === Queries.GetUnreadNotificationCount) return count
    return undefined
  })
}

function renderNavItem() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <SidebarProvider>
          <NotificationsNavItem />
        </SidebarProvider>
      </TooltipProvider>
    </MemoryRouter>
  )
}

describe('<NotificationsNavItem>', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('hides the badge when the unread count is zero', async () => {
    mockInvoke(0)
    renderNavItem()
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Queries.GetUnreadNotificationCount
      )
    )
    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument()
  })

  it('countOnly: fetches the unread count but never lists notifications', async () => {
    mockInvoke(3)
    renderNavItem()
    await screen.findByTestId('notification-badge')

    expect(transport.invoke).toHaveBeenCalledWith(
      Queries.GetUnreadNotificationCount
    )
    expect(transport.invoke).not.toHaveBeenCalledWith(Queries.ListNotifications)
  })

  it('shows the exact unread count under the cap', async () => {
    mockInvoke(7)
    renderNavItem()
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent(
      '7'
    )
  })

  it('caps the badge label at 99+', async () => {
    mockInvoke(150)
    renderNavItem()
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent(
      '99+'
    )
  })

  it('announces the unread count via role=status and a translated aria-label', async () => {
    mockInvoke(3)
    renderNavItem()
    const badge = await screen.findByTestId('notification-badge')
    expect(badge).toHaveAttribute('role', 'status')
    expect(badge).toHaveAttribute('aria-label', '3 unread notifications')
  })

  it('uses the singular aria-label when the unread count is 1', async () => {
    mockInvoke(1)
    renderNavItem()
    const badge = await screen.findByTestId('notification-badge')
    expect(badge).toHaveAttribute('aria-label', '1 unread notification')
  })

  it('hides the count badge and shows a dot indicator when the sidebar collapses to icon mode', async () => {
    mockInvoke(3)
    renderNavItem()
    const badge = await screen.findByTestId('notification-badge')
    expect(badge.className).toContain('group-data-[collapsible=icon]:hidden')

    const dot = screen.getByTestId('notification-badge-dot')
    expect(dot).toHaveAttribute('aria-hidden', 'true')
    expect(dot.className).toContain('group-data-[collapsible=icon]:block')
  })

  it('does not render the dot indicator when the unread count is zero', async () => {
    mockInvoke(0)
    renderNavItem()
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Queries.GetUnreadNotificationCount
      )
    )
    expect(
      screen.queryByTestId('notification-badge-dot')
    ).not.toBeInTheDocument()
  })

  it('renders as a link to /notifications', async () => {
    mockInvoke(0)
    renderNavItem()
    const link = await screen.findByRole('link', { name: /notifications/i })
    expect(link).toHaveAttribute('href', '/notifications')
  })

  it('subscribes to NotificationsChanged only, strictly before the first snapshot invoke', async () => {
    mockInvoke(1)
    renderNavItem()
    await screen.findByTestId('notification-badge')

    const onMock = vi.mocked(transport.on)
    const invokeMock = vi.mocked(transport.invoke)
    const onCalls = onMock.mock.calls
    // `notify()` always emits NotificationAdded then NotificationsChanged;
    // mutations emit NotificationsChanged alone. Subscribing to both would
    // double every refresh, so the hook subscribes to NotificationsChanged
    // only — NotificationAdded must NOT be registered here (it remains
    // subscribed elsewhere, e.g. useNotificationToasts).
    expect(
      onCalls.filter((c) => c[0] === Events.NotificationsChanged)
    ).toHaveLength(1)
    expect(onCalls.some((c) => c[0] === Events.NotificationAdded)).toBe(false)

    // Order, not just membership (regression guard for the subscribe-then-
    // snapshot contract) — mirrors use-pair-request-prompts.test.tsx's
    // invocationCallOrder precedent: the `on()` registration must have
    // happened before the FIRST `invoke()` call (ListNotifications, the
    // hook's first snapshot query).
    const lastOnOrder = Math.max(...onMock.mock.invocationCallOrder)
    const firstInvokeOrder = invokeMock.mock.invocationCallOrder[0]
    expect(firstInvokeOrder).toBeGreaterThan(lastOnOrder)
  })

  it('does not require NotificationAdded to refresh the badge', async () => {
    mockInvoke(1)
    renderNavItem()
    await screen.findByTestId('notification-badge')

    // No NotificationAdded listener is registered at all, so firing only
    // NotificationsChanged must still drive the refetch on its own.
    const onCalls = vi.mocked(transport.on).mock.calls
    expect(onCalls.some((c) => c[0] === Events.NotificationAdded)).toBe(false)

    const countCallsBefore = vi
      .mocked(transport.invoke)
      .mock.calls.filter(
        (c) => c[0] === Queries.GetUnreadNotificationCount
      ).length

    mockInvoke(5)
    const changedListener = onCalls.find(
      (c) => c[0] === Events.NotificationsChanged
    )?.[1] as () => void
    changedListener()

    await waitFor(() =>
      expect(
        vi
          .mocked(transport.invoke)
          .mock.calls.filter((c) => c[0] === Queries.GetUnreadNotificationCount)
          .length
      ).toBeGreaterThan(countCallsBefore)
    )
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent(
      '5'
    )
  })

  it('refetches the badge on NotificationsChanged', async () => {
    mockInvoke(1)
    renderNavItem()
    await screen.findByTestId('notification-badge')

    const onCalls = vi.mocked(transport.on).mock.calls
    const countCallsBefore = vi
      .mocked(transport.invoke)
      .mock.calls.filter(
        (c) => c[0] === Queries.GetUnreadNotificationCount
      ).length

    mockInvoke(9)
    const changedListener = onCalls.find(
      (c) => c[0] === Events.NotificationsChanged
    )?.[1] as () => void
    changedListener()

    await waitFor(() =>
      expect(
        vi
          .mocked(transport.invoke)
          .mock.calls.filter((c) => c[0] === Queries.GetUnreadNotificationCount)
          .length
      ).toBeGreaterThan(countCallsBefore)
    )
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent(
      '9'
    )
  })

  it('F4: retries once after a rejected refresh and shows the badge once the retry resolves', async () => {
    vi.useFakeTimers()
    let unreadCountCalls = 0
    vi.mocked(transport.invoke).mockImplementation(async (ch: string) => {
      if (ch === Queries.ListNotifications) return []
      if (ch === Queries.GetUnreadNotificationCount) {
        unreadCountCalls += 1
        if (unreadCountCalls === 1) throw new Error('transient IPC failure')
        return 3
      }
      return undefined
    })

    renderNavItem()

    // First attempt rejects: no catch means no badge yet, and no crash.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument()
    expect(unreadCountCalls).toBe(1)

    // The bounded retry fires after the primitive's RETRY_DELAY_MS and resolves.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })

    expect(unreadCountCalls).toBe(2)
    expect(screen.getByTestId('notification-badge')).toHaveTextContent('3')
  })

  it('F7: re-snapshots on transport reconnect and on window focus', async () => {
    let count = 4
    vi.mocked(transport.invoke).mockImplementation(async (ch: string) => {
      if (ch === Queries.ListNotifications) return []
      if (ch === Queries.GetUnreadNotificationCount) return count
      return undefined
    })

    renderNavItem()
    await screen.findByTestId('notification-badge')

    const onConnectionChange = transport.onConnectionChange as NonNullable<
      typeof transport.onConnectionChange
    >
    const onConnectionChangeMock = vi.mocked(onConnectionChange)
    const connectionListener = onConnectionChangeMock.mock.calls[0]?.[0]
    expect(connectionListener).toBeDefined()

    const countCallsBeforeConnect = vi
      .mocked(transport.invoke)
      .mock.calls.filter(
        (c) => c[0] === Queries.GetUnreadNotificationCount
      ).length

    count = 7
    connectionListener?.({ state: 'connected' })

    await waitFor(() =>
      expect(
        vi
          .mocked(transport.invoke)
          .mock.calls.filter((c) => c[0] === Queries.GetUnreadNotificationCount)
          .length
      ).toBeGreaterThan(countCallsBeforeConnect)
    )
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent(
      '7'
    )

    const countCallsBeforeFocus = vi
      .mocked(transport.invoke)
      .mock.calls.filter(
        (c) => c[0] === Queries.GetUnreadNotificationCount
      ).length

    count = 11
    window.dispatchEvent(new Event('focus'))

    await waitFor(() =>
      expect(
        vi
          .mocked(transport.invoke)
          .mock.calls.filter((c) => c[0] === Queries.GetUnreadNotificationCount)
          .length
      ).toBeGreaterThan(countCallsBeforeFocus)
    )
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent(
      '11'
    )
  })
})
