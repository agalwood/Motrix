import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { BtExtension, DownloadTask } from '@shared/types/task'
import { TaskStatus, TaskType } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TrackersTab } from './trackers-tab'

const { toastAddMock } = vi.hoisted(() => ({ toastAddMock: vi.fn() }))
vi.mock('@renderer/components/ui/toast', () => ({
  toast: { add: toastAddMock, close: vi.fn() },
}))
vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn() },
}))
vi.mock('@renderer/components/desktop-kit/virtual-list/virtual-list', () => ({
  VirtualList: <T,>({
    items,
    getId,
    renderRow,
  }: {
    items: T[]
    getId: (item: T) => string
    renderRow: (props: { item: T; index: number }) => React.ReactNode
  }) => (
    <div data-testid="virtual-list-container">
      {items.map((item, index) => (
        <div key={getId(item)}>{renderRow({ item, index })}</div>
      ))}
    </div>
  ),
}))
vi.mock('@renderer/hooks/use-tracker-list', () => ({
  useTrackerList: () => ({
    list: {
      effective: ['http://global1', 'http://global2'],
      blacklist: [],
      healthMap: {},
      sourceMap: {},
      lastSyncAt: null,
      lastProbeAt: null,
    },
    isLoading: false,
    error: null,
    lastSyncAt: null,
  }),
}))

// Kept overrides: type:Bt (≠ Http), name:'test.torrent' (≠ 'task'),
// bt.announceList:[['http://announce1'],['http://announce2']] (≠ []).
// Dropped: id:'task-1' (= default), engineTaskId:'gid-1' (= default),
// status:Downloading (= default), uris:[] (= default), all-zero/empty fields.
// The original factory omitted many DownloadTask required fields via `as DownloadTask`
// cast; makeDownloadTask fills them with neutral defaults (no behavior change).
function makeBtTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask({
    type: TaskType.Bt,
    name: 'test.torrent',
    bt: {
      peers: 0,
      seeds: 0,
      ratio: 0,
      trackers: [],
      selectedFiles: [],
      peersInSwarm: 0,
      seedsInSwarm: 0,
      announceList: [['http://announce1'], ['http://announce2']],
      comment: null,
      isPrivate: false,
      magnetUri: null,
      sequentialDownload: false,
    },
    ...overrides,
  })
}

