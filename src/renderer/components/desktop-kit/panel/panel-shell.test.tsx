import '@testing-library/jest-dom/vitest'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PanelShell } from './panel-shell'

describe('PanelShell', () => {
  it('renders title and children', () => {
    render(
      <PanelShell title="Trackers">
        <div>body</div>
      </PanelShell>
    )
    expect(screen.getByText('Trackers')).toBeInTheDocument()
    expect(screen.getByText('body')).toBeInTheDocument()
  })

  it('renders a search input when search prop is provided', () => {
    render(
      <PanelShell
        title="X"
        search={{ value: '', onChange: () => {}, placeholder: 'Filter…' }}
      >
        <div />
      </PanelShell>
    )
    expect(screen.getByPlaceholderText('Filter…')).toBeInTheDocument()
  })

  it('keeps the search input on the compact row height', () => {
    render(
      <PanelShell
        title="X"
        search={{ value: '', onChange: () => {}, placeholder: 'Filter…' }}
      >
        <div />
      </PanelShell>
    )
    const input = screen.getByPlaceholderText('Filter…')
    // The 28px compact row: h-8 input shrinks to h-7 and narrows so it
    // does not crowd the short header next to the window chrome.
    expect(input).toHaveClass('compact-header:h-7')
    expect(input).toHaveClass('compact-header:w-40')
  })

  it('uses the shared window-chrome safe areas in compact mode', () => {
    const { container } = render(
      <PanelShell title="X">
        <div />
      </PanelShell>
    )
    expect(container.querySelector('header')).toHaveClass(
      'compact-header:ps-[var(--window-chrome-safe-area-leading)]',
      'compact-header:pe-[var(--window-chrome-safe-area-trailing)]'
    )
  })

  it('renders footer content when provided', () => {
    render(
      <PanelShell title="X" footer={<button type="button">go</button>}>
        <div />
      </PanelShell>
    )
    expect(screen.getByRole('button', { name: 'go' })).toBeInTheDocument()
  })
})

describe('PanelShell actionsPosition', () => {
  it('keeps header actions above window chrome but below modal layers', () => {
    render(
      <>
        <PanelShell
          title="T"
          actions={
            <button type="button" data-testid="act">
              a
            </button>
          }
        >
          <div>content</div>
        </PanelShell>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Modal</DialogTitle>
          </DialogContent>
        </Dialog>
      </>
    )

    const actions = screen.getByTestId('act').parentElement
    const overlay = document.querySelector('[data-slot="dialog-overlay"]')
    expect(actions).toHaveClass('z-40')
    expect(actions).not.toHaveClass('z-[60]')
    expect(overlay).toHaveClass('z-50')
  })

  it('renders actions on the end side by default (after search)', () => {
    const { container } = render(
      <PanelShell
        title="T"
        search={{ value: '', onChange: () => {}, placeholder: 'p' }}
        actions={
          <button type="button" data-testid="act">
            a
          </button>
        }
      >
        <div>content</div>
      </PanelShell>
    )
    const searchInput = container.querySelector('input')
    const btn = container.querySelector('[data-testid=act]') as HTMLElement
    expect(searchInput?.compareDocumentPosition(btn)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('renders actions on the start side when actionsPosition is "start"', () => {
    const { container } = render(
      <PanelShell
        title="T"
        search={{ value: '', onChange: () => {}, placeholder: 'p' }}
        actions={
          <button type="button" data-testid="act">
            a
          </button>
        }
        actionsPosition="start"
      >
        <div>content</div>
      </PanelShell>
    )
    const searchInput = container.querySelector('input')
    const btn = container.querySelector('[data-testid=act]') as HTMLElement
    expect(btn.compareDocumentPosition(searchInput as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })
})
