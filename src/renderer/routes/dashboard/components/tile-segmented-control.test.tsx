import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  TileSegmentedControl,
  type TileSegmentOption,
} from './tile-segmented-control'

type View = 'active' | 'failed' | 'recent'

const OPTIONS: readonly TileSegmentOption<View>[] = [
  { value: 'active', label: 'Active' },
  { value: 'failed', label: 'Failed' },
  { value: 'recent', label: 'Recent' },
]

interface ControlledProps {
  initialValue?: View
  options?: readonly TileSegmentOption<View>[]
  direction?: 'ltr' | 'rtl'
  onValueChange?: (value: View) => void
}

function ControlledSegmentedControl({
  initialValue = 'active',
  options = OPTIONS,
  direction = 'ltr',
  onValueChange,
}: ControlledProps) {
  const [value, setValue] = useState(initialValue)

  return (
    <div dir={direction}>
      <TileSegmentedControl
        ariaLabel="Task view"
        value={value}
        options={options}
        onValueChange={(nextValue) => {
          onValueChange?.(nextValue)
          setValue(nextValue)
        }}
      />
    </div>
  )
}

describe('TileSegmentedControl', () => {
  it('exposes radio semantics, one tab stop, and the forwarded root ref', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <TileSegmentedControl
        ref={ref}
        ariaLabel="Task view"
        value="failed"
        options={OPTIONS}
        onValueChange={vi.fn()}
      />
    )

    const group = screen.getByRole('radiogroup', { name: 'Task view' })
    const active = screen.getByRole('radio', { name: 'Active' })
    const failed = screen.getByRole('radio', { name: 'Failed' })
    const recent = screen.getByRole('radio', { name: 'Recent' })

    expect(ref.current).toBe(group)
    expect(active).toHaveAttribute('aria-checked', 'false')
    expect(failed).toHaveAttribute('aria-checked', 'true')
    expect(recent).toHaveAttribute('aria-checked', 'false')
    expect(active).toHaveAttribute('tabindex', '-1')
    expect(failed).toHaveAttribute('tabindex', '0')
    expect(recent).toHaveAttribute('tabindex', '-1')
  })

  it('selects with the pointer without re-emitting the selected value', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <TileSegmentedControl
        ariaLabel="Task view"
        value="active"
        options={OPTIONS}
        onValueChange={onValueChange}
      />
    )

    await user.click(screen.getByRole('radio', { name: 'Failed' }))
    await user.click(screen.getByRole('radio', { name: 'Active' }))

    expect(onValueChange).toHaveBeenCalledTimes(1)
    expect(onValueChange).toHaveBeenCalledWith('failed')
  })

  it('wraps in LTR DOM order and skips disabled options', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <ControlledSegmentedControl
        options={[OPTIONS[0], { ...OPTIONS[1], disabled: true }, OPTIONS[2]]}
        onValueChange={onValueChange}
      />
    )

    const active = screen.getByRole('radio', { name: 'Active' })
    active.focus()
    await user.keyboard('{ArrowRight}')

    const recent = screen.getByRole('radio', { name: 'Recent' })
    expect(recent).toHaveFocus()
    expect(recent).toHaveAttribute('aria-checked', 'true')

    await user.keyboard('{ArrowRight}')
    expect(active).toHaveFocus()
    expect(active).toHaveAttribute('aria-checked', 'true')
    expect(onValueChange.mock.calls).toEqual([['recent'], ['active']])
  })

  it('reverses Left and Right in RTL', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <ControlledSegmentedControl
        direction="rtl"
        onValueChange={onValueChange}
      />
    )

    const active = screen.getByRole('radio', { name: 'Active' })
    active.focus()
    await user.keyboard('{ArrowRight}')

    const recent = screen.getByRole('radio', { name: 'Recent' })
    expect(recent).toHaveFocus()
    expect(recent).toHaveAttribute('aria-checked', 'true')

    await user.keyboard('{ArrowLeft}')
    expect(active).toHaveFocus()
    expect(active).toHaveAttribute('aria-checked', 'true')
    expect(onValueChange.mock.calls).toEqual([['recent'], ['active']])
  })

  it('supports Up, Down, Home, and End without duplicate changes', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(
      <ControlledSegmentedControl
        initialValue="failed"
        onValueChange={onValueChange}
      />
    )

    const failed = screen.getByRole('radio', { name: 'Failed' })
    failed.focus()
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{End}')
    await user.keyboard('{Home}')
    await user.keyboard('{ArrowUp}')

    expect(screen.getByRole('radio', { name: 'Recent' })).toHaveFocus()
    expect(onValueChange.mock.calls).toEqual([
      ['recent'],
      ['active'],
      ['recent'],
    ])
  })

  it('activates with Enter and Space exactly once', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<ControlledSegmentedControl onValueChange={onValueChange} />)

    const failed = screen.getByRole('radio', { name: 'Failed' })
    failed.focus()
    await user.keyboard('{Enter}')
    await user.keyboard('{Enter}')

    const recent = screen.getByRole('radio', { name: 'Recent' })
    recent.focus()
    await user.keyboard(' ')
    await user.keyboard(' ')

    expect(onValueChange.mock.calls).toEqual([['failed'], ['recent']])
  })

  it('uses the first enabled option as tab stop when selection is disabled', () => {
    const onValueChange = vi.fn()
    render(
      <TileSegmentedControl
        ariaLabel="Task view"
        value="failed"
        options={[OPTIONS[0], { ...OPTIONS[1], disabled: true }, OPTIONS[2]]}
        onValueChange={onValueChange}
      />
    )

    const active = screen.getByRole('radio', { name: 'Active' })
    const failed = screen.getByRole('radio', { name: 'Failed' })
    const recent = screen.getByRole('radio', { name: 'Recent' })

    expect(active).toHaveAttribute('tabindex', '0')
    expect(failed).toBeDisabled()
    expect(failed).toHaveAttribute('aria-checked', 'true')
    expect(failed).toHaveAttribute('tabindex', '-1')
    expect(recent).toHaveAttribute('tabindex', '-1')

    fireEvent.keyDown(active, { key: 'ArrowRight' })
    expect(onValueChange).toHaveBeenCalledWith('recent')
  })

  it('prevents group-disabled interaction and removes every tab stop', () => {
    const onValueChange = vi.fn()
    render(
      <TileSegmentedControl
        disabled
        ariaLabel="Task view"
        value="active"
        options={OPTIONS}
        onValueChange={onValueChange}
      />
    )

    const group = screen.getByRole('radiogroup', { name: 'Task view' })
    const radios = screen.getAllByRole('radio')

    expect(group).toHaveAttribute('aria-disabled', 'true')
    for (const radio of radios) {
      expect(radio).toBeDisabled()
      expect(radio).toHaveAttribute('tabindex', '-1')
    }

    fireEvent.click(radios[1] as HTMLElement)
    fireEvent.keyDown(radios[0] as HTMLElement, { key: 'ArrowRight' })
    expect(onValueChange).not.toHaveBeenCalled()
  })
})
