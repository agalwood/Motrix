import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TileErrorBoundary } from './tile-error-boundary'

// Always-throwing component: boundary can never auto-recover from it.
function Boom(): never {
  throw new Error('boom')
}

describe('TileErrorBoundary', () => {
  it('catches a render error and shows the fallback', () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {})
    render(
      <TileErrorBoundary tile="Engine">
        <Boom />
      </TileErrorBoundary>
    )
    expect(
      screen.getByText(/Engine: render failed|Engine: 渲染出错/i)
    ).toBeInTheDocument()
    expect(screen.getByRole('button')).toBeInTheDocument()
    consoleErrorSpy.mockRestore()
  })

  it('retry button resets the boundary so children can re-render', () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {})
    // Render Boom so the boundary is in error state showing the fallback.
    const { rerender } = render(
      <TileErrorBoundary tile="X">
        <Boom />
      </TileErrorBoundary>
    )
    // Fallback + retry button are visible.
    expect(screen.getByRole('button')).toBeInTheDocument()
    // Swap in a healthy child before retrying, then click retry.
    rerender(
      <TileErrorBoundary tile="X">
        <span>recovered</span>
      </TileErrorBoundary>
    )
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('recovered')).toBeInTheDocument()
    consoleErrorSpy.mockRestore()
  })
})
