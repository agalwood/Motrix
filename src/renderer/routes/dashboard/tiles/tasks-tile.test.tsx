import '@testing-library/jest-dom/vitest'
import { i18n } from '@renderer/lib/i18n'
import { DownloadErrorCode } from '@shared/errors'
import {
  type BtExtension,
  type DownloadTask,
  TaskStatus,
  TaskType,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardTileViewport } from '../layout/dashboard-registry'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openAddTaskDialog: vi.fn(),
  retry: vi.fn(async () => {}),
  now: { current: Date.UTC(2026, 6, 27, 8, 0, 0) },
  useRealMinuteClock: { current: false },
  projectCalls: [] as Array<{
    taskCount: number
    view: string
    limit: number
  }>,
  taskList: {
    current: {
      tasks: [] as readonly DownloadTask[],
      status: 'ready' as 'loading' | 'ready' | 'error',
      hasReadySnapshot: true,
    },
  },
}))

vi.mock('react-router', async () => {
  const actual =
    await vi.importActual<typeof import('react-router')>('react-router')
  return { ...actual, useNavigate: () => mocks.navigate }
})

vi.mock('@renderer/hooks/use-task-list', () => ({
  useTaskList: () => ({
    ...mocks.taskList.current,
    retry: mocks.retry,
    revision: 0,
    hasAnyActive: false,
    hasAnyPaused: false,
    hasStopped: false,
  }),
}))

vi.mock('@renderer/hooks/use-minute-clock', async () => {
  const actual = await vi.importActual<
    typeof import('@renderer/hooks/use-minute-clock')
  >('@renderer/hooks/use-minute-clock')
  return {
    ...actual,
    useMinuteClock: () => {
      const actualNow = actual.useMinuteClock()
      return mocks.useRealMinuteClock.current ? actualNow : mocks.now.current
    },
  }
})

vi.mock('@renderer/lib/task-views', async () => {
  const actual = await vi.importActual<
    typeof import('@renderer/lib/task-views')
  >('@renderer/lib/task-views')
  return {
    ...actual,
    projectTaskWindow: (
      ...args: Parameters<typeof actual.projectTaskWindow>
    ): ReturnType<typeof actual.projectTaskWindow> => {
      mocks.projectCalls.push({
        taskCount: args[0].length,
        view: args[1],
        limit: args[2],
      })
      return actual.projectTaskWindow(...args)
    },
  }
})

vi.mock('@renderer/lib/open-add-task-dialog', () => ({
  openAddTaskDialog: mocks.openAddTaskDialog,
}))

import { __resetMinuteClockForTests } from '@renderer/hooks/use-minute-clock'
import { TasksTile } from './tasks-tile'

const VIEWPORTS = {
  '2x1': {
    span: { w: 2, h: 1 },
    orientation: 'wide',
    contentLevel: 'summary',
  },
  '2x2': {
    span: { w: 2, h: 2 },
    orientation: 'square',
    contentLevel: 'detailed',
  },
  '2x3': {
    span: { w: 2, h: 3 },
    orientation: 'tall',
    contentLevel: 'focus',
  },
  '3x2': {
    span: { w: 3, h: 2 },
    orientation: 'wide',
    contentLevel: 'focus',
  },
  '3x3': {
    span: { w: 3, h: 3 },
    orientation: 'square',
    contentLevel: 'focus',
  },
  '4x2': {
    span: { w: 4, h: 2 },
    orientation: 'wide',
    contentLevel: 'focus',
  },
} as const satisfies Record<string, DashboardTileViewport>

function bt(ratio: number): BtExtension {
  return {
    peers: 1,
    seeds: 2,
    ratio,
    trackers: [],
    selectedFiles: [],
    peersInSwarm: 2,
    seedsInSwarm: 4,
    announceList: [],
    comment: null,
    isPrivate: false,
    magnetUri: null,
    sequentialDownload: false,
  }
}

function task(
  id: string,
  status: TaskStatus = TaskStatus.Downloading,
  overrides: Partial<DownloadTask> = {}
): DownloadTask {
  return makeDownloadTask({
    id,
    engineTaskId: `gid-${id}`,
    name: `${id}.iso`,
    status,
    type: TaskType.Http,
    progress: 0.5,
    totalBytes: 1_000,
    downloadedBytes: 500,
    downloadSpeed: 2_048,
    uploadSpeed: 1_024,
    etaSeconds: 90,
    createdAt: 100,
    updatedAt: 200,
    finishedAt:
      status === TaskStatus.Completed || status === TaskStatus.Error
        ? mocks.now.current - 5 * 60_000
        : null,
    sizeWhenDone: status === TaskStatus.Completed ? 1_000 : 0,
    ...overrides,
  })
}

