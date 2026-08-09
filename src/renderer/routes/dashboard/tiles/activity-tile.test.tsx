import '@renderer/lib/i18n'
import type { TaskActivityState } from '@renderer/hooks/use-task-activity'
import type { TaskActivitySnapshot } from '@shared/types/task-activity'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardTileViewport } from '../layout/dashboard-registry'
import { ActivityTile } from './activity-tile'

const hookHarness = vi.hoisted(() => ({
  state: null as TaskActivityState | null,
}))

vi.mock('@renderer/hooks/use-task-activity', () => ({
  useTaskActivity: () => hookHarness.state,
}))

vi.mock('../activity/activity-calendar', () => ({
  ActivityCalendar: ({
    contentLevel,
    interactive,
    className,
  }: {
    contentLevel: string
    interactive: boolean
    className?: string
  }) => (
    <div
      data-testid="activity-calendar-stub"
      data-content-level={contentLevel}
      data-interactive={String(interactive)}
      data-class-name={className}
    />
  ),
}))

const viewport: DashboardTileViewport = {
  span: { w: 1, h: 1 },
  orientation: 'square',
  contentLevel: 'compact',
}

function snapshot(coverageGapAt: number | null = null): TaskActivitySnapshot {
  return {
    generation: 'tile-test',
    revision: 1,
    coverage: {
      trackingStartedAt: new Date(2026, 0, 1).getTime(),
      coverageGapAt,
    },
    days: [],
  }
}

beforeEach(() => {
  hookHarness.state = {
    status: 'loading',
    retry: vi.fn().mockResolvedValue(undefined),
  }
})

describe('ActivityTile', () => {
  it('keeps a stable calendar footprint while loading', () => {
    render(<ActivityTile viewport={viewport} />)

    expect(
      screen
        .getByRole('status', { name: 'Loading activity' })
        .classList.contains('min-h-14')
    ).toBe(true)
    expect(screen.getByText('Activity')).not.toBeNull()
  })

  it('shows a localized first-load failure and retries', () => {
    const retry = vi.fn().mockResolvedValue(undefined)
    hookHarness.state = { status: 'unavailable', retry }

    render(<ActivityTile viewport={viewport} />)
    expect(screen.getByRole('alert').textContent).toContain(
      'Activity unavailable'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('renders the zero calendar and forwards presentation interaction', () => {
    hookHarness.state = {
      status: 'ready',
      snapshot: snapshot(),
      retry: vi.fn().mockResolvedValue(undefined),
    }
    const detailedViewport: DashboardTileViewport = {
      span: { w: 2, h: 2 },
      orientation: 'square',
      contentLevel: 'detailed',
    }

    render(<ActivityTile viewport={detailedViewport} interactive={false} />)

    expect(
      screen
        .getByTestId('activity-calendar-stub')
        .getAttribute('data-content-level')
    ).toBe('detailed')
    expect(
      screen
        .getByTestId('activity-calendar-stub')
        .getAttribute('data-interactive')
    ).toBe('false')
    expect(
      screen
        .getByText('Color intensity shows completed downloads')
        .classList.contains('sr-only')
    ).toBe(true)
  })

  it('keeps stale data, coverage disclosure, and Retry together', () => {
    const retry = vi.fn().mockResolvedValue(undefined)
    hookHarness.state = {
      status: 'stale',
      snapshot: snapshot(new Date(2026, 6, 29, 10).getTime()),
      retry,
    }

    render(<ActivityTile viewport={viewport} />)

    expect(screen.getByTestId('activity-calendar-stub')).not.toBeNull()
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('Activity may be out of date')
    expect(status.textContent).toContain('Activity may be incomplete since')
    expect(
      screen
        .getByTestId('activity-calendar-stub')
        .getAttribute('data-class-name')
    ).toContain('min-h-12')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('keeps persisted coverage degradation visible on ready data', () => {
    hookHarness.state = {
      status: 'ready',
      snapshot: snapshot(new Date(2026, 6, 29, 10).getTime()),
      retry: vi.fn().mockResolvedValue(undefined),
    }

    render(<ActivityTile viewport={viewport} />)
    expect(screen.getByRole('status').textContent).toContain(
      'Activity may be incomplete since'
    )
  })
})
