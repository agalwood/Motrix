import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldShowDesktopWindowControls, WindowChrome } from './window-chrome'

type IpcListener = (...args: unknown[]) => void
const ipcListeners = new Map<string, Set<IpcListener>>()

function emit(channel: string, ...args: unknown[]): void {
  for (const listener of ipcListeners.get(channel) ?? []) listener(...args)
}

beforeAll(() => {
  // stub the preload bridge read by the module on import
  vi.stubGlobal(
    'window',
    Object.assign(window, {
      motrix: {
        platform: 'darwin',
        invoke: vi.fn(),
        on: vi.fn((channel: string, listener: IpcListener) => {
          let listeners = ipcListeners.get(channel)
          if (!listeners) {
            listeners = new Set()
            ipcListeners.set(channel, listeners)
          }
          listeners.add(listener)
        }),
        off: vi.fn((channel: string, listener: IpcListener) => {
          ipcListeners.get(channel)?.delete(listener)
        }),
        getPathForFile: vi.fn(),
      },
    })
  )
})

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(
    window.motrix as NonNullable<Window['motrix']>,
    'platform',
    {
      value: platform,
      writable: true,
      configurable: true,
    }
  )
}

beforeEach(() => {
  setPlatform('darwin')
  ipcListeners.clear()
  vi.mocked(window.motrix?.invoke).mockClear()
})

