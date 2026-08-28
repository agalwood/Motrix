import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EmptyTasks } from './empty-tasks'

describe('EmptyTasks', () => {
  it('renders the "no tasks" message when total tasks is zero', () => {
    const { container } = render(
      <EmptyTasks
        filter="all"
        search=""
        hasAnyTasks={false}
        onClearSearch={() => {}}
      />
    )
    expect(screen.getByText(/no downloads yet/i)).toBeInTheDocument()
    expect(
      container.querySelector('[data-slot="cubic-glass-gradient"]')
    ).toHaveAttribute('data-preset', 'blue-pink')
    expect(
      screen.getByRole('button', { name: /tune glass motion/i })
    ).toBeInTheDocument()
  })

  it('controls the glass effects without remounting the empty state', async () => {
    const { container } = render(
      <EmptyTasks
        filter="all"
        search=""
        hasAnyTasks={false}
        onClearSearch={() => {}}
      />
    )
    const gradient = container.querySelector(
      '[data-slot="cubic-glass-gradient"]'
    )

    fireEvent.click(screen.getByRole('button', { name: /tune glass motion/i }))
    fireEvent.click(
      await screen.findByRole('switch', { name: /breathing light/i })
    )
    expect(gradient).toHaveAttribute('data-effect-breathing', 'false')

    const positionConstraint = screen.getByRole('switch', {
      name: /gravity position limit/i,
    })
    expect(positionConstraint).toBeChecked()
    fireEvent.click(positionConstraint)
    expect(gradient).toHaveAttribute('data-effect-position-constraint', 'false')
    expect(gradient).toHaveAttribute('data-effect-pointer-follow', 'true')

    fireEvent.click(screen.getByRole('switch', { name: /motion effects/i }))
    expect(gradient).toHaveAttribute('data-effect-load-fade', 'false')
    expect(gradient).toHaveAttribute('data-effect-pointer-follow', 'false')
    expect(positionConstraint).toHaveAttribute('aria-disabled', 'true')
    expect(gradient?.querySelectorAll('canvas')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: /reset/i }))
    expect(positionConstraint).toBeChecked()
    expect(positionConstraint).not.toHaveAttribute('aria-disabled', 'true')
    expect(gradient).toHaveAttribute('data-effect-position-constraint', 'true')
    const horizontalSpeed = screen.getByRole('group', {
      name: /horizontal speed/i,
    })
    const horizontalSpeedInput = horizontalSpeed.querySelector(
      'input[type="range"]'
    )
    expect(horizontalSpeedInput).toHaveValue('50')
    fireEvent.change(horizontalSpeedInput as HTMLInputElement, {
      target: { value: '20' },
    })
    expect(gradient).toHaveAttribute('data-horizontal-speed', '20')
  })

  it('renders search hint and fires onClearSearch', () => {
    const onClear = vi.fn()
    const { container } = render(
      <EmptyTasks
        filter="all"
        search="xyz"
        hasAnyTasks
        onClearSearch={onClear}
      />
    )
    expect(screen.getByText(/xyz/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /clear/i }))
    expect(onClear).toHaveBeenCalled()
    expect(
      container.querySelector('[data-slot="cubic-glass-gradient"]')
    ).not.toBeInTheDocument()
  })

  it('renders filter-only hint when search is empty but filter has no matches', () => {
    render(
      <EmptyTasks
        filter="error"
        search=""
        hasAnyTasks
        onClearSearch={() => {}}
      />
    )
    expect(screen.getByText(/no tasks match this filter/i)).toBeInTheDocument()
  })
})
