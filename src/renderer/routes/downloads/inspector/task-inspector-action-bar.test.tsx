import type { DownloadTask } from '@shared/types/task'
import { TaskStatus, TaskType } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { TaskInspectorActionBar } from './task-inspector-action-bar'

// Kept overrides: id:'t1' (≠ 'task-1'), name:'sample' (≠ 'task'),
// saveDir:'/tmp' (≠ ''), uris:['http://example.com/x'] (≠ []),
// fileCount:1 (≠ 0), filename:'sample' (≠ ''),
// diskPath:'/tmp/sample' (≠ ''), finalPath:'/tmp/sample' (≠ ''),
// finalName:'sample' (≠ '').
// Dropped: engineTaskId:'gid-1' (= default), kind:Direct (= default),
// type:Http (= default), status:Downloading (= default), all-zero/null/empty.
function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask({
    id: 't1',
    name: 'sample',
    saveDir: '/tmp',
    uris: ['http://example.com/x'],
    fileCount: 1,
    filename: 'sample',
    diskPath: '/tmp/sample',
    finalPath: '/tmp/sample',
    finalName: 'sample',
    ...overrides,
  })
}

describe('TaskInspectorActionBar', () => {
  it('Downloading single: shows Pause + Copy URL + Remove', () => {
    render(
      <TaskInspectorActionBar
        selected={[makeTask({ status: TaskStatus.Downloading })]}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('Pause')).toBeDefined()
    expect(screen.queryByText('Resume')).toBeNull()
    expect(screen.queryByText('Stop seeding')).toBeNull()
    expect(screen.getByText('Open folder')).toBeDefined()
    expect(screen.getByText('Copy URL')).toBeDefined()
    expect(screen.getByText('Remove')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Close' })).toBeDefined()
  })

  it('Seeding single (BT): shows Pause + Stop seeding + Remove', () => {
    render(
      <TaskInspectorActionBar
        selected={[makeTask({ status: TaskStatus.Seeding, type: TaskType.Bt })]}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('Pause')).toBeDefined()
    expect(screen.getByText('Stop seeding')).toBeDefined()
  })

  it('Completed BT with torrentMetaPath: shows Re-seed', () => {
    render(
      <TaskInspectorActionBar
        selected={[
          makeTask({
            status: TaskStatus.Completed,
            type: TaskType.Bt,
            torrentMetaPath: '/sidecar/x.torrent',
          }),
        ]}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('Re-seed')).toBeDefined()
  })

  it('Completed HTTP: hides Re-seed', () => {
    render(
      <TaskInspectorActionBar
        selected={[
          makeTask({ status: TaskStatus.Completed, type: TaskType.Http }),
        ]}
        onClose={vi.fn()}
      />
    )
    expect(screen.queryByText('Re-seed')).toBeNull()
  })

  it('Error single (BT with sidecar): shows Retry', () => {
    render(
      <TaskInspectorActionBar
        selected={[
          makeTask({
            status: TaskStatus.Error,
            type: TaskType.Bt,
            torrentMetaPath: '/sidecar/x.torrent',
          }),
        ]}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('Retry')).toBeDefined()
  })

  it('Error single (HTTP): hides Retry — the replay inputs are not persisted', () => {
    render(
      <TaskInspectorActionBar
        selected={[makeTask({ status: TaskStatus.Error })]}
        onClose={vi.fn()}
      />
    )
    expect(screen.queryByText('Retry')).toBeNull()
  })

  it('Finalizing single: renders Pause and Remove disabled', () => {
    render(
      <TaskInspectorActionBar
        selected={[makeTask({ status: TaskStatus.Finalizing })]}
        onClose={vi.fn()}
      />
    )
    const pauseBtn = screen.getByRole('button', { name: /Pause/ })
    expect(pauseBtn).toHaveProperty('disabled', true)
    const removeBtn = screen.getByRole('button', { name: /Remove/ })
    expect(removeBtn).toHaveProperty('disabled', true)
  })

  it('Mixed multi-selection: shows union with counts', () => {
    render(
      <TaskInspectorActionBar
        selected={[
          makeTask({ id: 'a', status: TaskStatus.Downloading }),
          makeTask({ id: 'b', status: TaskStatus.Paused }),
          makeTask({
            id: 'c',
            status: TaskStatus.Error,
            type: TaskType.Bt,
            torrentMetaPath: '/sidecar/x.torrent',
          }),
        ]}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText(/Pause/)).toBeDefined()
    expect(screen.getByText(/Resume/)).toBeDefined()
    expect(screen.getByText(/Retry/)).toBeDefined()
    expect(screen.getByText(/Remove/)).toBeDefined()
    // counts visible
    // Pause (1), Resume (1), Retry (1) — three buttons each show "(1)"
    expect(screen.getAllByText('(1)', { selector: 'span' })).toHaveLength(3)
    expect(screen.getByText('(3)', { selector: 'span' })).toBeDefined()
  })

  it('hides single-only buttons in multi-selection', () => {
    render(
      <TaskInspectorActionBar
        selected={[
          makeTask({ id: 'a', status: TaskStatus.Downloading }),
          makeTask({ id: 'b', status: TaskStatus.Downloading }),
        ]}
        onClose={vi.fn()}
      />
    )
    expect(screen.queryByText('Copy URL')).toBeNull()
    expect(screen.queryByText('Open folder')).toBeNull()
  })

  it('FetchingMetadata single: hides Open folder', () => {
    render(
      <TaskInspectorActionBar
        selected={[
          makeTask({
            type: TaskType.Magnet,
            status: TaskStatus.FetchingMetadata,
            diskPath: '/',
          }),
        ]}
        onClose={vi.fn()}
      />
    )

    expect(screen.queryByText('Open folder')).toBeNull()
    expect(screen.getByText('Copy URL')).toBeDefined()
  })

  it('MetadataReady magnet single: shows Select files and reopens the dialog on click', () => {
    vi.mocked(transport.invoke).mockClear()
    render(
      <TaskInspectorActionBar
        selected={[
          makeTask({
            type: TaskType.Magnet,
            status: TaskStatus.MetadataReady,
            diskPath: '/tmp/meta',
          }),
        ]}
        onClose={vi.fn()}
      />
    )
    const btn = screen.getByRole('button', { name: /Select files/ })
    expect(btn).toBeDefined()
    fireEvent.click(btn)
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.ReopenMagnetFileSelection,
      't1'
    )
  })

  it('non-MetadataReady single: hides Select files', () => {
    render(
      <TaskInspectorActionBar
        selected={[makeTask({ status: TaskStatus.Downloading })]}
        onClose={vi.fn()}
      />
    )
    expect(screen.queryByText('Select files')).toBeNull()
  })

  it('counts hidden in single selection', () => {
    render(
      <TaskInspectorActionBar
        selected={[makeTask({ status: TaskStatus.Downloading })]}
        onClose={vi.fn()}
      />
    )
    expect(screen.queryByText('(1)')).toBeNull()
  })

  it('clicking Remove opens the confirmation dialog', () => {
    render(
      <TaskInspectorActionBar
        selected={[makeTask({ status: TaskStatus.Downloading })]}
        onClose={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }))
    expect(screen.getByText(/Remove “sample”\?/)).toBeDefined()
  })

  describe('Copy URL', () => {
    beforeEach(() => {
      Object.assign(navigator, {
        clipboard: { writeText: vi.fn() },
      })
      // Per-case GetTaskDetail implementations must not leak forward.
      vi.mocked(transport.invoke).mockReset()
      vi.mocked(transport.invoke).mockResolvedValue({ ok: true })
    })

    it('HTTP task copies the source URL', async () => {
      render(
        <TaskInspectorActionBar
          selected={[
            makeTask({
              type: TaskType.Http,
              uris: ['https://example.com/file.zip'],
            }),
          ]}
          onClose={vi.fn()}
        />
      )
      const copyButton = screen.getByRole('button', { name: /Copy URL/ })
      expect(copyButton.querySelector('.lucide-copy')).not.toBeNull()

      fireEvent.click(copyButton)
      await waitFor(() =>
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
          'https://example.com/file.zip'
        )
      )
      expect(copyButton.querySelector('.lucide-check')).not.toBeNull()
    })

    it('BT task with infoHash copies a magnet URI carrying name + trackers', async () => {
      // announceList is projected out of the broadcast; the click-time
      // fetch reads it through the full per-task detail.
      vi.mocked(transport.invoke).mockImplementation(async (channel) =>
        channel === Queries.GetTaskDetail
          ? {
              id: 't1',
              bt: {
                announceList: [['udp://t1/announce'], ['udp://t2/announce']],
                magnetUri: null,
              },
            }
          : { ok: true }
      )
      render(
        <TaskInspectorActionBar
          selected={[
            makeTask({
              name: 'demo',
              type: TaskType.Bt,
              infoHash: 'abc123',
              uris: [],
            }),
          ]}
          onClose={vi.fn()}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /Copy URL/ }))
      await waitFor(() =>
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
          'magnet:?xt=urn:btih:abc123&dn=demo' +
            '&tr=udp%3A%2F%2Ft1%2Fannounce' +
            '&tr=udp%3A%2F%2Ft2%2Fannounce'
        )
      )
    })

    it('BT task without bt data falls back to bare magnet from infoHash', async () => {
      render(
        <TaskInspectorActionBar
          selected={[
            makeTask({
              name: 'sample',
              type: TaskType.Bt,
              infoHash: 'abc123',
              uris: [],
            }),
          ]}
          onClose={vi.fn()}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /Copy URL/ }))
      await waitFor(() =>
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
          'magnet:?xt=urn:btih:abc123&dn=sample'
        )
      )
    })

    it('BT task with bt.magnetUri prefers it over infoHash', async () => {
      vi.mocked(transport.invoke).mockImplementation(async (channel) =>
        channel === Queries.GetTaskDetail
          ? {
              id: 't1',
              bt: {
                announceList: [],
                magnetUri: 'magnet:?xt=urn:btih:abc123&tr=udp://t/announce',
              },
            }
          : { ok: true }
      )
      render(
        <TaskInspectorActionBar
          selected={[
            makeTask({
              type: TaskType.Bt,
              infoHash: 'abc123',
              uris: [],
            }),
          ]}
          onClose={vi.fn()}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /Copy URL/ }))
      await waitFor(() =>
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
          'magnet:?xt=urn:btih:abc123&tr=udp://t/announce'
        )
      )
    })

    it('keeps the idle icon and reports an error when task details cannot load', async () => {
      vi.mocked(transport.invoke).mockRejectedValueOnce(
        new Error('detail unavailable')
      )
      render(
        <TaskInspectorActionBar
          selected={[
            makeTask({
              type: TaskType.Bt,
              infoHash: 'abc123',
              uris: [],
            }),
          ]}
          onClose={vi.fn()}
        />
      )

      const copyButton = screen.getByRole('button', { name: /Copy URL/ })
      fireEvent.click(copyButton)

      await waitFor(() => expect(toastAddMock).toHaveBeenCalledTimes(1))
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
      expect(copyButton.querySelector('.lucide-copy')).not.toBeNull()
      expect(copyButton.querySelector('.lucide-check')).toBeNull()
    })
  })
})
