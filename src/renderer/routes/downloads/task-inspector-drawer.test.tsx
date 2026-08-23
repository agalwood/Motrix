import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { createSelectionStore } from '@renderer/components/desktop-kit/selection/create-selection-store'
import type { SelectionStore } from '@renderer/components/desktop-kit/selection/types'
import { DownloadErrorCode } from '@shared/errors'
import type { DownloadTask } from '@shared/types/task'
import { TaskKind, TaskStatus, TaskType } from '@shared/types/task'
import {
  TaskHistoryAccuracy,
  TaskHistoryEventKind,
  type TaskInspectorActivitySnapshot,
} from '@shared/types/task-inspector-activity'
import { makeDownloadTask } from '@test-utils/task'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskInspectorDrawer } from './task-inspector-drawer'

const activityHookState = vi.hoisted(() => ({
  current: null as unknown,
  calls: [] as unknown[][],
}))

vi.mock('@renderer/hooks/use-task-pieces', () => ({
  useTaskPieces: () => ({ pieces: null }),
}))
vi.mock('@renderer/hooks/use-task-speed-history', () => ({
  useTaskSpeedHistory: () => ({ history: [], isLoading: false }),
}))
vi.mock('@renderer/hooks/use-task-inspector-activity', () => ({
  createTaskInspectorActivitySnapshotCache: () => ({ cache: true }),
  useTaskInspectorActivity: (...args: unknown[]) => {
    activityHookState.calls.push(args)
    return activityHookState.current
  },
}))

const BASE_TIME = 1_721_390_398_000

function activitySnapshot(failed = false): TaskInspectorActivitySnapshot {
  const events = [
    {
      eventOrdinal: 1,
      eventKey: 'event-1',
      kind: TaskHistoryEventKind.Added,
      fromStatus: null,
      toStatus: TaskStatus.Queued,
      occurredAt: BASE_TIME,
      accuracy: TaskHistoryAccuracy.Exact,
      errorCode: null,
      errorMessage: null,
      errorDetailKey: null,
      errorDetailParams: null,
    },
    ...(failed
      ? [
          {
            eventOrdinal: 3,
            eventKey: 'event-3',
            kind: TaskHistoryEventKind.Failed,
            fromStatus: TaskStatus.Downloading,
            toStatus: TaskStatus.Error,
            occurredAt: BASE_TIME + 2_000,
            accuracy: TaskHistoryAccuracy.Exact,
            errorCode: DownloadErrorCode.NetworkError,
            errorMessage: 'connection refused',
            errorDetailKey: null,
            errorDetailParams: null,
          },
        ]
      : []),
  ]

  return {
    taskId: 'a',
    revision: 2,
    summary: {
      trackingStartedAt: BASE_TIME,
      coverageGapAt: null,
      revision: 2,
      lastEventOrdinal: events.at(-1)?.eventOrdinal ?? 0,
      activeMs: 0,
      downloadActiveMs: 0,
      estimatedDownloadBytes: '0',
      estimatedUploadBytes: '0',
      peakDownloadBps: 0,
      peakUploadBps: 0,
      rawSampleCount: 0,
      historyDroppedCount: 0,
      historyTruncatedAt: null,
      updatedAt: BASE_TIME + 2_000,
    },
    timeline: {
      events,
      trackingStartedAt: BASE_TIME,
      coverageGapAt: null,
      historyDroppedCount: 0,
      historyTruncatedAt: null,
    },
    lifetime: {
      points: [],
      averageDownloadSpeed: 0,
      peakDownloadSpeed: 0,
      peakUploadSpeed: 0,
      activeMs: 0,
      updatedAt: BASE_TIME + 2_000,
      accuracy: 'estimated',
    },
  }
}

function fake(over: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask({
    id: 'a',
    engineTaskId: 'g',
    name: 'demo',
    progress: 0.5,
    totalBytes: 100,
    downloadedBytes: 50,
    downloadSpeed: 10,
    etaSeconds: 5,
    saveDir: '/',
    uris: [''],
    fileCount: 1,
    filename: 'demo',
    sizeWhenDone: 100,
    diskPath: '/demo',
    finalPath: '/demo',
    finalName: 'demo',
    ...over,
  })
}

