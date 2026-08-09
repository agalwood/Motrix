import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Autocomplete,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
} from './autocomplete'
import { InputGroupAddon } from './input-group'

const ITEMS = ['Alpha', 'Beta'] as const

const originalHasPointerCapture = HTMLElement.prototype.hasPointerCapture
const originalReleasePointerCapture =
  HTMLElement.prototype.releasePointerCapture
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  HTMLElement.prototype.hasPointerCapture = () => false
  HTMLElement.prototype.releasePointerCapture = () => {}
  HTMLElement.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  vi.unstubAllGlobals()
  HTMLElement.prototype.hasPointerCapture = originalHasPointerCapture
  HTMLElement.prototype.releasePointerCapture = originalReleasePointerCapture
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView
})

function Harness({ leadingAddon = false }: { leadingAddon?: boolean }) {
  const [value, setValue] = useState('')
  return (
    <Autocomplete
      items={ITEMS}
      value={value}
      onValueChange={setValue}
      autoHighlight
    >
      <AutocompleteInput
        aria-label="Search"
        showClear={value.length > 0}
        clearLabel="Clear search"
      >
        {leadingAddon && (
          <InputGroupAddon align="inline-start">Scope</InputGroupAddon>
        )}
      </AutocompleteInput>
      <AutocompleteContent>
        <AutocompleteEmpty>No suggestions</AutocompleteEmpty>
        <AutocompleteList>
          {(item: string) => (
            <AutocompleteItem key={item} value={item}>
              {item}
            </AutocompleteItem>
          )}
        </AutocompleteList>
      </AutocompleteContent>
    </Autocomplete>
  )
}

describe('Autocomplete UI primitive', () => {
  it('keeps arbitrary free text and clears it from the input affordance', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Harness />)
    const input = screen.getByRole('combobox', { name: 'Search' })
    await user.type(input, 'custom query')
    expect(input).toHaveValue('custom query')
    await user.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(input).toHaveValue('')
  })

  it('focuses and activates the clear affordance from the keyboard', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Harness />)
    const input = screen.getByRole('combobox', { name: 'Search' })
    await user.type(input, 'custom query')

    await user.tab()
    const clear = screen.getByRole('button', { name: 'Clear search' })
    expect(clear).toHaveFocus()

    await user.keyboard('[Enter]')
    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
  })

  it('keeps suggestions open when a leading addon focuses the input', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Harness leadingAddon />)
    const input = screen.getByRole('combobox', { name: 'Search' })
    await user.type(input, 'alp')
    expect(await screen.findByRole('option', { name: 'Alpha' })).toBeVisible()

    await user.click(screen.getByText('Scope'))

    expect(screen.getByRole('option', { name: 'Alpha' })).toBeVisible()
    expect(input).toHaveFocus()
  })

  it('sizes the popup to the complete input-group anchor', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Harness leadingAddon />)

    await user.type(screen.getByRole('combobox', { name: 'Search' }), 'alp')
    const option = await screen.findByRole('option', { name: 'Alpha' })
    const content = option.closest('[data-slot="autocomplete-content"]')

    expect(content).toHaveClass(
      'w-(--anchor-width)',
      'max-w-(--available-width)'
    )
    expect(content).not.toHaveClass(
      'min-w-[calc(var(--anchor-width)+--spacing(7))]'
    )
  })

  it('accepts the highlighted suggestion with Enter', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Harness />)
    const input = screen.getByRole('combobox', { name: 'Search' })
    await user.type(input, 'alp')
    await user.keyboard('[ArrowDown][Enter]')
    expect(input).toHaveValue('Alpha')
  })

  it('closes suggestions with Escape without clearing free text', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Harness />)
    const input = screen.getByRole('combobox', { name: 'Search' })
    await user.type(input, 'alp')
    expect(await screen.findByRole('option', { name: 'Alpha' })).toBeVisible()
    await user.keyboard('[Escape]')
    expect(input).toHaveValue('alp')
    expect(
      screen.queryByRole('option', { name: 'Alpha' })
    ).not.toBeInTheDocument()
  })

  it('keeps the empty-result live region mounted and available to assistive tech', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Harness />)
    await user.type(screen.getByRole('combobox', { name: 'Search' }), 'zzz')
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('No suggestions')
    expect(status).not.toHaveAttribute('hidden')
    expect(getComputedStyle(status).display).not.toBe('none')
  })
})
