import '@testing-library/jest-dom/vitest'
import { i18n } from '@renderer/lib/i18n'
import { DownloadErrorCode } from '@shared/errors'
import { TaskStatus } from '@shared/types/task'
import {
  TaskHistoryAccuracy,
  type TaskHistoryEvent,
  TaskHistoryEventKind,
} from '@shared/types/task-inspector-activity'
import { makeDownloadTask } from '@test-utils/task'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityTimeline } from './activity-timeline'
import { buildActivityTimelineModel } from './activity-timeline-model'

function event(
  ordinal: number,
  kind: TaskHistoryEventKind,
  status: TaskStatus,
  overrides: Partial<
    Pick<
      TaskHistoryEvent,
      'errorCode' | 'errorMessage' | 'errorDetailKey' | 'errorDetailParams'
    >
  > = {}
): TaskHistoryEvent {
  return {
    eventOrdinal: ordinal,
    eventKey: `event-${ordinal}`,
    kind,
    fromStatus: null,
    toStatus: status,
    occurredAt: ordinal * 1_000,
    accuracy: TaskHistoryAccuracy.Exact,
    errorCode:
      kind === TaskHistoryEventKind.Failed
        ? DownloadErrorCode.NetworkError
        : null,
    errorMessage:
      kind === TaskHistoryEventKind.Failed ? 'connection refused' : null,
    errorDetailKey: null,
    errorDetailParams: null,
    ...overrides,
  }
}

