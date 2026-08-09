import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import type { SpeedPoint } from '@shared/types/stats'
import { TaskStatus } from '@shared/types/task'
import {
  TaskHistoryAccuracy,
  type TaskHistoryEvent,
  TaskHistoryEventKind,
  type TaskInspectorActivitySnapshot,
} from '@shared/types/task-inspector-activity'
import { makeDownloadTask } from '@test-utils/task'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hookState = vi.hoisted(() => ({
  activity: null as unknown,
  session: {
    history: [] as SpeedPoint[],
    isLoading: false,
  },
}))

vi.mock('@renderer/hooks/use-task-speed-history', () => ({
  useTaskSpeedHistory: () => hookState.session,
}))

vi.mock('@renderer/hooks/use-task-inspector-activity', () => ({
  useTaskInspectorActivity: () => hookState.activity,
}))

import { ActivityTab } from './activity-tab'

const BASE_TIME = 1_721_390_398_000

function event(
  eventOrdinal: number,
  kind: TaskHistoryEventKind,
  toStatus: TaskStatus,
  errorMessage: string | null = null
): TaskHistoryEvent {
  return {
    eventOrdinal,
    eventKey: `event-${eventOrdinal}`,
    kind,
    fromStatus: null,
    toStatus,
    occurredAt: BASE_TIME + eventOrdinal * 1_000,
    accuracy: TaskHistoryAccuracy.Exact,
    errorCode: errorMessage ? 'NETWORK' : null,
    errorMessage,
    errorDetailKey: null,
    errorDetailParams: null,
  }
}

interface SnapshotOptions {
  points?: TaskInspectorActivitySnapshot['lifetime']['points']
  events?: readonly TaskHistoryEvent[]
  coverageGapAt?: number | null
  historyDroppedCount?: number
  historyTruncatedAt?: number | null
}

function snapshot({
  points = [
    { t: BASE_TIME, down: 1_024, up: 128, flags: 0 },
    { t: BASE_TIME + 1_000, down: 2_048, up: 256, flags: 0 },
  ],
  events = [
    event(1, TaskHistoryEventKind.Added, TaskStatus.Queued),
    event(2, TaskHistoryEventKind.Started, TaskStatus.Downloading),
  ],
  coverageGapAt = null,
  historyDroppedCount = 0,
  historyTruncatedAt = null,
}: SnapshotOptions = {}): TaskInspectorActivitySnapshot {
  return {
    taskId: 't-1',
    revision: 3,
    summary: {
      trackingStartedAt: BASE_TIME,
      coverageGapAt,
      revision: 3,
      lastEventOrdinal: events.at(-1)?.eventOrdinal ?? 0,
      activeMs: 42_000,
      downloadActiveMs: 40_000,
      estimatedDownloadBytes: '122880',
      estimatedUploadBytes: '12288',
      peakDownloadBps: 4_096,
      peakUploadBps: 512,
      rawSampleCount: 12,
      historyDroppedCount,
      historyTruncatedAt,
      updatedAt: BASE_TIME + 2_000,
    },
    timeline: {
      events,
      trackingStartedAt: BASE_TIME,
      coverageGapAt,
      historyDroppedCount,
      historyTruncatedAt,
    },
    lifetime: {
      points,
      averageDownloadSpeed: 3_072,
      peakDownloadSpeed: 4_096,
      peakUploadSpeed: 512,
      activeMs: 42_000,
      updatedAt: BASE_TIME + 2_000,
      accuracy: 'estimated',
    },
  }
}

