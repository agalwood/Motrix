import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { SidebarProvider } from '@renderer/components/ui/sidebar'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { act, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppSidebar } from './app-sidebar'

// The footer's NotificationsNavItem (Task 17R) calls useNotifications(),
// which talks to the transport on mount — stub it so this render-only suite
// doesn't depend on window.motrix / a real IPC bridge.
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    off: vi.fn(),
  },
}))

beforeEach(() => {
  vi.mocked(transport.on).mockClear()
  vi.mocked(transport.invoke)
    .mockReset()
    .mockImplementation(async (channel) => {
      if (channel === Queries.GetLegacyImportNavigation)
        return { detected: false, invitationPending: false }
      return []
    })
})

// jsdom 29 + Node 25 do not provide a working window.localStorage.
// SidebarProvider reads/writes SIDEBAR_STATE_KEY, so stub it here.
// matchMedia is also missing in jsdom and used by the mobile hook.
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

function wrap(ui: ReactElement, initialEntries: string[] = ['/']) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <TooltipProvider>
        <SidebarProvider>{ui}</SidebarProvider>
      </TooltipProvider>
    </MemoryRouter>
  )
}

describe('AppSidebar', () => {
  it('keeps migration hidden when no v1 source was detected', async () => {
    render(wrap(<AppSidebar />))
    await act(async () => Promise.resolve())
    expect(screen.queryByText('Migration')).not.toBeInTheDocument()
  })

  it('keeps detected migration available after an invitation was dismissed', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (channel) =>
      channel === Queries.GetLegacyImportNavigation
        ? { detected: true, invitationPending: false }
        : []
    )
    render(wrap(<AppSidebar />, ['/migration']))
    const link = (await screen.findByText('Migration')).closest('a')
    expect(link).toHaveAttribute('href', '/migration')
    expect(link).toHaveAttribute('aria-current', 'page')
    expect(link?.querySelector('svg')).toHaveAttribute('data-icon', 'migration')
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Queries.DiscoverLegacyImport
    )
  })

  it('refreshes navigation after desktop detection without reading profile paths', async () => {
    render(wrap(<AppSidebar />))
    await act(async () => Promise.resolve())
    vi.mocked(transport.invoke).mockImplementation(async (channel) =>
      channel === Queries.GetLegacyImportNavigation
        ? { detected: true, invitationPending: true }
        : []
    )
    const handler = vi
      .mocked(transport.on)
      .mock.calls.find(
        ([event]) => event === Events.LegacyImportNavigationChanged
      )?.[1]
    expect(handler).toBeTypeOf('function')
    await act(async () => handler?.())
    expect(await screen.findByText('Migration')).toBeInTheDocument()
    expect(transport.invoke).not.toHaveBeenCalledWith(Queries.ScanLegacyImport)
  })

  it('does not display a migration entry after a failed navigation snapshot', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetLegacyImportNavigation)
        throw new Error('Discovery unavailable')
      return []
    })
    render(wrap(<AppSidebar />))
    await act(async () => Promise.resolve())
    expect(screen.queryByText('Migration')).not.toBeInTheDocument()
  })

  it('renders four nav items with localized labels', () => {
    render(wrap(<AppSidebar />))
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Downloads')).toBeInTheDocument()
    expect(screen.getByText('Trackers')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('marks the route-matched item as active', () => {
    render(wrap(<AppSidebar />, ['/trackers']))
    const trackers = screen.getByText('Trackers').closest('a')
    expect(trackers?.getAttribute('aria-current')).toBe('page')
  })

  it('renders the Notifications entry before a separator before Settings in the footer', () => {
    render(wrap(<AppSidebar />))

    const footerMenu = screen
      .getByText('Notifications')
      .closest('[data-sidebar="menu"]')
    expect(footerMenu).not.toBeNull()

    const children = Array.from(footerMenu?.children ?? [])
    const notificationsIndex = children.findIndex((el) =>
      el.textContent?.includes('Notifications')
    )
    const separatorIndex = children.findIndex(
      (el) =>
        el.getAttribute('data-sidebar') === 'separator' ||
        el.querySelector('[data-sidebar="separator"]') !== null
    )
    const settingsIndex = children.findIndex((el) =>
      el.textContent?.includes('Settings')
    )

    expect(notificationsIndex).toBeGreaterThanOrEqual(0)
    expect(separatorIndex).toBeGreaterThan(notificationsIndex)
    expect(settingsIndex).toBeGreaterThan(separatorIndex)
  })

  it('wraps the footer separator in an aria-hidden <li> so the menu <ul> has no bare div child', () => {
    render(wrap(<AppSidebar />))

    const footerMenu = screen
      .getByText('Notifications')
      .closest('[data-sidebar="menu"]')
    const separator = footerMenu?.querySelector('[data-sidebar="separator"]')
    expect(separator).not.toBeNull()

    const wrapper = separator?.parentElement
    expect(wrapper?.tagName).toBe('LI')
    expect(wrapper).toHaveAttribute('aria-hidden', 'true')
  })

  it('renders the Notifications entry as a link to /notifications', () => {
    render(wrap(<AppSidebar />))
    const link = screen.getByText('Notifications').closest('a')
    expect(link).toHaveAttribute('href', '/notifications')
  })
})
