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

  it('labels non-finalizing statuses with the lowercased enum value', () => {
    render(<TaskStatusBadge status={TaskStatus.Downloading} />)
    expect(screen.getByText('downloading')).toBeInTheDocument()
  })
})