describe('ActivityTab', () => {
  beforeEach(() => {
    hookState.session = {
      history: [
        { t: BASE_TIME, down: 100, up: 10 },
        { t: BASE_TIME + 1_000, down: 200, up: 20 },
      ],
      isLoading: false,
    }
    hookState.activity = {
      status: 'ready',
      snapshot: snapshot(),
    }
  })

  it('composes the transfer surface without rendering Task history', () => {
    const { container } = render(
      <ActivityTab
        task={makeDownloadTask({
          id: 't-1',
          updatedAt: BASE_TIME + 3_000,
          downloadSpeed: 150,
          uploadSpeed: 15,
        })}
      />
    )

    const root = screen.getByTestId('task-inspector-activity-root')
    const layout = screen.getByTestId('task-inspector-activity-layout')
    const transfer = screen.getByTestId('task-inspector-activity-transfer-card')
    const transferSurface = screen.getByTestId(
      'task-inspector-activity-transfer-surface'
    )

    expect(root).toHaveClass('@container/activity')
    expect(
      screen.queryByTestId('task-inspector-activity-timeline')
    ).not.toBeInTheDocument()
    expect(layout).toHaveClass('min-w-0')
    expect(layout).not.toHaveClass('grid', 'grid-cols-1')
    expect(transfer).toHaveClass('@container/transfer')
    expect(transfer).not.toHaveClass('border', 'p-3')
    expect(transferSurface.className).not.toContain('@[420px]/transfer:p-4')
    expect(transferSurface).toContainElement(
      screen.getByTestId('task-inspector-activity-summary-card')
    )
    expect(container.querySelectorAll('.recharts-area')).toHaveLength(0)
    expect(container.querySelectorAll('.recharts-bar')).toHaveLength(2)
    expect(screen.getByRole('radio', { name: 'Lifetime' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('uses a quiet final-geometry skeleton without fake zero metrics', () => {
    hookState.activity = { status: 'loading', snapshot: null }
    hookState.session = { history: [], isLoading: true }

    render(
      <ActivityTab
        task={makeDownloadTask({
          id: 't-1',
          downloadSpeed: 0,
          uploadSpeed: 0,
        })}
      />
    )

    expect(screen.getByTestId('task-inspector-activity-root')).toBeVisible()
    expect(
      screen.getAllByTestId('task-inspector-activity-skeleton')
    ).toHaveLength(1)
    expect(
      within(screen.getByTestId('task-inspector-activity-root')).queryByText(
        '0 B/s'
      )
    ).toBeNull()
  })

  it('keeps distinct Lifetime and Session empty states', async () => {
    const user = userEvent.setup()
    hookState.activity = {
      status: 'ready',
      snapshot: snapshot({ points: [] }),
    }
    hookState.session = { history: [], isLoading: false }

    render(
      <ActivityTab
        task={makeDownloadTask({
          id: 't-1',
          status: TaskStatus.Downloading,
          updatedAt: BASE_TIME + 3_000,
        })}
      />
    )

    expect(
      screen.getByText('Lifetime history is not available yet.')
    ).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'Session(60s)' }))
    expect(screen.getByText('Collecting transfer data…')).toBeInTheDocument()
  })

  it('shows the live Session tail in Lifetime before the first durable checkpoint', () => {
    hookState.activity = {
      status: 'ready',
      snapshot: snapshot({ points: [] }),
    }
    hookState.session = {
      history: [
        { t: BASE_TIME, down: 1_024, up: 128 },
        { t: BASE_TIME + 1_000, down: 2_048, up: 256 },
      ],
      isLoading: false,
    }

    render(
      <ActivityTab
        task={makeDownloadTask({
          id: 't-1',
          status: TaskStatus.Downloading,
          updatedAt: BASE_TIME + 1_000,
          downloadSpeed: 2_048,
          uploadSpeed: 256,
        })}
      />
    )

    expect(
      screen.queryByText('Lifetime history is not available yet.')
    ).toBeNull()
    expect(
      screen.getByRole('heading', { name: 'Lifetime transfer' })
    ).toBeInTheDocument()
    expect(screen.getByText('Adaptive resolution · 2 samples')).toBeVisible()
  })

  it('keeps Session usable and exposes Retry when Lifetime is unavailable', async () => {
    const retry = vi.fn()
    const user = userEvent.setup()
    hookState.activity = {
      status: 'unavailable',
      snapshot: null,
      retry,
    }

    render(
      <ActivityTab
        task={makeDownloadTask({
          id: 't-1',
          updatedAt: BASE_TIME + 3_000,
        })}
      />
    )

    expect(
      screen.getByText('Lifetime activity is unavailable.')
    ).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Session(60s)' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByRole('radio', { name: 'Lifetime' })).toBeDisabled()
    expect(screen.getAllByRole('img')).not.toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('preserves stale data and discloses coverage gaps and truncation', async () => {
    const retry = vi.fn()
    const user = userEvent.setup()
    hookState.activity = {
      status: 'stale',
      snapshot: snapshot({
        coverageGapAt: BASE_TIME + 500,
        historyDroppedCount: 12,
        historyTruncatedAt: BASE_TIME - 1_000,
      }),
      retry,
    }

    render(
      <ActivityTab
        task={makeDownloadTask({
          id: 't-1',
          updatedAt: BASE_TIME + 3_000,
        })}
      />
    )

    expect(screen.getByText(/Data may be out of date/)).toBeInTheDocument()
    expect(screen.getByText('Tracking was interrupted.')).toBeInTheDocument()
    expect(
      screen.getByRole('img', {
        name: /Earlier history truncated 12 events/,
      })
    ).toBeInTheDocument()
    expect(screen.queryByText('Earlier history truncated 12 events')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('zeros stopped live speeds while retaining final lifetime metrics', () => {
    render(
      <ActivityTab
        task={makeDownloadTask({
          id: 't-1',
          status: TaskStatus.Paused,
          updatedAt: BASE_TIME + 3_000,
          downloadSpeed: 9_999,
          uploadSpeed: 8_888,
        })}
      />
    )

    expect(
      within(
        screen.getByTestId('task-inspector-activity-summary-card')
      ).getAllByText('0 B/s')
    ).toHaveLength(2)
    expect(screen.getByText('3.0 KB/s')).toBeInTheDocument()
    expect(screen.getByText('4.0 KB/s')).toBeInTheDocument()
  })

  it('does not render Failed timeline details while Task history is hidden', () => {
    hookState.activity = {
      status: 'ready',
      snapshot: snapshot({
        events: [
          event(1, TaskHistoryEventKind.Added, TaskStatus.Queued),
          event(2, TaskHistoryEventKind.Started, TaskStatus.Downloading),
          event(
            3,
            TaskHistoryEventKind.Failed,
            TaskStatus.Error,
            'connection refused'
          ),
        ],
      }),
    }

    render(
      <ActivityTab
        task={makeDownloadTask({
          id: 't-1',
          status: TaskStatus.Error,
          updatedAt: BASE_TIME + 3_000,
          errorMessage: 'connection refused',
        })}
      />
    )

    expect(
      screen.queryByTestId('task-inspector-activity-timeline')
    ).not.toBeInTheDocument()
    expect(screen.queryByText('connection refused')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps lifecycle chart markers while Task history is hidden', () => {
    const denseEvents = [
      event(1, TaskHistoryEventKind.Added, TaskStatus.Queued),
      event(2, TaskHistoryEventKind.Started, TaskStatus.Downloading),
      ...Array.from({ length: 18 }, (_, index) =>
        event(
          index + 3,
          index % 2 === 0
            ? TaskHistoryEventKind.Paused
            : TaskHistoryEventKind.Resumed,
          index % 2 === 0 ? TaskStatus.Paused : TaskStatus.Downloading
        )
      ),
    ]
    hookState.activity = {
      status: 'ready',
      snapshot: snapshot({
        events: denseEvents,
        points: [
          { t: BASE_TIME, down: 1_024, up: 128, flags: 0 },
          { t: BASE_TIME + 25_000, down: 2_048, up: 256, flags: 0 },
        ],
      }),
    }

    const { container } = render(
      <ActivityTab
        task={makeDownloadTask({
          id: 't-1',
          status: TaskStatus.Downloading,
          updatedAt: BASE_TIME + 25_000,
        })}
      />
    )

    expect(
      screen.queryByTestId('task-inspector-activity-timeline')
    ).not.toBeInTheDocument()
    expect(
      container.querySelectorAll(
        '.activity-chart-marker, .activity-chart-marker-selected'
      ).length
    ).toBeGreaterThan(0)
    expect(
      container.querySelector(
        '[data-testid^="activity-timeline-node-cluster-"]'
      )
    ).toBeNull()
  })
})