describe('TrackersTab — read mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockImplementation(
      async (channel) => {
        if (channel === Queries.GetTaskBtTracker) {
          return ['http://global1', 'http://effective-only', 'http://announce1']
        }
        // announceList is projected out of the broadcast; the tab reads the
        // static seed list through the full per-task detail.
        if (channel === Queries.GetTaskDetail) {
          return makeBtTask()
        }
        return undefined
      }
    )
  })

  it('renders rows = announce ∪ effective with announce rows non-deletable', async () => {
    render(<TrackersTab task={makeBtTask()} />)
    expect(await screen.findByText('http://announce1')).toBeInTheDocument()
    expect(await screen.findByText('http://announce2')).toBeInTheDocument()
    expect(screen.getByText('http://global1')).toBeInTheDocument()
    expect(screen.getByText('http://effective-only')).toBeInTheDocument()
    // announce rows: no delete button accessible by name
    const announceRow = screen
      .getByText('http://announce1')
      .closest('[data-row]')
    expect(
      announceRow?.querySelector('button[aria-label="Delete tracker"]')
    ).toBeNull()
    const effectiveRow = screen
      .getByText('http://effective-only')
      .closest('[data-row]')
    expect(
      effectiveRow?.querySelector('button[aria-label="Delete tracker"]')
    ).not.toBeNull()
  })

  it('header summary shows "{N} trackers · {M} not in global"', async () => {
    render(<TrackersTab task={makeBtTask()} />)
    // 4 rows, 1 global URL not in effective (global2)
    expect(await screen.findByText(/4 trackers/)).toBeInTheDocument()
    expect(screen.getByText(/1 not in global/)).toBeInTheDocument()
  })

  it('shows private banner when isPrivate', async () => {
    render(
      <TrackersTab
        task={makeBtTask({
          bt: { ...(makeBtTask().bt as BtExtension), isPrivate: true },
        })}
      />
    )
    expect(await screen.findByText(/private torrent/i)).toBeInTheDocument()
  })

  it('keeps the private banner icon and label on one row, not stacked', async () => {
    render(
      <TrackersTab
        task={makeBtTask({
          bt: { ...(makeBtTask().bt as BtExtension), isPrivate: true },
        })}
      />
    )
    const label = await screen.findByText(/private torrent/i)
    const container = label.parentElement
    // Icon and label share the Alert content wrapper as siblings — if that
    // wrapper were `flex-col` (as it must be for AlertTitle/AlertDescription
    // stacking), this single pre-laid-out icon+text child would stack
    // vertically instead of staying on one line.
    expect(container?.querySelector('svg')).not.toBeNull()
    expect(container?.className).not.toMatch(/flex-col/)
  })

  it('Sync button is disabled when isPrivate', async () => {
    render(
      <TrackersTab
        task={makeBtTask({
          bt: { ...(makeBtTask().bt as BtExtension), isPrivate: true },
        })}
      />
    )
    const syncButton = await screen.findByRole('button', { name: /sync/i })
    expect(syncButton).toBeDisabled()
  })

  it('retries an empty announce baseline on the poll cadence with a bounded budget', async () => {
    vi.useFakeTimers()
    try {
      const emptyDetail = {
        ...makeBtTask(),
        bt: { ...(makeBtTask().bt as BtExtension), announceList: [] },
      }
      ;(transport.invoke as ReturnType<typeof vi.fn>).mockImplementation(
        async (channel) => {
          if (channel === Queries.GetTaskBtTracker) {
            return ['http://effective-only']
          }
          if (channel === Queries.GetTaskDetail) return emptyDetail
          return undefined
        }
      )
      const detailCalls = () =>
        (transport.invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
          (call) => call[0] === Queries.GetTaskDetail
        ).length

      render(<TrackersTab task={makeBtTask()} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      // A just-created BT task has an empty announceList until the FIRST
      // authoritative poll (~1s) populates it — an immediate re-query would
      // land before that poll and permanently cache the pre-poll state.
      expect(detailCalls()).toBe(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500)
      })
      // Flush the refresh's state commit so the effect re-arms the timer.
      await act(async () => {})
      expect(detailCalls()).toBe(2)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500)
      })
      await act(async () => {})
      expect(detailCalls()).toBe(3)

      // Budget exhausted: an empty baseline is now accepted as legitimate
      // (DHT-only torrents genuinely have no announce list).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })
      expect(detailCalls()).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries an empty announce baseline even when effective is empty', async () => {
    vi.useFakeTimers()
    try {
      // A private torrent legitimately reports an empty bt-tracker extras
      // list, so the first-poll gap (empty announceList before the ~1s
      // authoritative poll) must retry on the baseline alone — gating the
      // retry on a non-empty effective list would cache "no trackers"
      // forever for exactly those tasks.
      const emptyDetail = {
        ...makeBtTask(),
        bt: { ...(makeBtTask().bt as BtExtension), announceList: [] },
      }
      ;(transport.invoke as ReturnType<typeof vi.fn>).mockImplementation(
        async (channel) => {
          if (channel === Queries.GetTaskBtTracker) return []
          if (channel === Queries.GetTaskDetail) return emptyDetail
          return undefined
        }
      )
      const detailCalls = () =>
        (transport.invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
          (call) => call[0] === Queries.GetTaskDetail
        ).length

      render(<TrackersTab task={makeBtTask()} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(detailCalls()).toBe(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500)
      })
      await act(async () => {})
      expect(detailCalls()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps effective-only rows non-deletable until the seed detail resolves', async () => {
    let resolveDetail!: (value: unknown) => void
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockImplementation(
      async (channel) => {
        if (channel === Queries.GetTaskBtTracker) {
          return ['http://global1', 'http://effective-only']
        }
        if (channel === Queries.GetTaskDetail) {
          return new Promise((resolve) => {
            resolveDetail = resolve
          })
        }
        return undefined
      }
    )
    render(<TrackersTab task={makeBtTask()} />)
    expect(await screen.findByText('http://effective-only')).toBeInTheDocument()

    // While the announce baseline is unknown, no row may present itself as
    // deletable — announce trackers of a private torrent must never be
    // mislabeled as removable extras.
    expect(screen.queryByLabelText('Delete tracker')).not.toBeInTheDocument()

    resolveDetail(makeBtTask())
    await waitFor(() =>
      expect(screen.getAllByLabelText('Delete tracker').length).toBeGreaterThan(
        0
      )
    )
  })

  it('clicking trash on deletable row invokes SetTaskBtTracker with effective minus url', async () => {
    render(<TrackersTab task={makeBtTask()} />)
    const row = (await screen.findByText('http://effective-only')).closest(
      '[data-row]'
    )
    const trash = row?.querySelector(
      'button[aria-label="Delete tracker"]'
    ) as HTMLButtonElement
    await userEvent.click(trash)
    expect(transport.invoke).toHaveBeenCalledWith(Commands.SetTaskBtTracker, {
      engineGid: 'gid-1',
      trackers: ['http://global1', 'http://announce1'], // effective minus 'http://effective-only'
    })
  })

  it('renders empty state when announce + effective both empty', async () => {
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockResolvedValue([])
    render(
      <TrackersTab
        task={makeBtTask({
          bt: { ...(makeBtTask().bt as BtExtension), announceList: [] },
        })}
      />
    )
    expect(await screen.findByText(/no trackers/i)).toBeInTheDocument()
  })
})

