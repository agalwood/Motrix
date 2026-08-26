import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import type { SpeedPoint } from '@shared/types/stats'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { DashboardTileViewport } from '../layout/dashboard-registry'
import { SpeedTile } from './speed-tile'

const points: SpeedPoint[] = [
  { t: 1, down: 100, up: 50 },
  { t: 2, down: 200, up: 80 },
  { t: 3, down: 150, up: 120 },
]

const COMPACT = {
  span: { w: 1, h: 1 },
  orientation: 'square',
  contentLevel: 'compact',
} satisfies DashboardTileViewport

const SUMMARY = {
  span: { w: 2, h: 1 },
  orientation: 'wide',
  contentLevel: 'summary',
} satisfies DashboardTileViewport

const WIDE_DETAILED = {
  span: { w: 3, h: 1 },
  orientation: 'wide',
  contentLevel: 'detailed',
} satisfies DashboardTileViewport

const SQUARE_DETAILED = {
  span: { w: 2, h: 2 },
  orientation: 'square',
  contentLevel: 'detailed',
} satisfies DashboardTileViewport

const FOCUS = {
  span: { w: 3, h: 2 },
  orientation: 'wide',
  contentLevel: 'focus',
} satisfies DashboardTileViewport

describe('SpeedTile', () => {
  it('renders the UPLOAD label and current up speed', () => {
    render(<SpeedTile kind="up" history={points} viewport={SUMMARY} />)
    expect(screen.getByText(/UPLOAD|上传/i)).toBeInTheDocument()
    // Last point's up = 120 → 120 B/s
    expect(screen.getAllByText(/120/).length).toBeGreaterThanOrEqual(1)
  })

  it('renders the DOWNLOAD label and current down speed', () => {
    render(<SpeedTile kind="down" history={points} viewport={SUMMARY} />)
    expect(screen.getByText(/DOWNLOAD|下载/i)).toBeInTheDocument()
    expect(screen.getAllByText(/150/).length).toBeGreaterThanOrEqual(1)
  })

  it('renders the area stroke at 2px for non-zero speeds', () => {
    const { container } = render(
      <SpeedTile kind="down" history={points} viewport={SUMMARY} />
    )
    const line = container.querySelector('.recharts-area-curve')
    expect(line).not.toBeNull()
    expect(line).toHaveAttribute('stroke-width', '2')
  })

  it('renders only the KPI and minimal chart treatment when compact', () => {
    render(<SpeedTile kind="up" history={points} viewport={COMPACT} />)

    expect(screen.queryByTestId('speed-scale')).not.toBeInTheDocument()
    expect(screen.queryByText(/Peak 120 B\/s|峰值 120 B\/s/i)).toBeNull()
    expect(
      screen.getByText('120').closest('[data-slot="tile-title"]')
    ).toHaveClass('h-8', 'text-[32px]')
    expect(screen.getByTestId('speed-chart')).toHaveClass('-top-6')
  })

  it('adds scale labels without peak detail for a summary presentation', () => {
    render(<SpeedTile kind="up" history={points} viewport={SUMMARY} />)

    expect(screen.getByTestId('speed-scale').children).toHaveLength(2)
    expect(screen.getByText('200 B/s')).toBeInTheDocument()
    expect(screen.queryByText(/Peak 120 B\/s|峰值 120 B\/s/i)).toBeNull()
  })

  it('shows peak detail in wide and square detailed presentations', () => {
    const { rerender } = render(
      <SpeedTile kind="up" history={points} viewport={WIDE_DETAILED} />
    )

    expect(screen.getByText(/Peak 120 B\/s|峰值 120 B\/s/i)).toBeInTheDocument()
    expect(screen.getByTestId('speed-chart')).toHaveClass('-top-10')

    rerender(
      <SpeedTile kind="up" history={points} viewport={SQUARE_DETAILED} />
    )
    expect(screen.getByTestId('speed-chart')).toHaveClass('top-8')
  })

  it('uses a richer scale in focus without recreating the chart', () => {
    const { container, rerender } = render(
      <SpeedTile kind="up" history={points} viewport={SUMMARY} />
    )
    const chart = container.querySelector('.recharts-wrapper')

    rerender(<SpeedTile kind="up" history={points} viewport={FOCUS} />)

    expect(screen.getByTestId('speed-scale').children).toHaveLength(3)
    expect(container.querySelector('.recharts-wrapper')).toBe(chart)
  })

  it('renders a flat zero state with no history', () => {
    render(<SpeedTile kind="up" history={[]} viewport={SUMMARY} />)
    expect(screen.getAllByText(/0\s*B\/s/).length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('1 B/s')).not.toBeInTheDocument()
  })
})
