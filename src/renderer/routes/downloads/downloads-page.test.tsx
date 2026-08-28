import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import {
  type PlatformServices,
  PlatformServicesProvider,
} from '@renderer/platform/services'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus, TaskType } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadsPage } from './downloads-page'
import { useDownloadsSelection } from './store'

const taskListMock = vi.hoisted(() => {
  const retry = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  return {
    retry,
    current: {
      tasks: [] as readonly DownloadTask[],
      status: 'ready' as 'loading' | 'ready' | 'error',
      hasReadySnapshot: true,
      revision: 0,
      retry,
      hasAnyActive: false,
      hasAnyPaused: false,
      hasStopped: false,
    },
  }
})

vi.mock('@renderer/hooks/use-task-list', () => ({
  useTaskList: () => taskListMock.current,
}))
vi.mock('@renderer/hooks/use-global-stats', () => ({
  useGlobalStats: () => ({ stats: null }),
}))
vi.mock('@renderer/hooks/use-task-pieces', () => ({
  useTaskPieces: () => ({ pieces: null }),
}))
vi.mock('@renderer/hooks/use-task-speed-history', () => ({
  useTaskSpeedHistory: () => ({ history: [] }),
}))
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn().mockResolvedValue({ state: 'ready' }),
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))

const testPlatformServices: PlatformServices = {
  kind: 'electron',
  pickSaveDir: vi.fn(async () => null),
  closeHost: vi.fn(),
  readClipboard: vi.fn(async () => ''),
  openExternal: vi.fn(),
  notify: vi.fn(),
}

function task(
  id: string,
  status: TaskStatus,
  type = TaskType.Http
): DownloadTask {
  return makeDownloadTask({
    id,
    engineTaskId: `gid-${id}`,
    name: `task ${id}`,
    status,
    type,
    diskPath: `/tmp/${id}`,
    finalPath: `/tmp/${id}`,
    finalName: id,
  })
}

function setTaskList(overrides: Partial<typeof taskListMock.current>): void {
  taskListMock.current = {
    tasks: [],
    status: 'ready',
    hasReadySnapshot: true,
    revision: taskListMock.current.revision + 1,
    retry: taskListMock.retry,
    hasAnyActive: false,
    hasAnyPaused: false,
    hasStopped: false,
    ...overrides,
  }
}

function LocationHarness() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <output data-testid="location">
        {location.pathname}
        {location.search}
      </output>
      <button
        type="button"
        data-testid="navigate-type"
        onClick={() => navigate('/downloads/all?type=http')}
      >
        navigate type
      </button>
      <button
        type="button"
        data-testid="navigate-task-b"
        onClick={() => navigate('/downloads/active?task=b')}
      >
        navigate task b
      </button>
    </>
  )
}

function TestRouter({ initialPath }: { initialPath: string }) {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <LocationHarness />
      <Routes>
        <Route path="/downloads/:filter" element={<DownloadsPage />} />
        <Route path="/downloads" element={<DownloadsPage />} />
      </Routes>
    </MemoryRouter>
  )
}

function renderAt(path: string) {
  const renderTree = () => (
    <PlatformServicesProvider services={testPlatformServices}>
      <TestRouter initialPath={path} />
    </PlatformServicesProvider>
  )
  const view = render(renderTree())
  return {
    ...view,
    refresh: () => view.rerender(renderTree()),
  }
}

function selectedIds(): string[] {
  return [...useDownloadsSelection.getState().committedSelectedIds]
}

beforeEach(() => {
  taskListMock.retry.mockClear()
  setTaskList({})
  useDownloadsSelection.getState().setItems([])
  useDownloadsSelection.getState().clearSelection()
})

