import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
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

  it('forwards search edits and reflects the controlled value', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    function SearchPanel() {
      const [value, setValue] = useState('existing')
      return (
        <PanelShell
          title="Trackers"
          search={{
            value,
            onChange: (next) => {
              onChange(next)
              setValue(next)
            },
            placeholder: 'Filter…',
          }}
        >
          <div />
        </PanelShell>
      )
    }
    render(<SearchPanel />)
    const input = screen.getByPlaceholderText('Filter…')
    expect(input).toHaveValue('existing')
    await user.clear(input)
    await user.type(input, 'tracker')
    expect(onChange).toHaveBeenLastCalledWith('tracker')
    expect(input).toHaveValue('tracker')
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
