import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { TaskStatus } from '@shared/types/task'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusPill } from './status-pill'

describe('StatusPill', () => {
  it('renders localized label for each status', () => {
    render(<StatusPill status={TaskStatus.Downloading} />)
    expect(screen.getByText(/downloading/i)).toBeInTheDocument()
  })

  it('renders FetchingMetadata as Fetching', () => {
    render(<StatusPill status={TaskStatus.FetchingMetadata} />)
    expect(screen.getByText('Fetching')).toBeInTheDocument()
    expect(screen.queryByText('Fetching metadata')).not.toBeInTheDocument()
  })

  it('applies tone classes from task-status-ui', () => {
    const { container } = render(<StatusPill status={TaskStatus.Error} />)
    expect(container.firstChild).toHaveClass('bg-red-100')
  })

  it('does not shrink when adjacent inspector metadata is long', () => {
    render(<StatusPill status={TaskStatus.Downloading} />)
    expect(screen.getByTestId('task-status-pill')).toHaveClass('shrink-0')
  })
})
