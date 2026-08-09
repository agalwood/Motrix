// src/renderer/routes/dashboard/components/tile-shell.test.tsx
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TileShell } from './tile-shell'

describe('TileShell', () => {
  it('renders header label and body slot', () => {
    render(
      <TileShell label="UPLOAD">
        <span data-testid="body">hello</span>
      </TileShell>
    )
    expect(screen.getByText('UPLOAD')).toBeInTheDocument()
    expect(screen.getByTestId('body')).toBeInTheDocument()
  })

  it('renders an action slot when provided', () => {
    render(
      <TileShell label="ENGINE" action={<button type="button">Diag</button>}>
        <span />
      </TileShell>
    )
    expect(screen.getByRole('button', { name: 'Diag' })).toBeInTheDocument()
  })

  it('forwards bodyClassName to the body container', () => {
    const { container } = render(
      <TileShell label="X" bodyClassName="test-body">
        <span />
      </TileShell>
    )
    expect(container.querySelector('.test-body')).toBeInTheDocument()
  })

  it('uses a compact, adaptive header layout', () => {
    const { container } = render(
      <TileShell label="UPLOAD">
        <span />
      </TileShell>
    )
    const header = container.querySelector('[data-slot="tile-header"]')
    const label = container.querySelector('[data-slot="tile-label"]')

    expect(container.querySelector('.dashboard-tile')).toHaveClass('gap-0')
    expect(header).toHaveClass(
      '-mt-1',
      'grid',
      'min-h-6',
      'min-w-0',
      'grid-cols-[minmax(0,1fr)_auto]',
      'items-center'
    )
    expect(label).toHaveClass('min-w-0', 'truncate', 'text-[10px]', 'leading-4')
    expect(
      container.querySelector('[data-slot="tile-action"]')
    ).not.toBeInTheDocument()
  })

  it('moves the optional action into the header end gutter', () => {
    const { container } = render(
      <TileShell label="TRANSFER" action={<button type="button">Today</button>}>
        <span />
      </TileShell>
    )

    expect(container.querySelector('[data-slot="tile-action"]')).toHaveClass(
      '-me-1',
      'shrink-0',
      'items-center'
    )
  })

  it('allows the body to shrink in both axes', () => {
    const { container } = render(
      <TileShell label="TRANSFER">
        <span />
      </TileShell>
    )

    expect(container.querySelector('[data-tile-content]')).toHaveClass(
      'min-h-0',
      'min-w-0',
      'flex-1'
    )
  })
})
