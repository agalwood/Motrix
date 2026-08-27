import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import type { DownloadTask } from '@shared/types/task'
import { TaskKind, TaskStatus, TaskType } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/hooks/use-task-files', () => ({
  useTaskFiles: vi.fn(),
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))

import { useTaskFiles } from '@renderer/hooks/use-task-files'
import { FilesTab } from './files-tab'

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return {
        top: 0,
        left: 0,
        bottom: 600,
        right: 800,
        width: 800,
        height: 600,
      }
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return 600
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return 600
    },
  })
})

// Kept overrides: id:'t1' (≠ 'task-1'), engineTaskId:'gid1' (≠ 'gid-1'),
// name:'x' (≠ 'task'), kind:Bt (≠ Direct), type:Bt (≠ Http),
// status:Paused (≠ Downloading), fileCount:2 (≠ 0),
// bt.selectedFiles:[0] (≠ [] default).
const mockTask = (over: Partial<DownloadTask> = {}): DownloadTask =>
  makeDownloadTask({
    id: 't1',
    engineTaskId: 'gid1',
    name: 'x',
    kind: TaskKind.Bt,
    type: TaskType.Bt,
    status: TaskStatus.Paused,
    fileCount: 2,
    bt: {
      selectedFiles: [0],
      peers: 0,
      seeds: 0,
      ratio: 0,
      trackers: [],
      peersInSwarm: 0,
      seedsInSwarm: 0,
      announceList: [],
      comment: null,
      isPrivate: false,
      magnetUri: null,
      sequentialDownload: false,
    },
    ...over,
  })

beforeEach(() => {
  ;(useTaskFiles as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    files: [
      {
        index: 0,
        path: 'a.bin',
        size: 100,
        selected: true,
        completedBytes: 50,
      },
      {
        index: 1,
        path: 'b.bin',
        size: 200,
        selected: false,
        completedBytes: 0,
      },
    ],
    loading: false,
    refetch: vi.fn(),
  })
})

describe('FilesTab', () => {
  it('shows readOnly mode for completed tasks (no save button)', () => {
    render(<FilesTab task={mockTask({ status: TaskStatus.Completed })} />)
    for (const cb of screen.getAllByRole('checkbox')) {
      expect(cb).toHaveAttribute('aria-disabled', 'true')
    }
    expect(
      screen.queryByRole('button', { name: /save/i })
    ).not.toBeInTheDocument()
  })

  it('shows save button disabled by default in editable paused state', () => {
    render(<FilesTab task={mockTask({ status: TaskStatus.Paused })} />)
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })

  it('enables Save when selection becomes dirty', () => {
    render(<FilesTab task={mockTask({ status: TaskStatus.Paused })} />)
    // checkboxes: [0]=select-all, [1]=file 0 (already selected), [2]=file 1
    const fileOneCheckbox = screen.getAllByRole('checkbox')[2]
    if (!fileOneCheckbox) throw new Error('expected checkbox')
    fireEvent.click(fileOneCheckbox)
    expect(screen.getByRole('button', { name: /save/i })).toBeEnabled()
  })

  it('treats single-file BT torrent as read-only (no save button)', () => {
    ;(useTaskFiles as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      files: [
        {
          index: 0,
          path: 'ubuntu-25.10-desktop-amd64.iso',
          size: 6_500_000_000,
          selected: true,
          completedBytes: 1_000_000_000,
        },
      ],
      loading: false,
      refetch: vi.fn(),
    })
    render(
      <FilesTab
        task={mockTask({
          type: TaskType.Bt,
          status: TaskStatus.Downloading,
          fileCount: 1,
          bt: {
            selectedFiles: [0],
            peers: 0,
            seeds: 0,
            ratio: 0,
            trackers: [],
            peersInSwarm: 0,
            seedsInSwarm: 0,
            announceList: [],
            comment: null,
            isPrivate: false,
            magnetUri: null,
            sequentialDownload: false,
          },
        })}
      />
    )
    expect(
      screen.queryByRole('button', { name: /save/i })
    ).not.toBeInTheDocument()
  })

  it('uses task progress for a live single-file BT torrent', () => {
    ;(useTaskFiles as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      files: [
        {
          index: 0,
          path: 'ubuntu-25.10-desktop-amd64.iso',
          size: 100,
          selected: true,
          completedBytes: 50,
        },
      ],
      loading: false,
      refetch: vi.fn(),
    })

    render(
      <FilesTab
        task={mockTask({
          status: TaskStatus.Downloading,
          progress: 0.53,
          fileCount: 1,
        })}
      />
    )

    expect(screen.getByText('53%')).toBeInTheDocument()
    expect(useTaskFiles).toHaveBeenCalledWith('t1', true)
  })

  it('treats HTTP task as read-only regardless of file count', () => {
    ;(useTaskFiles as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      files: [
        {
          index: 0,
          path: 'release.zip',
          size: 100_000_000,
          selected: true,
          completedBytes: 0,
        },
      ],
      loading: false,
      refetch: vi.fn(),
    })
    render(
      <FilesTab
        task={mockTask({
          type: TaskType.Http,
          status: TaskStatus.Downloading,
          fileCount: 1,
          bt: undefined,
        })}
      />
    )
    expect(
      screen.queryByRole('button', { name: /save/i })
    ).not.toBeInTheDocument()
  })
})