function setSource(
  tasks: readonly DownloadTask[],
  status: 'loading' | 'ready' | 'error' = 'ready',
  hasReadySnapshot = true
): void {
  mocks.taskList.current = { tasks, status, hasReadySnapshot }
}

function renderTile({
  viewport = VIEWPORTS['2x2'],
  engineOnline = true,
  initialEntry = '/',
}: {
  viewport?: DashboardTileViewport
  engineOnline?: boolean
  initialEntry?: string
} = {}) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <TasksTile engineOnline={engineOnline} viewport={viewport} />
    </MemoryRouter>
  )
}

describe('TasksTile', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
    mocks.navigate.mockReset()
    mocks.openAddTaskDialog.mockReset()
    mocks.retry.mockClear()
    mocks.now.current = Date.UTC(2026, 6, 27, 8, 0, 0)
    mocks.useRealMinuteClock.current = false
    mocks.projectCalls.length = 0
    setSource([])
  })

  afterEach(() => {
    cleanup()
    __resetMinuteClockForTests()
    vi.useRealTimers()
  })

  it('exposes a three-option radio control with Active selected', () => {
    renderTile()

    const group = screen.getByRole('radiogroup', { name: 'Task view' })
    expect(within(group).getAllByRole('radio')).toHaveLength(3)
    expect(
      within(group).getByRole('radio', { name: 'Active' })
    ).toHaveAttribute('aria-checked', 'true')
  })

  it('renders every Active status with honest metrics and one real progress bar', () => {
    setSource([
      task('ready', TaskStatus.MetadataReady, { priority: 7 }),
      task('downloading', TaskStatus.Downloading, { priority: 6 }),
      task('metadata', TaskStatus.FetchingMetadata, {
        priority: 5,
        metadataProgress: 0.37,
      }),
      task('finalizing', TaskStatus.Finalizing, { priority: 4 }),
      task('seeding', TaskStatus.Seeding, {
        priority: 3,
        type: TaskType.Bt,
        bt: bt(1.25),
      }),
      task('queued', TaskStatus.Queued, { priority: 2 }),
      task('paused', TaskStatus.Paused, { priority: 1, progress: 0.68 }),
    ])
    renderTile({ viewport: VIEWPORTS['2x3'] })

    expect(screen.getAllByTestId('tasks-row')).toHaveLength(7)
    expect(screen.getByText('Fetching')).toBeInTheDocument()
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByText('Finalizing')).toBeInTheDocument()
    expect(screen.getByText('Queued')).toBeInTheDocument()
    expect(screen.getByText('Paused')).toBeInTheDocument()
    expect(screen.getByText('68% saved')).toBeInTheDocument()
    expect(screen.getByText('Seeding · Ratio 1.25')).toBeInTheDocument()
    expect(screen.queryByText('37%')).toBeNull()
    expect(screen.getAllByRole('progressbar')).toHaveLength(1)
    const progress = screen.getByRole('progressbar', {
      name: 'downloading.iso progress',
    })
    expect(progress).toHaveAttribute('aria-valuenow', '50')
    expect(progress).toHaveClass('left-[26px]', 'right-1', 'w-auto')
  })

  it('keeps ordering stable when only speed and progress change', () => {
    const first = [
      task('older', TaskStatus.Downloading, {
        createdAt: 10,
        downloadSpeed: 1,
      }),
      task('newer', TaskStatus.Downloading, {
        createdAt: 20,
        downloadSpeed: 10_000,
      }),
    ]
    setSource(first)
    const rendered = renderTile()
    expect(
      screen.getAllByTestId('tasks-row').map((row) => row.dataset.taskId)
    ).toEqual(['older', 'newer'])

    setSource([
      { ...first[0], downloadSpeed: 50_000, progress: 0.9 },
      { ...first[1], downloadSpeed: 0, progress: 0.1 },
    ])
    rendered.rerender(
      <MemoryRouter>
        <TasksTile engineOnline viewport={VIEWPORTS['2x2']} />
      </MemoryRouter>
    )

    expect(
      screen.getAllByTestId('tasks-row').map((row) => row.dataset.taskId)
    ).toEqual(['older', 'newer'])
  })

  it.each([
    ['2x1', 3],
    ['2x2', 4],
    ['2x3', 7],
    ['3x2', 5],
    ['3x3', 8],
    ['4x2', 6],
  ] as const)(
    'reserves the final %s slot for overflow',
    (viewportKey, limit) => {
      setSource(
        Array.from({ length: 10 }, (_, index) =>
          task(`task-${index}`, TaskStatus.Downloading, {
            createdAt: index + 1,
          })
        )
      )
      renderTile({ viewport: VIEWPORTS[viewportKey] })

      expect(screen.getAllByTestId('tasks-row')).toHaveLength(limit - 1)
      expect(screen.getByTestId('tasks-more')).toHaveTextContent(
        `${10 - (limit - 1)} more`
      )
    }
  )

  it('uses summary rows without glyphs, secondary copy, or progress', () => {
    setSource([task('summary')])
    renderTile({ viewport: VIEWPORTS['2x1'] })

    const list = screen.getByTestId('tasks-list')
    expect(list.querySelector('svg')).toBeNull()
    expect(list.querySelector('[aria-hidden]')).not.toHaveTextContent(/ETA/i)
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('separates Failed and Recent without meaningless progress', async () => {
    const user = userEvent.setup()
    setSource([
      task('failed', TaskStatus.Error, {
        errorMessage: 'Connection refused',
        errorCode: DownloadErrorCode.NetworkError,
        finishedAt: mocks.now.current - 5 * 60_000,
      }),
      task('failed-generic', TaskStatus.Error, {
        errorMessage: '',
        finishedAt: mocks.now.current - 10 * 60_000,
      }),
      task('complete', TaskStatus.Completed, {
        sizeWhenDone: 0,
        totalBytes: 2_048,
        finishedAt: mocks.now.current - 15 * 60_000,
      }),
    ])
    renderTile()

    await user.click(screen.getByRole('radio', { name: 'Failed' }))
    expect(screen.getAllByTestId('tasks-row')).toHaveLength(2)
    expect(
      screen.getByText('Failed: Network connection failed')
    ).toBeInTheDocument()
    expect(screen.getByText('Failed: Download failed')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'failed.iso, Error' })
    ).toHaveAccessibleDescription(
      '5 min. ago. Failed: Network connection failed. Technical detail: Connection refused'
    )
    expect(screen.queryByRole('progressbar')).toBeNull()

    await user.click(screen.getByRole('radio', { name: 'Recent' }))
    expect(screen.getAllByTestId('tasks-row')).toHaveLength(1)
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    expect(screen.getAllByText(/Completed/)).toHaveLength(2)
    expect(screen.queryByText('Connection refused')).toBeNull()
  })

  it('keeps cached rows offline while hiding speed and ETA', () => {
    setSource([task('offline', TaskStatus.Downloading)])
    renderTile({ engineOnline: false })

    expect(screen.getByText('—')).toBeInTheDocument()
    expect(
      screen.getByText('Offline · last known progress')
    ).toBeInTheDocument()
    expect(screen.queryByText(/KB\/s/)).toBeNull()
    expect(screen.queryByText(/ETA/)).toBeNull()
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
  })

  it('renders loading, initial failure, and cached failure honestly', async () => {
    const user = userEvent.setup()
    setSource([], 'loading', false)
    const rendered = renderTile()
    expect(screen.getByRole('list', { name: 'Loading tasks' })).toHaveAttribute(
      'aria-busy',
      'true'
    )
    expect(screen.getByRole('status')).toHaveTextContent('Loading tasks')
    expect(screen.queryByText('No active tasks')).toBeNull()

    setSource([], 'error', false)
    rendered.rerender(
      <MemoryRouter>
        <TasksTile engineOnline viewport={VIEWPORTS['2x2']} />
      </MemoryRouter>
    )
    expect(screen.getByText('Tasks unavailable')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mocks.retry).toHaveBeenCalledOnce()

    setSource([task('cached')], 'error', true)
    rendered.rerender(
      <MemoryRouter>
        <TasksTile engineOnline viewport={VIEWPORTS['2x2']} />
      </MemoryRouter>
    )
    expect(screen.getByTestId('tasks-row')).toHaveAttribute(
      'data-task-id',
      'cached'
    )
    expect(screen.queryByText('Tasks unavailable')).toBeNull()
  })

  it('shows view-specific empty states and uses the shared New Task helper', async () => {
    const user = userEvent.setup()
    renderTile()
    expect(screen.getByText('No active tasks')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('No active tasks')

    await user.click(screen.getByRole('button', { name: '+ New task' }))
    expect(mocks.openAddTaskDialog).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('radio', { name: 'Failed' }))
    expect(screen.getByText('No failed tasks')).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'Recent' }))
    expect(screen.getByText('Nothing completed yet')).toBeInTheDocument()
  })

  it('shows only Engine offline for an empty offline Active view', () => {
    renderTile({ engineOnline: false })

    expect(screen.getByText('Engine offline')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /New task/i })).toBeNull()
    expect(screen.queryByText(/Updates paused/i)).toBeNull()
  })

  it('navigates rows and overflow to the matching Downloads filters', async () => {
    const user = userEvent.setup()
    setSource([
      task('one', TaskStatus.Downloading, { createdAt: 1 }),
      task('two', TaskStatus.Downloading, { createdAt: 2 }),
      task('three', TaskStatus.Downloading, { createdAt: 3 }),
      task('four', TaskStatus.Downloading, { createdAt: 4 }),
    ])
    renderTile({ viewport: VIEWPORTS['2x1'] })

    await user.click(screen.getAllByTestId('tasks-row')[0])
    expect(mocks.navigate).toHaveBeenCalledWith('/downloads/active?task=one')

    await user.click(screen.getByTestId('tasks-more'))
    expect(mocks.navigate).toHaveBeenCalledWith('/downloads/active')
  })

  it('keeps navigation and progress as accessible siblings', () => {
    setSource([
      task('accessible', TaskStatus.Downloading, {
        name: 'A very long accessible task name',
        downloadSpeed: 9_999,
      }),
    ])
    renderTile()

    const button = screen.getByTestId('tasks-row')
    const group = button.closest('[role="group"]')
    const progress = within(group as HTMLElement).getByRole('progressbar')

    expect(button.parentElement).toBe(group)
    expect(progress.parentElement).toBe(group)
    expect(button.contains(progress)).toBe(false)
    expect(button).toHaveAccessibleName(
      'A very long accessible task name, Downloading'
    )
    expect(button).toHaveAccessibleDescription('9.8 KB/s. Downloading · ETA 2m')
    expect(button.getAttribute('aria-label')).not.toMatch(/B\/s|9999/)
    expect(button.closest('li')).not.toBeNull()
  })

  it('returns focus to the selected segment only when a focused row disappears', () => {
    const active = task('focused')
    setSource([active])
    const rendered = renderTile()
    const row = screen.getByTestId('tasks-row')
    row.focus()
    expect(row).toHaveFocus()

    setSource([{ ...active, status: TaskStatus.Completed }])
    rendered.rerender(
      <MemoryRouter>
        <TasksTile engineOnline viewport={VIEWPORTS['2x2']} />
      </MemoryRouter>
    )
    expect(screen.getByRole('radio', { name: 'Active' })).toHaveFocus()
  })

  it('preserves row focus through unrelated live updates', () => {
    const active = task('focused')
    setSource([active])
    const rendered = renderTile()
    const row = screen.getByTestId('tasks-row')
    row.focus()

    setSource([{ ...active, downloadSpeed: 200_000 }])
    rendered.rerender(
      <MemoryRouter>
        <TasksTile engineOnline viewport={VIEWPORTS['2x2']} />
      </MemoryRouter>
    )
    expect(screen.getByTestId('tasks-row')).toHaveFocus()
  })

  it('uses a named fixture only for the development query path', () => {
    setSource([])
    renderTile({
      viewport: VIEWPORTS['2x3'],
      initialEntry: '/?dashboardTasksFixture=active-all',
    })

    expect(screen.getAllByTestId('tasks-row')).toHaveLength(7)
    expect(screen.getByText('Linux distribution — choose files')).toBeVisible()
  })

  it('refreshes terminal relative time at the next minute boundary', () => {
    vi.useFakeTimers()
    const clockStart = Date.UTC(2026, 6, 27, 8, 12, 30)
    vi.setSystemTime(clockStart)
    __resetMinuteClockForTests()
    mocks.useRealMinuteClock.current = true
    setSource([
      task('clock', TaskStatus.Error, {
        finishedAt: clockStart - 89_000,
      }),
    ])
    renderTile()

    act(() => {
      screen.getByRole('radio', { name: 'Failed' }).click()
    })
    expect(screen.getByText('1 min. ago')).toBeInTheDocument()
    const projectionCount = mocks.projectCalls.length

    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(screen.getByText('2 min. ago')).toBeInTheDocument()
    expect(mocks.projectCalls).toHaveLength(projectionCount)
  })

  it('projects 10,000 tasks within budget for the selected view only', async () => {
    const user = userEvent.setup()
    setSource(
      Array.from({ length: 10_000 }, (_, index) =>
        task(`synthetic-${index}`, TaskStatus.Downloading, {
          createdAt: index + 1,
        })
      )
    )

    const startedAt = performance.now()
    renderTile({ viewport: VIEWPORTS['2x1'] })
    const elapsedMs = performance.now() - startedAt

    expect(elapsedMs).toBeLessThan(1_500)
    expect(mocks.projectCalls).toEqual([
      { taskCount: 10_000, view: 'active', limit: 3 },
    ])
    expect(screen.getAllByTestId('tasks-row')).toHaveLength(2)
    expect(screen.getByTestId('tasks-more')).toHaveTextContent('+9998 more')

    await user.click(screen.getByRole('radio', { name: 'Failed' }))
    expect(mocks.projectCalls).toEqual([
      { taskCount: 10_000, view: 'active', limit: 3 },
      { taskCount: 10_000, view: 'failed', limit: 3 },
    ])
    expect(mocks.projectCalls.some((call) => call.view === 'recent')).toBe(
      false
    )
  })

  it('localizes persisted recovery errors and falls back to updated terminal time', async () => {
    const user = userEvent.setup()
    setSource([
      task('recovery', TaskStatus.Error, {
        errorDetailKey: 'task.recovery.startup.dirtyMetadata',
        finishedAt: Number.NaN,
        updatedAt: mocks.now.current - 20 * 60_000,
      }),
    ])
    renderTile()
    await user.click(screen.getByRole('radio', { name: 'Failed' }))

    expect(screen.getByText('20 min. ago')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Failed: Cannot recover this task: it is missing the identifying information needed to resume.'
      )
    ).toBeInTheDocument()
    expect(screen.getByTestId('tasks-row')).toHaveAccessibleDescription(
      '20 min. ago. Failed: Cannot recover this task: it is missing the identifying information needed to resume.'
    )
  })

  it('keeps complete names and failure copy in accessible text', async () => {
    const user = userEvent.setup()
    const longName = `任务-${'很长的文件名'.repeat(24)}-🚀.zip`
    const longReason = 'Remote response failed validation. '.repeat(8)
    setSource([
      task('long', TaskStatus.Error, {
        name: longName,
        errorMessage: longReason,
      }),
    ])
    renderTile()
    await user.click(screen.getByRole('radio', { name: 'Failed' }))

    const row = screen.getByTestId('tasks-row')
    expect(row).toHaveAttribute('title', `${longName}\n${longReason.trim()}`)
    expect(row).toHaveAccessibleDescription(
      `5 min. ago. Failed: Download failed. Technical detail: ${longReason.trim()}`
    )
  })

  it('renders localized content and coded failure reasons in Chinese', async () => {
    const user = userEvent.setup()
    await i18n.changeLanguage('zh-CN')
    setSource([
      task('cn', TaskStatus.Paused, { progress: 0.26 }),
      task('cn-error', TaskStatus.Error, {
        errorCode: DownloadErrorCode.NetworkError,
        errorMessage: 'Connection refused',
      }),
    ])
    renderTile()

    expect(screen.getByText('任务')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '活跃' })).toBeInTheDocument()
    expect(screen.getByText('已保存 26%')).toBeInTheDocument()
    expect(screen.getByTestId('tasks-row')).toHaveAccessibleName(
      'cn.iso, 已暂停'
    )

    await user.click(screen.getByRole('radio', { name: '失败' }))
    const failedRow = screen.getByTestId('tasks-row')
    expect(screen.getByText('失败：网络连接失败')).toBeInTheDocument()
    expect(failedRow).toHaveAccessibleDescription(
      '5分钟前. 失败：网络连接失败. 技术详情：Connection refused'
    )
    expect(
      failedRow
        .closest('[role="group"]')
        ?.querySelector<HTMLElement>('[aria-hidden]')?.textContent
    ).not.toContain('Connection refused')
  })
})
