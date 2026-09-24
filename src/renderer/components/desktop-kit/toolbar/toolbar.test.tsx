import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Toolbar } from './toolbar'
import { ToolbarButton, ToolbarLink } from './toolbar-button'
import { ToolbarGroup } from './toolbar-group'
import { ToolbarSearch } from './toolbar-search'

vi.mock('@renderer/hooks/use-liquid-glass', () => ({
  useLiquidGlass: () => false,
}))

function SearchExample({ initialValue = '', keepExpanded = false }) {
  const [value, setValue] = useState(initialValue)
  return (
    <>
      <Toolbar label="Files">
        <ToolbarGroup>
          <ToolbarButton label="Add">+</ToolbarButton>
          <ToolbarButton label="Unavailable" disabled>
            −
          </ToolbarButton>
          <ToolbarLink label="Details" href="#details">
            i
          </ToolbarLink>
        </ToolbarGroup>
        <ToolbarSearch
          value={value}
          onValueChange={setValue}
          label="Search files"
          clearLabel="Clear search"
          keepExpanded={keepExpanded}
        />
      </Toolbar>
      <button type="button">Outside</button>
    </>
  )
}

describe('Toolbar', () => {
  it('moves focus across buttons and links with arrows, skipping disabled controls', async () => {
    const user = userEvent.setup()
    render(<SearchExample />)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Add' })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('link', { name: 'Details' })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('button', { name: 'Search files' })).toHaveFocus()
    await user.keyboard('{Enter}')
    const input = screen.getByRole('textbox', { name: 'Search files' })
    expect(input).toHaveFocus()
    await user.type(input, 'abc')
    await user.keyboard('{ArrowLeft}')
    expect(input).toHaveFocus()
    expect((input as HTMLInputElement).selectionStart).toBe(2)
  })

  it('keeps a query expanded outside, then clears and collapses with Escape', async () => {
    const user = userEvent.setup()
    render(<SearchExample />)
    await user.click(screen.getByRole('button', { name: 'Search files' }))
    const input = screen.getByRole('textbox')
    await user.type(input, 'archive')
    await user.click(screen.getByRole('button', { name: 'Outside' }))
    expect(input).toBeVisible()
    await user.click(input)
    await user.keyboard('{Escape}')
    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'Search files' })).toHaveFocus()
  })

  it('collapses an empty search on blur and restores focus after clearing', async () => {
    const user = userEvent.setup()
    render(<SearchExample initialValue="archive" />)
    await user.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByRole('textbox')).toHaveFocus()
    expect(screen.getByRole('textbox')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Outside' }))
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
  })

  it('keeps active filters visible and ignores Escape while composing', async () => {
    const user = userEvent.setup()
    render(<SearchExample initialValue="archive" keepExpanded />)
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true })
    expect(input).toHaveValue('archive')
    await user.click(input)
    await user.keyboard('{Escape}{Escape}')
    await user.click(screen.getByRole('button', { name: 'Outside' }))
    expect(input).toBeVisible()
    expect(input).toHaveValue('')
  })
})
