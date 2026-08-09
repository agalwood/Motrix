import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { TaskStatus } from '@shared/types/task'
import { TaskStatusBadge } from './task-status-badge'

describe('TaskStatusBadge', () => {
  it('renders every TaskStatus value without throwing', () => {
    for (const status of Object.values(TaskStatus)) {
      const { unmount } = render(<TaskStatusBadge status={status} />)
      expect(screen.getByTestId('task-status-badge-icon')).toBeInTheDocument()
      unmount()
    }
  })

  it('renders the Finalizing status with a spinning Loader2 icon', () => {
    render(<TaskStatusBadge status={TaskStatus.Finalizing} />)
    expect(screen.getByText('Finalizing…')).toBeInTheDocument()
    const icon = screen.getByTestId('task-status-badge-icon')
    expect(icon).toHaveClass('animate-spin')
  })

  it('uses destructive styling for the Error status', () => {
    const { container } = render(<TaskStatusBadge status={TaskStatus.Error} />)
    const badge = container.querySelector('[data-slot="task-status-badge"]')
    expect(badge).not.toBeNull()
    expect(badge).toHaveClass('bg-destructive')
  })

  it('labels non-finalizing statuses with the lowercased enum value', () => {
    render(<TaskStatusBadge status={TaskStatus.Downloading} />)
    expect(screen.getByText('downloading')).toBeInTheDocument()
  })

  it('does not spin the icon for non-loading statuses', () => {
    render(<TaskStatusBadge status={TaskStatus.Paused} />)
    const icon = screen.getByTestId('task-status-badge-icon')
    expect(icon).not.toHaveClass('animate-spin')
  })

  it('applies a caller-supplied className', () => {
    const { container } = render(
      <TaskStatusBadge status={TaskStatus.Queued} className="custom-xyz" />
    )
    const badge = container.querySelector('[data-slot="task-status-badge"]')
    expect(badge).toHaveClass('custom-xyz')
  })

  it('exposes the status via a data attribute for callsite styling', () => {
    const { container } = render(
      <TaskStatusBadge status={TaskStatus.Seeding} />
    )
    const badge = container.querySelector('[data-slot="task-status-badge"]')
    expect(badge).toHaveAttribute('data-status', TaskStatus.Seeding)
  })
})