describe('TrackersTab — edit mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockImplementation(
      async (channel) => {
        if (channel === Queries.GetTaskBtTracker) return ['http://x']
        return undefined
      }
    )
  })

  it('Edit button transitions to edit mode; textarea seeded with effective ex-announce', async () => {
    render(<TrackersTab task={makeBtTask()} />)
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }))
    const textarea = screen.getByRole('textbox')
    expect(textarea).toHaveValue('http://x')
  })

  it('Cancel discards draft and returns to read mode', async () => {
    render(<TrackersTab task={makeBtTask()} />)
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }))
    const textarea = screen.getByRole('textbox')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, 'http://new')
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument()
  })

  it('Save invokes SetTaskBtTracker with parsed list', async () => {
    render(<TrackersTab task={makeBtTask()} />)
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }))
    const textarea = screen.getByRole('textbox')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, 'http://a\nhttps://b\nudp://c:80')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(transport.invoke).toHaveBeenCalledWith(Commands.SetTaskBtTracker, {
      engineGid: 'gid-1',
      trackers: ['http://a', 'https://b', 'udp://c:80'],
    })
  })

  it('Save with invalid lines toasts and saves valid subset', async () => {
    render(<TrackersTab task={makeBtTask()} />)
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }))
    const textarea = screen.getByRole('textbox')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, 'http://ok\nftp://bad\nfoo://nope')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(toastAddMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning' })
    )
    expect(transport.invoke).toHaveBeenCalledWith(Commands.SetTaskBtTracker, {
      engineGid: 'gid-1',
      trackers: ['http://ok'],
    })
  })

  it('Save short-circuits RPC when parsed equals effective', async () => {
    render(<TrackersTab task={makeBtTask()} />)
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }))
    // textarea already seeded with the effective; click Save without changes
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    // No new invoke for SetTaskBtTracker
    const setCalls = (
      transport.invoke as ReturnType<typeof vi.fn>
    ).mock.calls.filter((c) => c[0] === Commands.SetTaskBtTracker)
    expect(setCalls).toHaveLength(0)
    // Mode should return to read
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('Save error toasts and stays in edit mode', async () => {
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockImplementation(
      async (channel) => {
        if (channel === Queries.GetTaskBtTracker) return ['http://x']
        if (channel === Commands.SetTaskBtTracker) throw new Error('boom')
      }
    )
    render(<TrackersTab task={makeBtTask()} />)
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }))
    const textarea = screen.getByRole('textbox')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, 'http://new')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(toastAddMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' })
    )
    expect(screen.getByRole('textbox')).toBeInTheDocument() // still editing
  })

  it('task.id change resets mode to read silently', async () => {
    const t1 = makeBtTask({ id: 'task-1', engineTaskId: 'gid-1' })
    const t2 = makeBtTask({ id: 'task-2', engineTaskId: 'gid-2' })
    const { rerender } = render(<TrackersTab task={t1} />)
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }))
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    rerender(<TrackersTab task={t2} />)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('a deferred save from the previous task cannot close the new task edit session', async () => {
    let resolveSave!: (value: unknown) => void
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockImplementation(
      (channel) => {
        if (channel === Commands.SetTaskBtTracker) {
          return new Promise((resolve) => {
            resolveSave = resolve
          })
        }
        if (channel === Queries.GetTaskBtTracker) {
          return Promise.resolve(['http://effective-only'])
        }
        if (channel === Queries.GetTaskDetail) {
          return Promise.resolve(makeBtTask())
        }
        return Promise.resolve(undefined)
      }
    )
    const t1 = makeBtTask({ id: 'task-1', engineTaskId: 'gid-1' })
    const t2 = makeBtTask({ id: 'task-2', engineTaskId: 'gid-2' })
    const { rerender } = render(<TrackersTab task={t1} />)

    await userEvent.click(await screen.findByRole('button', { name: /edit/i }))
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'http://new-tracker/announce' },
    })
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    // Task switches while A's save awaits the command; the user starts
    // editing B. A's continuation must not touch B's edit session.
    rerender(<TrackersTab task={t2} />)
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }))
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    await act(async () => {
      resolveSave('OK')
    })
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('engineTaskId change (re-add / magnet swap) also exits edit mode', async () => {
    // Same public id, new engine generation: the draft was seeded from the
    // OLD generation's effective list and must not be committed against
    // the new gid.
    const t1 = makeBtTask({ id: 'task-1', engineTaskId: 'gid-1' })
    const swapped = makeBtTask({ id: 'task-1', engineTaskId: 'gid-2' })
    const { rerender } = render(<TrackersTab task={t1} />)
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }))
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    rerender(<TrackersTab task={swapped} />)
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})

