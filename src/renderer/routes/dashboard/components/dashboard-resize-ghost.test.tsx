import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DashboardResizeGhost } from './dashboard-resize-ghost'

describe('DashboardResizeGhost', () => {
  it('maps its geometry to the dashboard grid and stays non-interactive', () => {
    render(
      <DashboardResizeGhost
        geometry={{ x: 1, y: 0, w: 3, h: 2 }}
        valid
        sizeLabel="Current size: 3 × 2"
      />
    )

    const ghost = screen.getByTestId('dashboard-resize-ghost')
    expect(ghost).toHaveStyle({
      '--dashboard-grid-column': '2 / span 3',
      '--dashboard-grid-row': '1 / span 2',
    })
    expect(ghost).toHaveClass(
      'pointer-events-none',
      'hidden',
      '@[560px]:flex',
      '@[560px]:[grid-column:var(--dashboard-grid-column)]',
      '@[560px]:[grid-row:var(--dashboard-grid-row)]'
    )
  })

  it('uses a fixed viewport rect while retaining snapped grid geometry', () => {
    render(
      <DashboardResizeGhost
        geometry={{ x: 3, y: 2, w: 2, h: 2 }}
        viewportRect={{
          left: 300,
          top: 256,
          width: 200,
          height: 256,
        }}
        valid={false}
        sizeLabel="Current size: 2 × 2"
        failure="Not enough space"
      />
    )

    const ghost = screen.getByTestId('dashboard-resize-ghost')
    expect(ghost).toHaveClass('fixed', 'z-40')
    expect(ghost).not.toHaveClass(
      'absolute',
      'inset-0',
      '@[560px]:[grid-column:var(--dashboard-grid-column)]',
      '@[560px]:[grid-row:var(--dashboard-grid-row)]'
    )
    expect(ghost).toHaveStyle({
      '--dashboard-grid-column': '4 / span 2',
      '--dashboard-grid-row': '3 / span 2',
      left: '300px',
      top: '256px',
      width: '200px',
      height: '256px',
    })
  })

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
