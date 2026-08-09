import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import type { TrackerSource } from '@shared/types/tracker'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TrackerSourceCombobox } from './tracker-source-combobox'

const SAMPLES: TrackerSource[] = [
  {
    id: 'a',
    label: 'Source A',
    url: 'http://a',
    builtin: true,
    enabled: true,
    cdn: false,
  },
  {
    id: 'b',
    label: 'Source B',
    url: 'http://b',
    builtin: true,
    enabled: false,
    cdn: false,
  },
  {
    id: 'c',
    label: 'Custom',
    url: 'http://c',
    builtin: false,
    enabled: true,
    cdn: false,
  },
]

function setup(ui: React.ReactElement) {
  // Disable pointer-events check: base-ui's Combobox positioner sets
  // `pointer-events: none` on its outer div via inline style and toggles
  // off only after the open transition completes. In jsdom there is no
  // animation tick, so user-event sees the inert style and refuses the
  // click. The interaction is fine for real users.
  const user = userEvent.setup({ pointerEventsCheck: 0 })
  return { user, ...render(ui) }
}

// In jsdom, base-ui's Combobox sometimes needs more than one click on the
// trigger to actually surface the popover when a previous test left
// portal/focus state in document.body (RTL's auto-cleanup tears down the
// rendered container but not the portalled positioner). This helper clicks
// up to 3 times until a popup with `data-closed` removed appears, and
// returns that popup so callers can scope queries with `within(popup)`.
async function openPopover(
  user: ReturnType<typeof userEvent.setup>,
  trigger: HTMLElement
): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await user.click(trigger)
    const contents = document.querySelectorAll<HTMLElement>(
      '[data-slot="combobox-content"]'
    )
    for (const c of contents) {
      if (c.getAttribute('data-closed') === null) return c
    }
  }
  throw new Error('combobox popover failed to open')
}

