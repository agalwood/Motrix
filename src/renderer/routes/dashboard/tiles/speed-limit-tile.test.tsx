import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { dashboardTileViewport } from '../layout/dashboard-registry'

vi.mock('react-router', async () => {
  const actual = (await vi.importActual('react-router')) as object
  return {
    ...actual,
    Link: ({
      children,
      to,
      ...props
    }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  }
})

const { SpeedLimitTile } = await import('./speed-limit-tile')

const compactViewport = dashboardTileViewport('speedLimit', { w: 1, h: 1 })
const summaryViewport = dashboardTileViewport('speedLimit', { w: 2, h: 1 })
const tallDetailedViewport = dashboardTileViewport('speedLimit', {
  w: 1,
  h: 2,
})
const squareDetailedViewport = dashboardTileViewport('speedLimit', {
  w: 2,
  h: 2,
})

describe('SpeedLimitTile', () => {
  it('marks the active speed mode and fires onSelectTurtle on click', () => {
    const onSelectTurtle = vi.fn()
    render(
      <SpeedLimitTile
        state={{
          turtle: 'off',
          effective: { download: 800_000, upload: 0 },
          activeReason: 'base',
        }}
        viewport={summaryViewport}
        onSelectTurtle={onSelectTurtle}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /automatic mode/i }))
    expect(onSelectTurtle).toHaveBeenCalledWith('auto')
  })

  it('shows Automatic (not Unlimited) when auto + idle', () => {
    const { container } = render(
      <SpeedLimitTile
        state={{
          turtle: 'auto',
          effective: { download: 0, upload: 0 },
          activeReason: 'none',
        }}
        viewport={summaryViewport}
        onSelectTurtle={vi.fn()}
      />
    )
    // When auto + idle the readout must NOT say "Unlimited".
    expect(screen.queryByText(/unlimited/i)).toBeNull()
    expect(screen.getByTestId('speed-limit-mode')).toHaveTextContent(
      /automatic mode/i
    )
    expect(
      screen
        .getByTestId('speed-limit-rates')
        .querySelectorAll('.lucide-infinity')
    ).toHaveLength(2)
    expect(container.querySelector('[data-slot="status-dot"]')).toBeNull()
  })

  it('keeps compact mode controls but omits the rate summary', () => {
    render(
      <SpeedLimitTile
        state={{
          turtle: 'on',
          effective: { download: 500_000, upload: 100_000 },
          activeReason: 'turtle',
        }}
        viewport={compactViewport}
        onSelectTurtle={vi.fn()}
      />
    )

    expect(screen.getByTestId('speed-limit-mode')).toHaveTextContent(
      /low-speed mode/i
    )
    expect(screen.queryByTestId('speed-limit-rates')).not.toBeInTheDocument()
    expect(screen.getByTestId('speed-limit-selector')).toHaveClass(
      'grid-cols-3',
      'pt-2'
    )
    expect(
      screen.getByRole('link', { name: /speed limit settings/i })
    ).toBeInTheDocument()
  })

  it('stacks controls and shows the effective reason when tall and detailed', () => {
    render(
      <SpeedLimitTile
        state={{
          turtle: 'auto',
          effective: { download: 500_000, upload: 100_000 },
          activeReason: 'schedule',
        }}
        viewport={tallDetailedViewport}
        onSelectTurtle={vi.fn()}
      />
    )

    expect(screen.getByTestId('speed-limit-selector')).toHaveClass(
      'grid-cols-1'
    )
    expect(screen.getByTestId('speed-limit-effective')).toHaveClass('flex-col')
    expect(screen.getByTestId('speed-limit-reason')).toHaveTextContent(
      /schedule/i
    )
  })

  it('keeps full controls horizontal in a square detailed viewport', () => {
    render(
      <SpeedLimitTile
        state={{
          turtle: 'auto',
          effective: { download: 500_000, upload: 100_000 },
          activeReason: 'adaptive',
        }}
        viewport={squareDetailedViewport}
        onSelectTurtle={vi.fn()}
      />
    )

    expect(screen.getByTestId('speed-limit-selector')).toHaveClass(
      'grid-cols-3'
    )
    expect(screen.getByTestId('speed-limit-effective')).toHaveClass('flex-row')
    expect(screen.getByTestId('speed-limit-reason')).toHaveTextContent(
      /bandwidth reserve/i
    )
  })
})
