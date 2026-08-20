import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppLayout } from './app-layout'

function setWindowWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    value: width,
    writable: true,
    configurable: true,
  })
}

function renderAppLayout(routeHandle?: Record<string, unknown>) {
  // AppLayout uses useMatches() which only works under a data router.
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AppLayout />,
        children: [
          { index: true, element: <div>INDEX_PAGE</div>, handle: routeHandle },
        ],
      },
    ],
    { initialEntries: ['/'] }
  )
  render(<RouterProvider router={router} />)
}

beforeEach(() => {
  vi.stubGlobal(
    'window',
    Object.assign(window, {
      motrix: {
        platform: 'darwin',
        invoke: vi.fn().mockResolvedValue({}),
        on: vi.fn().mockReturnValue(() => {}),
        off: vi.fn(),
      },
    })
  )

  // jsdom 29 gap — SidebarProvider reads localStorage on mount
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    },
    writable: true,
  })

  // useIsMobile reads innerWidth — reset to desktop width so the
  // mobile-mode test's override doesn't leak into other tests
  setWindowWidth(1024)

  // jsdom 29 gap — useIsMobile reads matchMedia
  Object.defineProperty(window, 'matchMedia', {
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
    writable: true,
  })

  // Radix components (inside shadcn Sidebar) use ResizeObserver
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

describe('AppLayout', () => {
  it('renders the renderer application menu in the Windows leading slot', async () => {
    Object.defineProperty(window.motrix, 'platform', {
      value: 'win32',
      configurable: true,
    })
    await act(async () => {
      renderAppLayout()
      await Promise.resolve()
    })

    const trigger = screen.getByRole('button', { name: 'Motrix' })
    expect(trigger).toHaveAttribute('data-slot', 'motrix-menu-trigger')
    expect(
      trigger.closest('[data-slot="window-chrome-leading"]')
    ).not.toBeNull()
    expect(document.querySelector('[data-slot="sidebar-wrapper"]')).toHaveClass(
      'electron-window-chrome'
    )
    expect(
      document.querySelector('[data-slot="desktop-window-controls"]')
    ).not.toBeNull()
    expect(
      document.querySelector('[data-slot="sidebar-inset"]')
    ).not.toHaveAttribute('style')
  })

  it('keeps Electron chrome safe-area overrides out of the web target', () => {
    vi.stubGlobal('__MOTRIX_TARGET__', 'web')

    renderAppLayout()

    expect(
      document.querySelector('[data-slot="sidebar-wrapper"]')
    ).not.toHaveClass('electron-window-chrome')
    vi.stubGlobal('__MOTRIX_TARGET__', 'electron')
  })

  it('keeps chrome actions and the drag region available after collapsing the sidebar', async () => {
    Object.defineProperty(window.motrix, 'platform', {
      value: 'win32',
      configurable: true,
    })
    await act(async () => {
      renderAppLayout()
      await Promise.resolve()
    })

    const wrapper = document.querySelector('[data-slot="sidebar-wrapper"]')
    expect(wrapper).toHaveAttribute('data-state', 'expanded')

    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))

    expect(wrapper).toHaveAttribute('data-state', 'collapsed')
    expect(
      document.querySelector('[data-slot="window-chrome-leading"]')
    ).not.toBeNull()
    expect(
      document.querySelector('[data-slot="window-chrome-actions"]')
    ).not.toBeNull()
    expect(
      document.querySelector('[data-slot="window-chrome-drag-region"]')
    ).toHaveClass('min-w-16', 'flex-1')
    expect(
      document.querySelector('[data-slot="desktop-window-controls"]')
    ).not.toBeNull()
  })

  it('keeps the sidebar-wrapper background in mobile mode', () => {
    // Below the 768px breakpoint the Sidebar renders as a portaled Sheet
    // without data-variant="inset", so the wrapper's conditional
    // `has-data-[variant=inset]:bg-sidebar` never matches. The wrapper
    // must carry an unconditional bg-sidebar or transparent-inset pages
    // (Dashboard) lose their background contrast.
    setWindowWidth(500)
    renderAppLayout()
    const wrapper = document.querySelector('[data-slot="sidebar-wrapper"]')
    expect(wrapper).toHaveClass('bg-sidebar')
  })

  it('reports data-state=collapsed in mobile mode regardless of open flag', () => {
    // Below the md breakpoint the docked sidebar cannot be visible, so the
    // wrapper must report collapsed even when the desktop `open` flag is
    // still true. Compact-header styles key off
    // group-data-[state=collapsed]/sidebar-wrapper and must fire on both
    // paths: "collapse then shrink" and "shrink while expanded".
    setWindowWidth(500)
    renderAppLayout()
    const wrapper = document.querySelector('[data-slot="sidebar-wrapper"]')
    expect(wrapper).toHaveAttribute('data-state', 'collapsed')
  })

  it('keeps the inset card look below the md breakpoint', () => {
    // Upstream shadcn gates m-2/rounded-xl/shadow-sm behind
    // md:peer-data-[variant=inset]:, which both stops matching below
    // 768px (the peer div is not rendered in mobile mode). We want the
    // rounded card to survive at narrow widths, so the classes must be
    // unconditional.
    setWindowWidth(500)
    renderAppLayout()
    const inset = document.querySelector('[data-slot="sidebar-inset"]')
    expect(inset).toHaveClass('m-2', 'rounded-xl', 'shadow-sm')
  })

  it('leaves no shadow-producing class on a transparentInset route', () => {
    // The built-in SidebarInset shadow is md:peer-data-[variant=inset]:
    // shadow-sm. tailwind-merge only collapses classes with identical
    // modifiers, so the transparent branch must suppress BOTH the
    // unconditional shadow-sm and the md-variant one — a bare shadow-none
    // leaves the built-in variant alive at desktop widths.
    renderAppLayout({ transparentInset: true })
    const inset = document.querySelector('[data-slot="sidebar-inset"]')
    expect(inset?.className).not.toMatch(/shadow-sm/)
    expect(inset).toHaveClass('bg-transparent')
  })

  it('renders the sidebar and the current route outlet', () => {
    renderAppLayout()
    // Sidebar nav items
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
    // Outlet rendered
    expect(screen.getByText('INDEX_PAGE')).toBeInTheDocument()
  })
})
