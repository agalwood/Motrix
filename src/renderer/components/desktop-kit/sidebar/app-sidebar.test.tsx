import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { SidebarProvider } from '@renderer/components/ui/sidebar'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { beforeAll, describe, expect, it, vi } from 'vitest'
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

  it('keeps each navigation icon and label as direct flex items', () => {
    render(wrap(<AppSidebar />))

    for (const label of [
      'Dashboard',
      'Downloads',
      'Trackers',
      'Plugins',
      'Settings',
    ]) {
      const labelNode = screen.getByText(label)
      const menuButton = labelNode.closest('[data-slot="sidebar-menu-button"]')

      expect(menuButton).toHaveClass('flex', 'items-center', 'gap-2')
      expect(labelNode.parentElement).toBe(menuButton)
      expect(menuButton?.querySelector(':scope > svg')).toBeInTheDocument()
    }
  })

  it('matches footer item sizing and horizontal inset to the main navigation', () => {
    render(wrap(<AppSidebar />))

    const dashboard = screen
      .getByText('Dashboard')
      .closest('[data-slot="sidebar-menu-button"]')
    const notifications = screen
      .getByText('Notifications')
      .closest('[data-slot="sidebar-menu-button"]')
    const settings = screen
      .getByText('Settings')
      .closest('[data-slot="sidebar-menu-button"]')
    const mainGroup = dashboard?.closest('[data-slot="sidebar-group"]')
    const footer = settings?.closest('[data-slot="sidebar-footer"]')

    expect(mainGroup).toHaveClass('p-[2px]')
    expect(footer).toHaveClass('px-0.5')
    for (const item of [dashboard, notifications, settings]) {
      expect(item).toHaveAttribute('data-size', 'default')
      expect(item).toHaveClass(
        'h-[38px]',
        'px-2.5',
        'py-3',
        'gap-2',
        '[&>svg]:size-4'
      )
    }
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
    expect(separator).toHaveClass('mx-0', 'w-auto')

    const wrapper = separator?.parentElement
    expect(wrapper?.tagName).toBe('LI')
    expect(wrapper).toHaveClass('relative')
    expect(wrapper).toHaveAttribute('aria-hidden', 'true')
  })

  it('renders the Notifications entry as a link to /notifications', () => {
    render(wrap(<AppSidebar />))
    const link = screen.getByText('Notifications').closest('a')
    expect(link).toHaveAttribute('href', '/notifications')
  })
})
