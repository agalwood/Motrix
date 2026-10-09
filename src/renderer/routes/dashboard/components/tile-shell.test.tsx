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
})
