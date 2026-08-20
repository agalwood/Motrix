import '@testing-library/jest-dom/vitest'
import { SidebarProvider } from '@renderer/components/ui/sidebar'
import { fireEvent, render, screen } from '@testing-library/react'
import { Plus } from 'lucide-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeaderActionButton } from './header-action-button'

function stubCompactEnvironment() {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => store.clear(),
  })
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  )
}

describe('HeaderActionButton', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the label inline in the full header', () => {
    const onClick = vi.fn()
    render(
      <HeaderActionButton label="Install" onClick={onClick}>
        <Plus aria-hidden />
      </HeaderActionButton>
    )

    const button = screen.getByRole('button', { name: 'Install' })
    expect(button).toHaveTextContent('Install')
    expect(button).not.toHaveClass('h-7')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('supports shorter visible copy without weakening the accessible name', () => {
    render(
      <HeaderActionButton
        label="Presets: Custom"
        visibleLabel="Custom"
        onClick={() => {}}
      >
        <Plus aria-hidden />
      </HeaderActionButton>
    )

    const button = screen.getByRole('button', { name: 'Presets: Custom' })
    expect(button).toHaveTextContent('Custom')
    expect(button).not.toHaveTextContent('Presets:')
  })

  it('lets wrapTrigger wrap the button while keeping its chrome', () => {
    render(
      <HeaderActionButton
        label="Add"
        wrapTrigger={(button) => <div data-testid="trigger-slot">{button}</div>}
      >
        <Plus aria-hidden />
      </HeaderActionButton>
    )

    const button = screen.getByRole('button', { name: 'Add' })
    expect(screen.getByTestId('trigger-slot')).toContainElement(button)
    expect(button).toHaveTextContent('Add')
  })

  it('keeps a 16px icon in a 28px target on the collapsed header centerline', () => {
    stubCompactEnvironment()
    render(
      <SidebarProvider defaultOpen={false}>
        <HeaderActionButton label="Install" onClick={() => {}}>
          <Plus aria-hidden />
        </HeaderActionButton>
      </SidebarProvider>
    )

    const button = screen.getByRole('button', { name: 'Install' })
    expect(button).toHaveClass(
      'size-7',
      'p-0',
      '[&>svg]:size-4',
      '[&>svg]:opacity-50',
      'hover:[&>svg]:opacity-75'
    )
    expect(button).not.toHaveClass('[&>svg]:translate-y-0.5')
    expect(button).not.toHaveTextContent('Install')
  })
})