describe('<TrackerSourceCombobox>', () => {
  it('renders enabled sources as chips in the chips container', () => {
    render(
      <TrackerSourceCombobox
        sources={SAMPLES}
        onChange={vi.fn()}
        testId="cbx"
      />
    )
    const chips = screen.getByTestId('cbx')
    expect(chips).toHaveTextContent('Source A')
    expect(chips).toHaveTextContent('Custom')
    expect(chips).not.toHaveTextContent('Source B')
  })

  it('shows placeholder in chip input when no sources are enabled', () => {
    const noneEnabled = SAMPLES.map((s) => ({ ...s, enabled: false }))
    render(
      <TrackerSourceCombobox
        sources={noneEnabled}
        onChange={vi.fn()}
        testId="cbx"
      />
    )
    expect(screen.getByPlaceholderText(/select sources/i)).toBeInTheDocument()
  })

  it('clicking a chip remove button deselects the source without deleting it', () => {
    const onChange = vi.fn()
    render(
      <TrackerSourceCombobox
        sources={SAMPLES}
        onChange={onChange}
        testId="cbx"
      />
    )
    const chip = screen.getByLabelText('Source A')
    const removeBtn = within(chip).getByRole('button')
    fireEvent.click(removeBtn)
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as TrackerSource[]
    // Source still present in the list (deselect, not delete)
    expect(next).toHaveLength(SAMPLES.length)
    expect(next.find((s) => s.id === 'a')?.enabled).toBe(false)
    // Other sources untouched
    expect(next.find((s) => s.id === 'b')?.enabled).toBe(false)
    expect(next.find((s) => s.id === 'c')?.enabled).toBe(true)
  })

  it('opens popover and lists all sources', async () => {
    const { user } = setup(
      <TrackerSourceCombobox
        sources={SAMPLES}
        onChange={vi.fn()}
        testId="cbx"
      />
    )
    const popover = await openPopover(user, screen.getByTestId('cbx'))
    expect(within(popover).getByText('Source A')).toBeInTheDocument()
    expect(within(popover).getByText('Source B')).toBeInTheDocument()
    expect(within(popover).getByText('Custom')).toBeInTheDocument()
  })

  it('toggles enabled state when item clicked', async () => {
    const onChange = vi.fn()
    const { user } = setup(
      <TrackerSourceCombobox
        sources={SAMPLES}
        onChange={onChange}
        testId="cbx"
      />
    )
    await user.click(screen.getByTestId('cbx'))
    await user.click(screen.getByText('Source B'))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as TrackerSource[]
    expect(next.find((s) => s.id === 'b')?.enabled).toBe(true)
  })

  it('renders builtin and cdn badges', async () => {
    const { user } = setup(
      <TrackerSourceCombobox
        sources={SAMPLES}
        onChange={vi.fn()}
        testId="cbx"
      />
    )
    await user.click(screen.getByTestId('cbx'))
    expect(screen.getAllByText(/builtin/i).length).toBeGreaterThan(0)
  })

  it('filters list by chip-input value (label or URL substring, case-insensitive)', async () => {
    const { user } = setup(
      <TrackerSourceCombobox
        sources={SAMPLES}
        onChange={vi.fn()}
        testId="cbx"
      />
    )
    const popover = await openPopover(user, screen.getByTestId('cbx'))
    const chipInput = within(screen.getByTestId('cbx')).getByRole('combobox')
    fireEvent.change(chipInput, { target: { value: 'Custom' } })
    expect(within(popover).queryByText('Source A')).not.toBeInTheDocument()
    expect(within(popover).getByText('Custom')).toBeInTheDocument()
  })

  it('shows empty state when filter matches nothing', async () => {
    const { user } = setup(
      <TrackerSourceCombobox
        sources={SAMPLES}
        onChange={vi.fn()}
        testId="cbx"
      />
    )
    await openPopover(user, screen.getByTestId('cbx'))
    const chipInput = within(screen.getByTestId('cbx')).getByRole('combobox')
    fireEvent.change(chipInput, { target: { value: 'no-match-zzzzzz' } })
    expect(screen.getByText(/no sources match/i)).toBeInTheDocument()
  })

  it('add button disabled when URL invalid', async () => {
    const { user } = setup(
      <TrackerSourceCombobox
        sources={SAMPLES}
        onChange={vi.fn()}
        testId="cbx"
      />
    )
    const popover = await openPopover(user, screen.getByTestId('cbx'))
    const input = within(popover).getByPlaceholderText(/example\.com\/list/i)
    fireEvent.change(input, { target: { value: 'not-a-url' } })
    expect(within(popover).getByRole('button', { name: /add/i })).toBeDisabled()
  })

  it('add button enables and appends new source on click', async () => {
    const onChange = vi.fn()
    const { user } = setup(
      <TrackerSourceCombobox
        sources={SAMPLES}
        onChange={onChange}
        testId="cbx"
      />
    )
    const popover = await openPopover(user, screen.getByTestId('cbx'))
    const input = within(popover).getByPlaceholderText(/example\.com\/list/i)
    fireEvent.change(input, {
      target: { value: 'https://my.example/list.txt' },
    })
    await user.click(within(popover).getByRole('button', { name: /add/i }))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as TrackerSource[]
    expect(next).toHaveLength(SAMPLES.length + 1)
    expect(next[next.length - 1].url).toBe('https://my.example/list.txt')
    expect(next[next.length - 1].builtin).toBe(false)
    expect(next[next.length - 1].enabled).toBe(true)
  })

  it('disables Add button and ignores submit when URL duplicates an existing source', async () => {
    const onChange = vi.fn()
    const { user } = setup(
      <TrackerSourceCombobox
        sources={SAMPLES}
        onChange={onChange}
        testId="cbx"
      />
    )
    const popover = await openPopover(user, screen.getByTestId('cbx'))
    const input = within(popover).getByPlaceholderText(/example\.com\/list/i)
    // 'http://a' is already present as builtin Source A
    fireEvent.change(input, { target: { value: 'http://a' } })
    const addBtn = within(popover).getByRole('button', { name: /add/i })
    expect(addBtn).toBeDisabled()
    // Enter key path must not bypass the duplicate guard
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('Enter key in URL input triggers add', async () => {
    const onChange = vi.fn()
    const { user } = setup(
      <TrackerSourceCombobox
        sources={SAMPLES}
        onChange={onChange}
        testId="cbx"
      />
    )
    const popover = await openPopover(user, screen.getByTestId('cbx'))
    const input = within(popover).getByPlaceholderText(/example\.com\/list/i)
    fireEvent.change(input, { target: { value: 'https://e.example/x.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('shows trash button only on non-builtin items', async () => {
    const { user } = setup(
      <TrackerSourceCombobox
        sources={SAMPLES}
        onChange={vi.fn()}
        testId="cbx"
      />
    )
    const popover = await openPopover(user, screen.getByTestId('cbx'))
    const removeButtons = within(popover).getAllByRole('button', {
      name: /remove source/i,
    })
    // Only 'Custom' is non-builtin → exactly 1 trash button
    expect(removeButtons).toHaveLength(1)
  })

  it('clicking trash removes the source via onChange (does not toggle enabled)', async () => {
    const onChange = vi.fn()
    const { user } = setup(
      <TrackerSourceCombobox
        sources={SAMPLES}
        onChange={onChange}
        testId="cbx"
      />
    )
    const popover = await openPopover(user, screen.getByTestId('cbx'))
    const removeButton = within(popover).getByRole('button', {
      name: /remove source/i,
    })
    fireEvent.click(removeButton)
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as TrackerSource[]
    expect(next.find((s) => s.id === 'c')).toBeUndefined()
    expect(next).toHaveLength(SAMPLES.length - 1)
    // Verify enabled flags unchanged on remaining sources
    expect(next.find((s) => s.id === 'a')?.enabled).toBe(true)
    expect(next.find((s) => s.id === 'b')?.enabled).toBe(false)
  })
})