describe('TrackersTab — Sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('Sync click invokes SyncTaskBtTracker', async () => {
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockImplementation(
      async (channel) => {
        if (channel === Queries.GetTaskBtTracker) return []
        return undefined
      }
    )
    render(<TrackersTab task={makeBtTask()} />)
    await userEvent.click(await screen.findByRole('button', { name: /sync/i }))
    expect(transport.invoke).toHaveBeenCalledWith(Commands.SyncTaskBtTracker, {
      engineGid: 'gid-1',
    })
  })

  it('Sync error toasts', async () => {
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockImplementation(
      async (channel) => {
        if (channel === Queries.GetTaskBtTracker) return []
        if (channel === Commands.SyncTaskBtTracker) throw new Error('rpc fail')
      }
    )
    render(<TrackersTab task={makeBtTask()} />)
    await userEvent.click(await screen.findByRole('button', { name: /sync/i }))
    expect(toastAddMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' })
    )
  })
})

describe('TrackersTab — non-editable (post-eviction) states', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(transport.invoke as ReturnType<typeof vi.fn>).mockImplementation(
      async (channel) => {
        // Mirror Aria2Adapter.getTaskBtTracker's silent fallback when
        // aria2 has already evicted the GID.
        if (channel === Queries.GetTaskBtTracker) return []
        if (channel === Queries.GetTaskDetail) return makeBtTask()
        return undefined
      }
    )
  })

  it.each([
    [TaskStatus.Completed],
    [TaskStatus.Error],
    [TaskStatus.Removed],
  ] as const)('hides Edit and Sync buttons when status=%s', async (status) => {
    render(<TrackersTab task={makeBtTask({ status })} />)
    // announceList rows still render via the per-task detail query —
    // confirm the tab is mounted
    expect(await screen.findByText('http://announce1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /sync/i })).toBeNull()
  })

  it('omits drift suffix in summary when not editable', async () => {
    render(<TrackersTab task={makeBtTask({ status: TaskStatus.Completed })} />)
    expect(await screen.findByText('http://announce1')).toBeInTheDocument()
    // driftSuffix uses i18n key `...driftSuffix` which contains "not in global"
    expect(screen.queryByText(/not in global/i)).toBeNull()
  })
})