describe('DownloadsPage', () => {
  it('renders the status title heading and search trigger', () => {
    renderAt('/downloads/all')
    expect(
      screen.getByRole('heading', { name: /downloads/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /search downloads/i })
    ).toBeInTheDocument()
  })

  it('shows the Glass Motion empty state when only removed tasks remain', () => {
    setTaskList({ tasks: [task('removed', TaskStatus.Removed)] })
    const { container } = renderAt('/downloads/all')

    expect(screen.getByText(/no downloads yet/i)).toBeInTheDocument()
    expect(
      container.querySelector('[data-slot="cubic-glass-gradient"]')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /tune glass motion/i })
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/no tasks match this filter/i)
    ).not.toBeInTheDocument()
  })

  it.each([
    ['active', TaskStatus.Downloading],
    ['error', TaskStatus.Error],
    ['completed', TaskStatus.Completed],
  ] as const)('opens a matching %s task deep link', async (filter, status) => {
    setTaskList({ tasks: [task('target', status)] })
    renderAt(`/downloads/${filter}?task=target`)

    await waitFor(() => expect(selectedIds()).toEqual(['target']))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('renders a skeleton for the first loading frame, including empty data', () => {
    setTaskList({
      tasks: [],
      status: 'loading',
      hasReadySnapshot: false,
    })
    renderAt('/downloads/active')

    expect(screen.getByTestId('downloads-loading')).toBeInTheDocument()
    expect(screen.queryByText('No downloads yet')).not.toBeInTheDocument()
  })

  it.each([
    {
      label: 'loading',
      status: 'loading' as const,
      hasReadySnapshot: false,
      tasks: [] as DownloadTask[],
      target: 'b',
    },
    {
      label: 'unknown',
      status: 'ready' as const,
      hasReadySnapshot: true,
      tasks: [] as DownloadTask[],
      target: 'b',
    },
    {
      label: 'removed',
      status: 'ready' as const,
      hasReadySnapshot: true,
      tasks: [task('b', TaskStatus.Removed)],
      target: 'b',
    },
  ])('clears preselected A for a new $label B signature', (state) => {
    const existing = task('a', TaskStatus.Downloading)
    useDownloadsSelection.getState().setItems([existing])
    useDownloadsSelection.getState().select(existing.id)
    setTaskList(state)

    renderAt(`/downloads/active?task=${state.target}`)
    expect(selectedIds()).toEqual([])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('does not clear a normal selection for a type change without task', async () => {
    const existing = task('a', TaskStatus.Downloading)
    setTaskList({ tasks: [existing] })
    useDownloadsSelection.getState().setItems([existing])
    useDownloadsSelection.getState().select(existing.id)
    renderAt('/downloads/all')

    fireEvent.click(screen.getByTestId('navigate-type'))
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/downloads/all?type=http'
      )
    )
    expect(selectedIds()).toEqual(['a'])
  })

  it('shows unavailable before a ready snapshot and retry can recover', async () => {
    setTaskList({
      status: 'error',
      hasReadySnapshot: false,
      tasks: [],
    })
    const view = renderAt('/downloads/active?task=b')

    expect(screen.getByRole('alert')).toHaveTextContent('Tasks unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(taskListMock.retry).toHaveBeenCalledOnce()

    setTaskList({
      status: 'ready',
      hasReadySnapshot: true,
      tasks: [task('b', TaskStatus.Downloading)],
    })
    view.refresh()
    await waitFor(() => expect(selectedIds()).toEqual(['b']))
  })

  it('shows a stale banner with retry while cached data is in error', async () => {
    setTaskList({
      status: 'error',
      hasReadySnapshot: true,
      tasks: [task('cached', TaskStatus.Downloading)],
    })
    renderAt('/downloads/all')

    // A ready snapshot keeps the list on screen, so the failed resync must
    // be visible somewhere: a slim banner with a manual retry.
    const banner = screen.getByTestId('downloads-stale-banner')
    expect(banner).toHaveTextContent(/out of date/i)
    fireEvent.click(within(banner).getByRole('button', { name: 'Retry' }))
    expect(taskListMock.retry).toHaveBeenCalledOnce()
  })

  it('uses cached data while the task store is in error', async () => {
    setTaskList({
      status: 'error',
      hasReadySnapshot: true,
      tasks: [task('cached', TaskStatus.Error)],
    })
    renderAt('/downloads/error?task=cached')

    await waitFor(() => expect(selectedIds()).toEqual(['cached']))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // The cached snapshot renders the list normally instead of the
    // data-unavailable banner — the selected task's own Error-status alert
    // in the inspector (added by Task 10) is expected here, not a regression.
    expect(screen.queryByText('Tasks unavailable')).not.toBeInTheDocument()
  })

  it('waits for ready data before opening a delayed task', async () => {
    setTaskList({
      status: 'loading',
      hasReadySnapshot: false,
      tasks: [],
    })
    const view = renderAt('/downloads/active?task=b')
    expect(selectedIds()).toEqual([])

    setTaskList({
      tasks: [task('b', TaskStatus.Downloading)],
      status: 'ready',
      hasReadySnapshot: true,
    })
    view.refresh()
    await waitFor(() => expect(selectedIds()).toEqual(['b']))
  })

  it('falls back to All when the status does not match', async () => {
    setTaskList({ tasks: [task('b', TaskStatus.Completed)] })
    renderAt('/downloads/active?task=b')

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/downloads/all?task=b'
      )
    )
    await waitFor(() => expect(selectedIds()).toEqual(['b']))
  })

  it('falls back to All and removes a conflicting type only', async () => {
    setTaskList({
      tasks: [task('b', TaskStatus.Downloading, TaskType.Bt)],
    })
    renderAt('/downloads/active?type=http&task=b')

    await waitFor(() => {
      const location = screen.getByTestId('location').textContent
      expect(location).toBe('/downloads/all?task=b')
    })
    await waitFor(() => expect(selectedIds()).toEqual(['b']))
  })

  it.each([
    ['unknown', []],
    ['removed', [task('b', TaskStatus.Removed)]],
  ] as const)(
    'consumes a %s id after ready and does not reopen on a later snapshot',
    async (_label, initialTasks) => {
      setTaskList({ tasks: initialTasks })
      const view = renderAt('/downloads/active?task=b')
      await act(async () => Promise.resolve())
      expect(selectedIds()).toEqual([])

      setTaskList({ tasks: [task('b', TaskStatus.Downloading)] })
      view.refresh()
      await act(async () => Promise.resolve())
      expect(selectedIds()).toEqual([])
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    }
  )

  it('closing the Inspector clears selection and removes task', async () => {
    setTaskList({ tasks: [task('a', TaskStatus.Downloading)] })
    renderAt('/downloads/active?task=a')
    await waitFor(() => expect(selectedIds()).toEqual(['a']))

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(selectedIds()).toEqual([]))
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/downloads/active'
      )
    )
  })

  it('opens a genuinely new task URL after consuming the first', async () => {
    setTaskList({
      tasks: [
        task('a', TaskStatus.Downloading),
        task('b', TaskStatus.Downloading),
      ],
    })
    renderAt('/downloads/active?task=a')
    await waitFor(() => expect(selectedIds()).toEqual(['a']))

    fireEvent.click(screen.getByTestId('navigate-task-b'))
    await waitFor(() => expect(selectedIds()).toEqual(['b']))
  })

  it('normal row selection removes stale deep-link ownership', async () => {
    setTaskList({
      tasks: [
        task('a', TaskStatus.Downloading),
        task('b', TaskStatus.Downloading),
      ],
    })
    renderAt('/downloads/active?task=a')
    await waitFor(() => expect(selectedIds()).toEqual(['a']))

    act(() => useDownloadsSelection.getState().select('b'))
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/downloads/active'
      )
    )
    expect(selectedIds()).toEqual(['b'])
  })
})
