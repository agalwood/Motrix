import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { Commands } from '@shared/protocol/commands'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowChrome } from './window-chrome'

beforeAll(() => {
  // stub the preload bridge read by the module on import
  vi.stubGlobal(
    'window',
    Object.assign(window, {
      motrix: { platform: 'darwin', invoke: vi.fn() },
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
  vi.mocked(window.motrix?.invoke).mockClear()
})

describe('WindowChrome', () => {
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

    expect(
      container.querySelector('[data-slot="window-chrome-actions"]')
    ).not.toHaveClass('ml-auto')
  })

  it('supports explicitly right-aligned child actions', () => {
    const { container } = render(
      <WindowChrome variant="titled" actionsPosition="end">
        <button type="button">Trigger</button>
      </WindowChrome>
    )

    expect(
      container.querySelector('[data-slot="window-chrome-actions"]')
    ).toHaveClass('ml-auto')
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
    expect(leading).toHaveClass('app-no-drag', 'pt-3.5', 'mr-1.5')
    expect(leading?.compareDocumentPosition(actions as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('keeps Linux controls trailing for start-positioned actions', () => {
    setPlatform('linux')
    const { container } = render(
      <WindowChrome variant="overlay">
        <button type="button">Action</button>
      </WindowChrome>
    )

    const actions = container.querySelector(
      '[data-slot="window-chrome-actions"]'
    )
    const controls = container.querySelector('.window-controls')
    expect(controls).toHaveClass('ml-auto')
    expect(actions?.compareDocumentPosition(controls as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('uses the theme foreground color for Linux caption controls', () => {
    setPlatform('linux')
    render(<WindowChrome variant="overlay" />)

    const minimize = screen.getByRole('button', { name: 'Minimize' })
    const close = screen.getByRole('button', { name: 'Close' })

    expect(minimize).toHaveStyle({ color: 'var(--color-foreground)' })
    expect(close).toHaveStyle({ color: 'var(--color-foreground)' })
  })

  it('routes Linux caption controls to sender-bound window commands', () => {
    setPlatform('linux')
    render(<WindowChrome variant="overlay" />)

    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(window.motrix?.invoke).toHaveBeenNthCalledWith(
      1,
      Commands.MinimizeCurrentWindow
    )
    expect(window.motrix?.invoke).toHaveBeenNthCalledWith(
      2,
      Commands.CloseCurrentWindow
    )
  })

  it('always reserves the Windows caption-button area', () => {
    setPlatform('win32')
    const { container } = render(<WindowChrome variant="overlay" />)
    expect((container.firstChild as HTMLElement).style.paddingRight).toBe(
      '148px'
    )
  })
})
