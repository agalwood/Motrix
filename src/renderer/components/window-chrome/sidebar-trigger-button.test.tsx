import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { SidebarProvider } from '@renderer/components/ui/sidebar'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarTriggerButton } from './sidebar-trigger-button'

function renderWithProviders() {
  return render(
    <TooltipProvider>
      <SidebarProvider>
        <SidebarTriggerButton />
      </SidebarProvider>
    </TooltipProvider>
  )
}

describe('SidebarTriggerButton', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
      clear: () => store.clear(),
    })
    vi.stubGlobal('innerWidth', 1024)
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    )
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
  })

  afterEach(() => vi.unstubAllGlobals())

  it('toggles the sidebar when clicked', () => {
    const { container } = renderWithProviders()
    const wrapper = container.querySelector('[data-slot="sidebar-wrapper"]')
    const trigger = screen.getByRole('button', { name: /toggle sidebar/i })

    expect(wrapper).toHaveAttribute('data-state', 'expanded')
    fireEvent.click(trigger)
    expect(wrapper).toHaveAttribute('data-state', 'collapsed')
  })

  it('shows the localized tooltip', async () => {
    const user = userEvent.setup()
    renderWithProviders()

    await user.hover(screen.getByRole('button', { name: /toggle sidebar/i }))

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Toggle sidebar'
    )
  })

  it('shares the window-chrome icon opacity treatment', () => {
    renderWithProviders()
    expect(screen.getByRole('button', { name: /toggle sidebar/i })).toHaveClass(
      '[&>svg]:opacity-65',
      'hover:[&>svg]:opacity-90',
      'focus-visible:[&>svg]:opacity-90'
    )
  })
})
