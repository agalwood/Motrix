import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
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
})
