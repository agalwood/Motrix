import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageQuickFilterPopover } from '@/popup/ImageQuickFilterPopover'
import type { ImageQuickFilters } from '@/popup/imageQuickFilters'
import { i18n } from '@/shared/i18n'

function FilterHarness({
  initial = { formats: [] },
  availableFormats = ['PNG', 'WEBP', 'JPG'],
  onChange = vi.fn(),
  onReset = vi.fn(),
}: {
  initial?: ImageQuickFilters
  availableFormats?: string[]
  onChange?: (filters: ImageQuickFilters) => void
  onReset?: () => void
}): React.ReactElement {
  const [filters, setFilters] = useState<ImageQuickFilters>(initial)
  return (
    <>
      <ImageQuickFilterPopover
        filters={filters}
        availableFormats={availableFormats}
        matchedCount={3}
        totalCount={8}
        onChange={(next) => {
          setFilters(next)
          onChange(next)
        }}
        onReset={() => {
          setFilters({ formats: [] })
          onReset()
        }}
      />
      <output data-testid="filter-state">{JSON.stringify(filters)}</output>
    </>
  )
}

function currentFilters(): ImageQuickFilters {
  return JSON.parse(
    screen.getByTestId('filter-state').textContent ?? '{}'
  ) as ImageQuickFilters
}

async function openFilters(): Promise<void> {
  await userEvent.click(
    screen.getByRole('button', {
      name: i18n.t('popup.sniffer.imageFilters.trigger'),
    })
  )
}

describe('ImageQuickFilterPopover', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('opens upward with a compact result and exposes selected unavailable formats', async () => {
    render(
      <FilterHarness
        initial={{ formats: ['HEIC'] }}
        availableFormats={['PNG', 'WEBP']}
      />
    )

    await openFilters()

    expect(
      screen.getByRole('dialog', {
        name: i18n.t('popup.sniffer.imageFilters.title'),
      })
    ).toBeTruthy()
    expect(screen.getByText('3 / 8')).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: 'Filter HEIC images' })
        .getAttribute('aria-pressed')
    ).toBe('true')
    expect(
      screen
        .getByRole('dialog', { name: 'Quick filters' })
        .getAttribute('data-side')
    ).toBe('top')
  })

  it('toggles multiple format chips immediately', async () => {
    const onChange = vi.fn()
    render(<FilterHarness onChange={onChange} />)
    await openFilters()

    await userEvent.click(
      screen.getByRole('button', { name: 'Filter PNG images' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Filter WEBP images' })
    )

    expect(currentFilters().formats).toEqual(['PNG', 'WEBP'])
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('updates width, height, and file-size comparison conditions', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<FilterHarness />)
    await user.click(screen.getByRole('button', { name: 'Filter' }))

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Width value' }), {
      target: { value: '800' },
    })

    await user.click(
      screen.getByRole('combobox', { name: 'Height comparison' })
    )
    await user.click(await screen.findByRole('option', { name: '=' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Height value' }), {
      target: { value: '600' },
    })

    await user.click(screen.getByRole('combobox', { name: 'Size comparison' }))
    await user.click(await screen.findByRole('option', { name: '≤' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Size value' }), {
      target: { value: '512' },
    })

    expect(currentFilters()).toEqual({
      formats: [],
      width: { operator: 'gte', value: 800 },
      height: { operator: 'eq', value: 600 },
      size: { operator: 'lte', value: 512 * 1024 },
    })
  })

  it('converts MB input to bytes and preserves the value when changing units', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<FilterHarness />)
    await user.click(screen.getByRole('button', { name: 'Filter' }))

    await user.click(screen.getByRole('combobox', { name: 'File size unit' }))
    await user.click(await screen.findByRole('option', { name: 'MB' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Size value' }), {
      target: { value: '1.5' },
    })

    expect(currentFilters().size).toEqual({
      operator: 'gte',
      value: 1.5 * 1024 * 1024,
    })

    await user.click(screen.getByRole('combobox', { name: 'File size unit' }))
    await user.click(await screen.findByRole('option', { name: 'KB' }))
    expect(
      (
        screen.getByRole('spinbutton', {
          name: 'Size value',
        }) as HTMLInputElement
      ).value
    ).toBe('1536')
    expect(currentFilters().size?.value).toBe(1.5 * 1024 * 1024)
  })

  it('ignores negative input and removes a condition when the input is cleared', async () => {
    render(<FilterHarness />)
    await openFilters()
    const width = screen.getByRole('spinbutton', {
      name: 'Width value',
    }) as HTMLInputElement

    fireEvent.change(width, { target: { value: '-1' } })
    expect(currentFilters().width).toBeUndefined()

    fireEvent.change(width, { target: { value: '320' } })
    expect(currentFilters().width?.value).toBe(320)
    fireEvent.change(width, { target: { value: '' } })
    expect(currentFilters().width).toBeUndefined()
  })

  it('resets all filters and closes from Done or Escape', async () => {
    const onReset = vi.fn()
    render(
      <FilterHarness
        initial={{
          formats: ['PNG'],
          width: { operator: 'gte', value: 640 },
        }}
        onReset={onReset}
      />
    )
    await openFilters()

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(onReset).toHaveBeenCalledOnce()
    expect(currentFilters()).toEqual({ formats: [] })

    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Quick filters' })).toBeNull()
    )

    await openFilters()
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Quick filters' })).toBeNull()
    )
  })
})
