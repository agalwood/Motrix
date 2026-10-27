import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { PanelShell } from './panel-shell'

describe('PanelShell', () => {
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
})
