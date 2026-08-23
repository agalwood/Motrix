import '@testing-library/jest-dom/vitest'

import { vi } from 'vitest'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn().mockResolvedValue({ ok: true }) },
}))
vi.mock('@renderer/lib/open-add-task-dialog', () => ({
  openAddTaskDialog: vi.fn().mockResolvedValue(undefined),
}))
const { toastAddMock } = vi.hoisted(() => ({ toastAddMock: vi.fn() }))
vi.mock('@renderer/components/ui/toast', () => ({
  toast: { add: toastAddMock, close: vi.fn() },
}))

import '@renderer/lib/i18n'
import { DownloadErrorCode } from '@shared/errors'
import type { DownloadTask } from '@shared/types/task'
import { TaskKind, TaskStatus, TaskType } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TaskRow } from './task-row'

function fake(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask({
    id: 't',
    engineTaskId: 'g',
    name: 'ubuntu.iso',
    progress: 0.42,
    totalBytes: 4_700_000_000,
    downloadedBytes: 2_000_000_000,
    downloadSpeed: 4_100_000,
    etaSeconds: 680,
    saveDir: '/Downloads',
    uris: ['https://example.com/ubuntu.iso'],
    fileCount: 1,
    connections: 32,
    filename: 'ubuntu.iso',
    sizeWhenDone: 4_700_000_000,
    diskPath: '/Downloads/ubuntu.iso.motrix',
    finalPath: '/Downloads/ubuntu.iso',
    finalName: 'ubuntu.iso',
    ...overrides,
  })
}

const rowProps = {
  selected: false,
  focused: false,
  onClick: () => {},
  onCheckboxChange: () => {},
}

function getEtaCell(container: HTMLElement): Element {
  const row = container.firstElementChild
  const etaCell = row?.children.item(row.children.length - 2)
  if (!etaCell) throw new Error('TaskRow ETA cell not found')
  return etaCell
}

describe('TaskRow', () => {
  it('renders task name and formatted size', () => {
    render(<TaskRow task={fake()} rowProps={rowProps} />)
    expect(screen.getByText('ubuntu.iso')).toBeInTheDocument()
    // formatBytes(4_700_000_000) = "4.4 GB" (1024-base, value.toFixed(1))
    expect(screen.getByText(/4\.4 GB/)).toBeInTheDocument()
  })

  it('renders a dash for speeds when paused', () => {
    render(
      <TaskRow
        task={fake({ status: TaskStatus.Paused, downloadSpeed: 0 })}
        rowProps={rowProps}
      />
    )
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it.each([TaskStatus.Paused, TaskStatus.Completed])(
    'renders a dash for stale ETA when a memoized task becomes %s',
    (status) => {
      const downloading = fake({
        status: TaskStatus.Downloading,
        etaSeconds: 2,
      })
      const { container, rerender } = render(
        <TaskRow task={downloading} rowProps={rowProps} />
      )

      expect(getEtaCell(container)).toHaveTextContent('00:02')

      rerender(
        <TaskRow task={{ ...downloading, status }} rowProps={rowProps} />
      )

      expect(getEtaCell(container)).toHaveTextContent('—')
    }
  )

  it('applies selection background when selected', () => {
    const { container } = render(
      <TaskRow task={fake()} rowProps={{ ...rowProps, selected: true }} />
    )
    expect(container.firstChild).toHaveClass('bg-accent/40')
  })

  it('uses the same minimum width as the scrollable column header', () => {
    const { container } = render(<TaskRow task={fake()} rowProps={rowProps} />)

    expect(container.firstChild).toHaveStyle({ minWidth: '960px' })
  })

  it('renders gracefully for magnet metadata pending (Plan B)', () => {
    // The DB-backed magnet metadata flow surfaces tasks with
    // status=FetchingMetadata, totalBytes=0, progress=0 immediately
    // on submit. The row must render without crashing and show the
    // "Fetching" status pill so the user knows the task is alive.
    render(
      <TaskRow
        task={fake({
          status: TaskStatus.FetchingMetadata,
          totalBytes: 0,
          downloadedBytes: 0,
          sizeWhenDone: 0,
          progress: 0,
          downloadSpeed: 0,
          uploadSpeed: 0,
        })}
        rowProps={rowProps}
      />
    )
    expect(screen.getByText('Fetching')).toBeInTheDocument()
    expect(screen.getByText('0%')).toBeInTheDocument()
  })

  describe('Error status', () => {
    it('shows the localized failure reason and carries the technical detail as the row title', () => {
      const { container } = render(
        <TaskRow
          task={fake({
            status: TaskStatus.Error,
            errorCode: DownloadErrorCode.DiskFull,
            errorMessage: 'ENOSPC: no space left on device',
          })}
          rowProps={rowProps}
        />
      )
      expect(screen.getByText('Disk is full')).toBeInTheDocument()
      expect(container.firstChild).toHaveAttribute(
        'title',
        'ENOSPC: no space left on device'
      )
    })

    it('hides the retry button for a Mux-kind error task (not rebuildable)', () => {
      render(
        <TaskRow
          task={fake({
            status: TaskStatus.Error,
            kind: TaskKind.Mux,
            errorCode: DownloadErrorCode.NetworkError,
          })}
          rowProps={rowProps}
        />
      )
      expect(
        screen.queryByRole('button', { name: 'Retry' })
      ).not.toBeInTheDocument()
    })

    it('hides the retry button for an HTTP error task even with uris (replay inputs are not persisted)', () => {
      render(
        <TaskRow
          task={fake({
            id: 'http-error',
            status: TaskStatus.Error,
            type: TaskType.Http,
            uris: ['https://example.com/ubuntu.iso'],
            errorCode: DownloadErrorCode.NetworkError,
          })}
          rowProps={rowProps}
        />
      )
      expect(
        screen.queryByRole('button', { name: 'Retry' })
      ).not.toBeInTheDocument()
    })

    it('does not add a retry button to a BT error row with a sidecar', () => {
      render(
        <TaskRow
          task={fake({
            id: 'bt-error',
            status: TaskStatus.Error,
            type: TaskType.Bt,
            torrentMetaPath: '/sidecar/x.torrent',
            errorCode: DownloadErrorCode.NetworkError,
          })}
          rowProps={rowProps}
        />
      )
      expect(
        screen.queryByRole('button', { name: 'Retry' })
      ).not.toBeInTheDocument()
    })

    it('keeps retry out of a memoized magnet row after a sidecar appears', () => {
      const errored = fake({
        id: 'magnet-error',
        status: TaskStatus.Error,
        type: TaskType.Magnet,
        torrentMetaPath: null,
        errorCode: DownloadErrorCode.BtMetadataFailed,
      })
      const { rerender } = render(
        <TaskRow task={errored} rowProps={rowProps} />
      )
      // Not yet rebuildable: no persisted .torrent sidecar to re-add from.
      expect(
        screen.queryByRole('button', { name: 'Retry' })
      ).not.toBeInTheDocument()

      rerender(
        <TaskRow
          task={{ ...errored, torrentMetaPath: '/sidecar/magnet.torrent' }}
          rowProps={rowProps}
        />
      )
      expect(
        screen.queryByRole('button', { name: 'Retry' })
      ).not.toBeInTheDocument()
    })
  })
})