describe('WindowChrome', () => {
  it('uses the macOS menu-preview env branch to expose custom controls', () => {
    expect(shouldShowDesktopWindowControls('darwin', false)).toBe(false)
    expect(shouldShowDesktopWindowControls('darwin', true)).toBe(true)
    expect(shouldShowDesktopWindowControls('win32', false)).toBe(true)
    expect(shouldShowDesktopWindowControls('linux', false)).toBe(true)
  })

  it('renders no title text in overlay variant', () => {
    render(<WindowChrome variant="overlay" title="ignored" />)
    expect(screen.queryByText('ignored')).toBeNull()
  })

  it('pins to viewport in overlay variant', () => {
    const { container } = render(<WindowChrome variant="overlay" />)
    const el = container.firstChild as HTMLElement
    expect(el.style.position).toBe('fixed')
    expect(el.style.top).toBe('0px')
    expect(el.style.left).toBe('0px')
    expect(el.style.right).toBe('0px')
  })

  it('offsets macOS actions 94 px from the left edge', () => {
    const { container } = render(<WindowChrome variant="overlay" />)

    expect((container.firstChild as HTMLElement).style.paddingLeft).toBe('94px')
  })

  it('renders the title text in titled variant', () => {
    render(<WindowChrome variant="titled" title="My Window" />)
    expect(screen.getByText('My Window')).toBeInTheDocument()
  })

  it('allows child controls to handle clicks', () => {
    const onClick = vi.fn()

    render(
      <WindowChrome variant="overlay">
        <button type="button" onClick={onClick}>
          Trigger
        </button>
      </WindowChrome>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('keeps child actions at the start by default', () => {
    const { container } = render(
      <WindowChrome variant="overlay">
        <button type="button">Trigger</button>
      </WindowChrome>
    )

    const actions = container.querySelector(
      '[data-slot="window-chrome-actions"]'
    )
    const dragRegion = container.querySelector(
      '[data-slot="window-chrome-drag-region"]'
    )
    expect(actions?.compareDocumentPosition(dragRegion as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('places end actions after the drag region and separates caption controls', () => {
    setPlatform('win32')
    const { container } = render(
      <WindowChrome variant="titled" actionsPosition="end">
        <button type="button">Trigger</button>
      </WindowChrome>
    )

    const dragRegion = container.querySelector(
      '[data-slot="window-chrome-drag-region"]'
    )
    const actions = container.querySelector(
      '[data-slot="window-chrome-actions"]'
    )
    const controls = container.querySelector(
      '[data-slot="desktop-window-controls"]'
    )
    expect(dragRegion).toHaveClass('min-w-16', 'flex-1')
    expect(dragRegion?.compareDocumentPosition(actions as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(actions?.compareDocumentPosition(controls as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(controls).toHaveClass('ms-4')
  })

  it('renders a vertically aligned no-drag leading slot before actions', () => {
    const { container } = render(
      <WindowChrome
        variant="overlay"
        leading={<button type="button">Menu</button>}
      >
        <button type="button">Action</button>
      </WindowChrome>
    )

    const leading = container.querySelector(
      '[data-slot="window-chrome-leading"]'
    )
    const actions = container.querySelector(
      '[data-slot="window-chrome-actions"]'
    )
    expect(leading).toHaveClass('app-no-drag', 'pt-3.5', 'me-1.5')
    expect(leading?.compareDocumentPosition(actions as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it.each(['linux', 'win32'] as const)(
    'aligns the %s menu-state sidebar toggle 94 px from the left edge',
    (platform) => {
      setPlatform(platform)
      const { container } = render(
        <WindowChrome
          variant="overlay"
          leading={<div className="w-[72px]">Menu</div>}
        >
          <button type="button">Toggle sidebar</button>
        </WindowChrome>
      )

      const chrome = container.firstChild as HTMLElement
      const leading = container.querySelector(
        '[data-slot="window-chrome-leading"]'
      )
      const actions = container.querySelector(
        '[data-slot="window-chrome-actions"]'
      )
      expect(chrome.style.paddingInlineStart).toBe('12px')
      expect(leading).toHaveClass('me-1.5')
      expect(actions).toHaveClass('ms-1')
    }
  )

  it.each(['linux', 'win32'] as const)(
    'keeps %s controls at the logical end for start-positioned actions',
    (platform) => {
      setPlatform(platform)
      const { container } = render(
        <WindowChrome variant="overlay">
          <button type="button">Action</button>
        </WindowChrome>
      )

      const actions = container.querySelector(
        '[data-slot="window-chrome-actions"]'
      )
      const controls = container.querySelector(
        '[data-slot="desktop-window-controls"]'
      )
      const dragRegion = container.querySelector(
        '[data-slot="window-chrome-drag-region"]'
      )
      expect(dragRegion).toHaveClass('min-w-16', 'flex-1')
      expect(controls).toHaveClass('pe-3.5', 'pt-3.5')
      expect(controls).not.toHaveClass('ms-4')
      expect((container.firstChild as HTMLElement).style.paddingInlineEnd).toBe(
        '0px'
      )
      expect(actions?.compareDocumentPosition(dragRegion as Node)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      )
      expect(dragRegion?.compareDocumentPosition(controls as Node)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      )
    }
  )

  it.each(['linux', 'win32'] as const)(
    'renders aligned 28 px %s caption hit targets with 10 px glyphs',
    (platform) => {
      setPlatform(platform)
      const { container } = render(<WindowChrome variant="overlay" />)
      const chrome = container.firstChild as HTMLElement
      const controls = container.querySelector(
        '[data-slot="desktop-window-controls"]'
      )
      expect(chrome.style.height).toBe('40px')
      expect(controls).toHaveClass('gap-2', 'pe-3.5', 'pt-3.5')
      const buttons = [
        screen.getByRole('button', { name: 'Minimize' }),
        screen.getByRole('button', { name: 'Maximize' }),
        screen.getByRole('button', { name: 'Close' }),
      ]
      for (const button of buttons) {
        expect(button).toHaveClass('size-7')
        expect(button.querySelector('svg')).toHaveClass('size-2.5')
        expect(button.querySelector('svg')).toHaveAttribute(
          'viewBox',
          '0 0 10 10'
        )
      }
      expect(
        buttons.map((button) =>
          button.querySelector('svg')?.getAttribute('data-caption-icon')
        )
      ).toEqual(['minimize', 'maximize', 'close'])
    }
  )

  it('switches the maximize action and glyph to restore with window state', () => {
    setPlatform('win32')
    render(<WindowChrome variant="overlay" />)

    expect(screen.getByRole('button', { name: 'Maximize' })).toHaveAttribute(
      'title',
      'Maximize'
    )

    act(() => {
      emit(Events.WindowMaximizedChanged, { maximized: true })
    })

    const restore = screen.getByRole('button', { name: 'Restore' })
    expect(restore).toHaveAttribute('title', 'Restore')
    expect(restore.querySelector('svg')).toHaveAttribute(
      'data-caption-icon',
      'restore'
    )
  })

  it('uses theme-aware caption colors with a readable destructive hover', () => {
    setPlatform('win32')
    render(<WindowChrome variant="overlay" />)

    const minimize = screen.getByRole('button', { name: 'Minimize' })
    const close = screen.getByRole('button', { name: 'Close' })

    expect(minimize).toHaveClass(
      'text-foreground',
      '[&>svg]:opacity-65',
      'hover:bg-accent',
      'hover:text-accent-foreground',
      'hover:[&>svg]:opacity-90',
      'dark:hover:bg-accent/50'
    )
    expect(close).toHaveClass(
      'text-foreground',
      '[&>svg]:opacity-65',
      'hover:bg-destructive',
      'hover:text-white',
      'hover:[&>svg]:opacity-100',
      'dark:hover:bg-destructive/80'
    )
    expect(close).not.toHaveClass('hover:text-destructive-foreground')
  })

  it.each(['linux', 'win32'] as const)(
    'routes %s caption controls to sender-bound window commands',
    (platform) => {
      setPlatform(platform)
      render(<WindowChrome variant="overlay" />)

      fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))
      fireEvent.click(screen.getByRole('button', { name: 'Maximize' }))
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))

      expect(window.motrix?.invoke).toHaveBeenNthCalledWith(
        1,
        Commands.MinimizeCurrentWindow
      )
      expect(window.motrix?.invoke).toHaveBeenNthCalledWith(
        2,
        Commands.ToggleMaximizeCurrentWindow
      )
      expect(window.motrix?.invoke).toHaveBeenNthCalledWith(
        3,
        Commands.CloseCurrentWindow
      )
    }
  )

  it('disables maximize for fixed-size windows', () => {
    setPlatform('win32')
    render(<WindowChrome variant="titled" maximizable={false} />)

    expect(screen.getByRole('button', { name: 'Maximize' })).toBeDisabled()
  })

  it('aligns app and caption controls on the shared compact baseline', () => {
    setPlatform('win32')
    const { container } = render(
      <WindowChrome
        variant="overlay"
        leading={<button type="button">Menu</button>}
      >
        <button type="button">Action</button>
      </WindowChrome>
    )

    expect(
      container.querySelector('[data-slot="window-chrome-leading"]')
    ).toHaveClass('pt-3.5')
    expect(
      container.querySelector('[data-slot="window-chrome-actions"]')
    ).toHaveClass('pt-3.5')
    expect(
      container.querySelector('[data-slot="desktop-window-controls"]')
    ).toHaveClass('pt-3.5')
  })
})
