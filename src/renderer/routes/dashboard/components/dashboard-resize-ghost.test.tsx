import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DashboardResizeGhost } from './dashboard-resize-ghost'

describe('DashboardResizeGhost', () => {
  it('uses the primary treatment for a valid preview', () => {
    render(
      <DashboardResizeGhost
        geometry={{ x: 0, y: 0, w: 2, h: 1 }}
        valid
        sizeLabel="Current size: 2 × 1"
      />
    )

    const ghost = screen.getByRole('status', {
      name: 'Current size: 2 × 1',
    })
    expect(ghost).toHaveAttribute('data-valid', 'true')
    expect(ghost).toHaveClass('border-primary', 'bg-primary/10', 'text-primary')
    expect(screen.queryByText('Not enough space')).toBeNull()
  })

  it('uses the destructive treatment and exposes an optional failure', () => {
    render(
      <DashboardResizeGhost
        geometry={{ x: 2, y: 1, w: 2, h: 2 }}
        valid={false}
        sizeLabel="Current size: 2 × 2"
        failure="Not enough space"
      />
    )

    const ghost = screen.getByRole('status', {
      name: 'Current size: 2 × 2. Not enough space',
    })
    expect(ghost).toHaveAttribute('data-valid', 'false')
    expect(ghost).toHaveClass(
      'border-destructive',
      'bg-destructive/10',
      'text-destructive'
    )
    expect(ghost).not.toHaveClass('border-primary')
    expect(screen.getByText('Current size: 2 × 2')).toBeInTheDocument()
    expect(screen.getByText('Not enough space')).toBeInTheDocument()
  })
})