function TestHarness({
  selection,
  tasks,
  onDismiss,
}: {
  selection: SelectionStore<DownloadTask>
  tasks: readonly DownloadTask[]
  onDismiss?: () => void
}) {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  return (
    <div ref={setContainer}>
      <TaskInspectorDrawer
        selection={selection}
        tasks={tasks}
        container={container}
        onDismiss={onDismiss}
      />
    </div>
  )
}

describe('TaskInspectorDrawer', () => {
  beforeEach(() => {
    activityHookState.calls.length = 0
    activityHookState.current = {
      status: 'ready',
      snapshot: activitySnapshot(),
    }
  })

  it('does not render drawer content when selection is empty', () => {
    const selection = createSelectionStore<DownloadTask>((t) => t.id)
    render(<TestHarness selection={selection} tasks={[fake()]} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders single-mode body with Overview tab active when one task selected', () => {
    const selection = createSelectionStore<DownloadTask>((t) => t.id)
    const tasks = [fake({ id: 'a' })]
    selection.getState().setItems([...tasks])
    selection.getState().select('a')
    render(<TestHarness selection={selection} tasks={tasks} />)
    expect(screen.getByRole('tab', { name: /overview/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('shows Pieces for a direct HTTP task', () => {
    const selection = createSelectionStore<DownloadTask>((t) => t.id)
    const tasks = [
      fake({ id: 'a', type: TaskType.Http, kind: TaskKind.Direct }),
    ]
    selection.getState().setItems([...tasks])
    selection.getState().select('a')

    render(<TestHarness selection={selection} tasks={tasks} />)

    expect(screen.getByRole('tab', { name: /pieces/i })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /peers/i })).toBeNull()
    expect(screen.queryByRole('tab', { name: /trackers/i })).toBeNull()
  })

  it('does not show Pieces for a multi-instance HTTP media task', () => {
    const selection = createSelectionStore<DownloadTask>((t) => t.id)
    const tasks = [fake({ id: 'a', type: TaskType.Http, kind: TaskKind.Hls })]
    selection.getState().setItems([...tasks])
    selection.getState().select('a')

    render(<TestHarness selection={selection} tasks={tasks} />)

    expect(screen.queryByRole('tab', { name: /pieces/i })).toBeNull()
  })

  it('reuses one keyed Activity cache across tab remounts', async () => {
    const user = userEvent.setup()
    const selection = createSelectionStore<DownloadTask>((t) => t.id)
    const tasks = [fake({ id: 'a' })]
    selection.getState().setItems([...tasks])
    selection.getState().select('a')
    render(<TestHarness selection={selection} tasks={tasks} />)

    expect(activityHookState.calls).toHaveLength(0)
    await user.click(screen.getByRole('tab', { name: /activity/i }))
    expect(activityHookState.calls.length).toBeGreaterThan(0)
    const firstCache = activityHookState.calls[0]?.[1]
    const firstMountCallCount = activityHookState.calls.length
    await user.click(screen.getByRole('tab', { name: /overview/i }))
    await user.click(screen.getByRole('tab', { name: /activity/i }))

    expect(activityHookState.calls.length).toBeGreaterThan(firstMountCallCount)
    expect(firstCache).toBeDefined()
    expect(
      activityHookState.calls
        .slice(firstMountCallCount)
        .every((call) => call[1] === firstCache)
    ).toBe(true)
  })

  it('hides folder reveal path for metadata-only tasks', () => {
    const selection = createSelectionStore<DownloadTask>((t) => t.id)
    const tasks = [
      fake({
        id: 'a',
        type: TaskType.Magnet,
        status: TaskStatus.FetchingMetadata,
        diskPath: '/',
      }),
    ]
    selection.getState().setItems([...tasks])
    selection.getState().select('a')
    render(<TestHarness selection={selection} tasks={tasks} />)

    expect(screen.queryByRole('button', { name: '/' })).toBeNull()
  })

  it('shows the final BT destination instead of its internal workspace', () => {
    const selection = createSelectionStore<DownloadTask>((t) => t.id)
    const tasks = [
      fake({
        id: 'a',
        type: TaskType.Bt,
        kind: TaskKind.Bt,
        diskPath: '/downloads/.motrix/61282448e78c1fc29ac1/p',
        finalPath: '/downloads/sample-data',
      }),
    ]
    selection.getState().setItems([...tasks])
    selection.getState().select('a')

    render(<TestHarness selection={selection} tasks={tasks} />)

    expect(screen.getByText('/downloads/sample-data')).toBeInTheDocument()
    expect(
      screen.queryByText('/downloads/.motrix/61282448e78c1fc29ac1/p')
    ).not.toBeInTheDocument()
  })

  it('does not switch inspector content during marquee preview', () => {
    const selection = createSelectionStore<DownloadTask>((t) => t.id)
    const tasks = [
      fake({ id: 'a', name: 'alpha', diskPath: '/alpha' }),
      fake({ id: 'b', name: 'beta', diskPath: '/beta' }),
      fake({ id: 'c', name: 'gamma', diskPath: '/gamma' }),
    ]
    selection.getState().setItems([...tasks])
    selection.getState().select('a')
    render(<TestHarness selection={selection} tasks={tasks} />)

    expect(screen.getByText('alpha')).toBeInTheDocument()

    act(() => {
      selection.getState().marqueeSelect(1, 2)
    })

    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.queryByText('beta')).not.toBeInTheDocument()

    act(() => {
      selection.getState().marqueeEnd()
    })

    expect(screen.queryByText('alpha')).not.toBeInTheDocument()
    expect(screen.getByText(/total size/i)).toBeInTheDocument()
  })

  it('clears selection and calls the optional dismissal callback', () => {
    const selection = createSelectionStore<DownloadTask>((t) => t.id)
    const tasks = [fake({ id: 'a' })]
    const onDismiss = vi.fn()
    selection.getState().setItems([...tasks])
    selection.getState().select('a')
    render(
      <TestHarness selection={selection} tasks={tasks} onDismiss={onDismiss} />
    )

    act(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    )

    expect(selection.getState().committedSelectedIds).toEqual(new Set())
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('dismisses directly from Activity while Task history is hidden', async () => {
    const user = userEvent.setup()
    const selection = createSelectionStore<DownloadTask>((t) => t.id)
    const tasks = [
      fake({
        id: 'a',
        status: TaskStatus.Error,
        updatedAt: BASE_TIME + 2_000,
        errorCode: DownloadErrorCode.NetworkError,
        errorMessage: 'connection refused',
      }),
    ]
    const onDismiss = vi.fn()
    activityHookState.current = {
      status: 'ready',
      snapshot: activitySnapshot(true),
    }
    selection.getState().setItems([...tasks])
    selection.getState().select('a')
    render(
      <TestHarness selection={selection} tasks={tasks} onDismiss={onDismiss} />
    )

    await user.click(screen.getByRole('tab', { name: /activity/i }))
    expect(
      screen.queryByTestId('task-inspector-activity-timeline')
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Failed details' })).toBeNull()

    await user.keyboard('{Escape}')
    expect(selection.getState().committedSelectedIds).toEqual(new Set())
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('allows Activity to use more drawer height without changing other tabs', async () => {
    const user = userEvent.setup()
    const selection = createSelectionStore<DownloadTask>((t) => t.id)
    const tasks = [fake({ id: 'a' })]
    selection.getState().setItems([...tasks])
    selection.getState().select('a')
    render(<TestHarness selection={selection} tasks={tasks} />)

    const drawer = screen.getByRole('dialog')
    expect(drawer).toHaveClass('max-h-[80%]')
    expect(drawer).not.toHaveClass('max-h-[85%]')

    await user.click(screen.getByRole('tab', { name: /activity/i }))

    expect(drawer).toHaveClass('max-h-[85%]')
    expect(drawer).not.toHaveClass('max-h-[80%]')
  })
})