describe('ActivityTimeline', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('renders the full-width rail and opens opaque Failed detail', async () => {
    const user = userEvent.setup()
    const task = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Error,
      updatedAt: 2_000,
      errorCode: DownloadErrorCode.NetworkError,
      errorMessage: 'connection refused',
    })
    const model = buildActivityTimelineModel({
      events: [
        event(1, TaskHistoryEventKind.Added, TaskStatus.Queued),
        event(2, TaskHistoryEventKind.Failed, TaskStatus.Error),
      ],
      task,
      availableWidth: 700,
    })

    render(
      <ActivityTimeline
        model={model}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />
    )

    expect(screen.getByTestId('task-inspector-activity-timeline')).toHaveClass(
      'w-full'
    )
    const trigger = screen.getByTestId('activity-timeline-node-event-2')
    await user.click(trigger)

    const detail = screen.getByRole('dialog')
    expect(detail).toHaveClass('bg-popover', 'opacity-100')
    expect(
      screen.getByTestId('activity-timeline-error-reason')
    ).toHaveTextContent('Network connection failed')
    const technicalDetail = screen.getByTestId('activity-timeline-error-detail')
    expect(technicalDetail).toHaveTextContent('NETWORK')
    expect(technicalDetail).toHaveTextContent('connection refused')
  })

  it('resolves a localized failure reason instead of the raw DL_* enum', async () => {
    const user = userEvent.setup()
    const task = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Error,
      updatedAt: 2_000,
    })
    const model = buildActivityTimelineModel({
      events: [
        event(1, TaskHistoryEventKind.Added, TaskStatus.Queued),
        event(2, TaskHistoryEventKind.Failed, TaskStatus.Error, {
          errorCode: DownloadErrorCode.DiskFull,
          errorMessage: 'ENOSPC',
        }),
      ],
      task,
      availableWidth: 700,
    })

    render(
      <ActivityTimeline
        model={model}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />
    )

    await user.click(screen.getByTestId('activity-timeline-node-event-2'))

    expect(
      screen.getByTestId('activity-timeline-error-reason')
    ).toHaveTextContent('Disk is full')
    const technicalDetail = screen.getByTestId('activity-timeline-error-detail')
    expect(technicalDetail).toHaveTextContent('DL_DISK_FULL')
    expect(technicalDetail).toHaveTextContent('ENOSPC')
  })

  it('renders a diagnosis-carried errorDetailKey as the localized reason', async () => {
    const user = userEvent.setup()
    const task = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Error,
      updatedAt: 2_000,
    })
    const model = buildActivityTimelineModel({
      events: [
        event(1, TaskHistoryEventKind.Added, TaskStatus.Queued),
        event(2, TaskHistoryEventKind.Failed, TaskStatus.Error, {
          errorCode: null,
          errorMessage: null,
          errorDetailKey: 'task.error.detail.filesMissing',
        }),
      ],
      task,
      availableWidth: 700,
    })

    render(
      <ActivityTimeline
        model={model}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />
    )

    await user.click(screen.getByTestId('activity-timeline-node-event-2'))

    expect(
      screen.getByTestId('activity-timeline-error-reason')
    ).toHaveTextContent('Files are missing after the app restarted')
    expect(screen.queryByTestId('activity-timeline-error-detail')).toBeNull()
  })

  it('renders an errorMessage-only entry with a generic reason and the raw message as secondary', async () => {
    const user = userEvent.setup()
    const task = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Error,
      updatedAt: 2_000,
    })
    const model = buildActivityTimelineModel({
      events: [
        event(1, TaskHistoryEventKind.Added, TaskStatus.Queued),
        event(2, TaskHistoryEventKind.Failed, TaskStatus.Error, {
          errorCode: null,
          errorDetailKey: null,
          errorMessage: 'Failed to rename file: EACCES',
        }),
      ],
      task,
      availableWidth: 700,
    })

    render(
      <ActivityTimeline
        model={model}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />
    )

    await user.click(screen.getByTestId('activity-timeline-node-event-2'))

    expect(
      screen.getByTestId('activity-timeline-error-reason')
    ).toHaveTextContent('Download failed')
    expect(
      screen.getByTestId('activity-timeline-error-detail')
    ).toHaveTextContent('Failed to rename file: EACCES')
  })

  it('renders task history timestamps with 24-hour second precision', () => {
    const occurredAt = new Date(2026, 6, 30, 13, 4, 5).getTime()
    const added = {
      ...event(1, TaskHistoryEventKind.Added, TaskStatus.Queued),
      occurredAt,
    }
    const model = buildActivityTimelineModel({
      events: [added],
      task: makeDownloadTask({
        id: 'task-1',
        status: TaskStatus.Queued,
        updatedAt: occurredAt,
      }),
      availableWidth: 700,
    })

    render(
      <ActivityTimeline
        model={model}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />
    )

    expect(screen.getAllByText('13:04:05')).not.toHaveLength(0)
    expect(screen.queryByText(/AM|PM/)).toBeNull()
  })

  it('consumes Escape and restores focus to the nested detail trigger', async () => {
    const user = userEvent.setup()
    const model = buildActivityTimelineModel({
      events: [
        event(1, TaskHistoryEventKind.Added, TaskStatus.Queued),
        event(2, TaskHistoryEventKind.Failed, TaskStatus.Error),
      ],
      task: makeDownloadTask({
        id: 'task-1',
        status: TaskStatus.Error,
        updatedAt: 2_000,
      }),
      availableWidth: 700,
    })
    render(
      <ActivityTimeline
        model={model}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />
    )

    const trigger = screen.getByTestId('activity-timeline-node-event-2')
    await user.click(trigger)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(trigger).toHaveFocus()
  })

  it('exposes repeated and truncated nodes as keyboard-reachable controls', () => {
    const model = buildActivityTimelineModel({
      events: [
        event(1, TaskHistoryEventKind.Added, TaskStatus.Queued),
        event(2, TaskHistoryEventKind.Started, TaskStatus.Downloading),
        event(3, TaskHistoryEventKind.Paused, TaskStatus.Paused),
        event(4, TaskHistoryEventKind.Resumed, TaskStatus.Downloading),
        event(5, TaskHistoryEventKind.Paused, TaskStatus.Paused),
        event(6, TaskHistoryEventKind.Resumed, TaskStatus.Downloading),
        event(7, TaskHistoryEventKind.Paused, TaskStatus.Paused),
      ],
      task: makeDownloadTask({
        id: 'task-1',
        status: TaskStatus.Paused,
        updatedAt: 7_000,
      }),
      availableWidth: 700,
      historyDroppedCount: 12,
      historyTruncatedAt: 500,
    })

    render(
      <ActivityTimeline
        model={model}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />
    )

    expect(
      screen.getByTestId('activity-timeline-node-truncated-500')
    ).toHaveAttribute('type', 'button')
    expect(
      screen.getByTestId('activity-timeline-node-repeated-3-7')
    ).toHaveAttribute('type', 'button')
  })

  it('provides keyboard-reachable overflow controls and edge fades', async () => {
    const user = userEvent.setup()
    const model = buildActivityTimelineModel({
      events: Array.from({ length: 16 }, (_, index) =>
        event(
          index + 1,
          index === 0
            ? TaskHistoryEventKind.Added
            : index % 2 === 0
              ? TaskHistoryEventKind.Paused
              : TaskHistoryEventKind.Resumed,
          index % 2 === 0 ? TaskStatus.Paused : TaskStatus.Downloading
        )
      ),
      task: makeDownloadTask({
        id: 'task-1',
        status: TaskStatus.Downloading,
        updatedAt: 17_000,
      }),
      availableWidth: 220,
    })

    render(
      <ActivityTimeline
        model={model}
        selectedNodeId={null}
        onSelectNode={vi.fn()}
      />
    )

    const scroller = screen.getByTestId('activity-timeline-scroller')
    const scrollBy = vi.fn()
    Object.defineProperty(scroller, 'scrollBy', { value: scrollBy })

    expect(screen.getByTestId('activity-timeline-edge-start')).toBeVisible()
    expect(screen.getByTestId('activity-timeline-edge-end')).toBeVisible()
    await user.click(
      screen.getByRole('button', {
        name: 'Show previous timeline events',
      })
    )
    expect(scrollBy).toHaveBeenCalledWith({ left: -240 })

    await user.click(
      screen.getByRole('button', { name: 'Show next timeline events' })
    )
    expect(scrollBy).toHaveBeenCalledWith({ left: 240 })
  })

  it.each([
    {
      language: 'en-US',
      stage: 'Stage changed Metadata ready',
      observed: 'State recovered Paused',
    },
    {
      language: 'zh-CN',
      stage: '阶段已变化 元数据已就绪',
      observed: '状态已恢复 已暂停',
    },
  ])(
    'labels stage and recovered events by destination in $language',
    async ({ language, stage, observed }) => {
      await i18n.changeLanguage(language)
      const model = buildActivityTimelineModel({
        events: [
          event(1, TaskHistoryEventKind.Added, TaskStatus.Queued),
          event(2, TaskHistoryEventKind.StageChanged, TaskStatus.MetadataReady),
          event(3, TaskHistoryEventKind.ObservedState, TaskStatus.Paused),
        ],
        task: makeDownloadTask({
          id: 'task-1',
          status: TaskStatus.Downloading,
          updatedAt: 4_000,
        }),
        availableWidth: 700,
      })

      render(
        <ActivityTimeline
          model={model}
          selectedNodeId={null}
          onSelectNode={vi.fn()}
        />
      )

      expect(screen.getByText(stage)).toBeInTheDocument()
      const observedLabel = screen.getByText(observed)
      expect(observedLabel).toBeInTheDocument()
      expect(observedLabel).not.toHaveClass('truncate')
      expect(observedLabel).toHaveClass('[overflow-wrap:anywhere]')
    }
  )

  it.each([
    { count: 0, label: 'Earlier history truncated 0 events' },
    { count: 1, label: 'Earlier history truncated 1 event' },
    { count: 2, label: 'Earlier history truncated 2 events' },
  ])(
    'pluralizes a visible and accessible $count-event truncation',
    ({ count, label }) => {
      const base = buildActivityTimelineModel({
        events: [event(1, TaskHistoryEventKind.Added, TaskStatus.Queued)],
        task: makeDownloadTask({
          id: 'task-1',
          status: TaskStatus.Downloading,
          updatedAt: 2_000,
        }),
        availableWidth: 700,
        historyDroppedCount: 1,
        historyTruncatedAt: 500,
      })
      const model = {
        ...base,
        nodes: base.nodes.map((node) =>
          node.presentation === 'truncated' ? { ...node, count } : node
        ),
      }

      render(
        <ActivityTimeline
          model={model}
          selectedNodeId={null}
          onSelectNode={vi.fn()}
        />
      )

      expect(screen.getByText(label)).toBeInTheDocument()
      expect(
        screen.getByTestId('activity-timeline-node-truncated-500')
      ).toHaveAttribute('aria-label', expect.stringContaining(label))
    }
  )
})
