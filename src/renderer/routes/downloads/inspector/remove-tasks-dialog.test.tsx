import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import '@renderer/lib/i18n'
import { RemoveTasksDialog } from './remove-tasks-dialog'

// Kept overrides: id:'t1' (≠ 'task-1'), name:'A task' (≠ 'task'),
// saveDir:'/tmp' (≠ ''), uris:['http://example.com'] (≠ []),
// fileCount:1 (≠ 0), filename:'A task' (≠ ''),
// sizeWhenDone:1024*1024*100 (≠ 0), diskPath:'/tmp' (≠ ''),
// finalPath:'/tmp/file' (≠ ''), finalName:'file' (≠ '').
// Dropped: engineTaskId:'gid-1' (= default), kind:Direct (= default),
// type:Http (= default), status:Downloading (= default), all-zero/null/empty.
function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask({
    id: 't1',
    name: 'A task',
    saveDir: '/tmp',
    uris: ['http://example.com'],
    fileCount: 1,
    filename: 'A task',
    sizeWhenDone: 1024 * 1024 * 100, // 100 MB
    diskPath: '/tmp',
    finalPath: '/tmp/file',
    finalName: 'file',
    ...overrides,
  })
}

describe('RemoveTasksDialog', () => {
  it('renders single-task title with a middle ellipsis that keeps the extension', () => {
    render(
      <RemoveTasksDialog
        open={true}
        selected={[makeTask({ name: `${'X'.repeat(60)}.mkv` })]}
        preCheckDeleteFiles={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    const title = screen.getByText(/Remove “/)
    // Middle ellipsis: a head, the '…', then a tail that preserves the
    // extension — NOT a silent end-cut that drops it.
    expect(title.textContent).toMatch(/X+…X*\.mkv”\?$/)
    expect(title.textContent?.length).toBeLessThan(100)
  })

  it('renders all-paused title for homogeneous selection', () => {
    render(
      <RemoveTasksDialog
        open={true}
        selected={[
          makeTask({ id: 'a', status: TaskStatus.Paused }),
          makeTask({ id: 'b', status: TaskStatus.Paused }),
        ]}
        preCheckDeleteFiles={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByText(/2 paused tasks/i)).toBeDefined()
  })

  it('renders mixed title for heterogeneous selection', () => {
    render(
      <RemoveTasksDialog
        open={true}
        selected={[
          makeTask({ id: 'a', status: TaskStatus.Paused }),
          makeTask({ id: 'b', status: TaskStatus.Error }),
        ]}
        preCheckDeleteFiles={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByText(/Remove 2 tasks/)).toBeDefined()
  })

  it('defaults deleteFiles to false for all-Error selection', () => {
    // Error tasks can still hold partial data on disk; deleting must always
    // be an explicit opt-in, never a status-based default.
    render(
      <RemoveTasksDialog
        open={true}
        selected={[
          makeTask({ id: 'a', status: TaskStatus.Error, downloadedBytes: 0 }),
          makeTask({ id: 'b', status: TaskStatus.Error, downloadedBytes: 0 }),
        ]}
        preCheckDeleteFiles={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox.getAttribute('aria-checked')).toBe('false')
  })

  it('defaults deleteFiles to false for all-Completed selection', () => {
    render(
      <RemoveTasksDialog
        open={true}
        selected={[
          makeTask({ id: 'a', status: TaskStatus.Completed }),
          makeTask({ id: 'b', status: TaskStatus.Completed }),
        ]}
        preCheckDeleteFiles={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox.getAttribute('aria-checked')).toBe('false')
  })

  it('preCheckDeleteFiles=true overrides bias', () => {
    render(
      <RemoveTasksDialog
        open={true}
        selected={[makeTask({ status: TaskStatus.Completed })]}
        preCheckDeleteFiles={true}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox.getAttribute('aria-checked')).toBe('true')
  })

  it('shows file-size estimate banner when deleteFiles is checked + has output', () => {
    render(
      <RemoveTasksDialog
        open={true}
        selected={[
          makeTask({
            status: TaskStatus.Completed,
            downloadedBytes: 100 * 1024 * 1024,
            sizeWhenDone: 100 * 1024 * 1024,
          }),
        ]}
        preCheckDeleteFiles={true}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByText(/Will delete/)).toBeDefined()
    expect(screen.getByText(/100/)).toBeDefined()
  })

  it('confirm button calls onConfirm with current deleteFiles state', () => {
    const onConfirm = vi.fn()
    render(
      <RemoveTasksDialog
        open={true}
        selected={[makeTask({ status: TaskStatus.Completed })]}
        preCheckDeleteFiles={true}
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />
    )
    fireEvent.click(screen.getByText(/^Remove$/))
    expect(onConfirm).toHaveBeenCalledWith(true)
  })
})
