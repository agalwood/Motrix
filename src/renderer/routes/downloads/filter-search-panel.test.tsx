import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus, TaskType } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  FilterSearchPanel,
  type FilterSearchPanelProps,
} from './filter-search-panel'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

function fake(over: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask({
    id: 't',
    engineTaskId: 'g',
    name: 'demo.iso',
    progress: 0.5,
    totalBytes: 1000,
    downloadedBytes: 500,
    saveDir: '/tmp',
    uris: ['https://example.com/demo.iso'],
    fileCount: 1,
    filename: 'demo.iso',
    sizeWhenDone: 1000,
    diskPath: '/tmp/demo.iso',
    finalPath: '/tmp/demo.iso',
    finalName: 'demo.iso',
    ...over,
  })
}

const tasks = [
  fake({ id: 'a', name: 'Ubuntu 24.04', type: TaskType.Http }),
  fake({
    id: 'b',
    name: 'Ubuntu server',
    type: TaskType.Magnet,
    status: TaskStatus.Completed,
  }),
  fake({ id: 'c', name: 'Fedora 41', type: TaskType.Bt }),
  fake({
    id: 'd',
    name: 'Ubuntu meta',
    type: TaskType.Http,
    status: TaskStatus.MetadataReady,
  }),
]
const typeCounts = {
  [TaskType.Http]: 2,
  [TaskType.Magnet]: 1,
  [TaskType.Bt]: 1,
  [TaskType.Ftp]: 0,
  [TaskType.Metalink]: 0,
}

function setup(props: Partial<FilterSearchPanelProps> = {}) {
  const onTypesChange = vi.fn()
  const onOpenTask = vi.fn()
  const user = userEvent.setup()
  render(
    <FilterSearchPanel
      tasks={tasks}
      types={[]}
      onTypesChange={onTypesChange}
      typeCounts={typeCounts}
      onOpenTask={onOpenTask}
      {...props}
    />
  )
  return { onTypesChange, onOpenTask, user }
}

describe('FilterSearchPanel', () => {
  it('renders only matching tasks as the user types', async () => {
    const { user } = setup()
    await user.type(screen.getByPlaceholderText(/search downloads/i), 'ubuntu')
    expect(screen.getByText('Ubuntu 24.04')).toBeInTheDocument()
    expect(screen.getByText('Ubuntu server')).toBeInTheDocument()
    expect(screen.getByText('Ubuntu meta')).toBeInTheDocument()
    expect(screen.queryByText('Fedora 41')).not.toBeInTheDocument()
  })

  it('toggling a type chip calls onTypesChange', async () => {
    const { user, onTypesChange } = setup()
    await user.click(screen.getByRole('button', { name: /HTTP/i }))
    expect(onTypesChange).toHaveBeenCalledWith([TaskType.Http])
  })

  it('toggling an active type chip deselects it', async () => {
    const { user, onTypesChange } = setup({ types: [TaskType.Http] })
    await user.click(screen.getByRole('button', { name: /HTTP/i }))
    expect(onTypesChange).toHaveBeenCalledWith([])
  })

  it('disables zero-count chips', () => {
    setup()
    expect(screen.getByRole('button', { name: /FTP/i })).toBeDisabled()
  })

  it('Enter on the highlighted result calls onOpenTask', async () => {
    const { user, onOpenTask } = setup()
    await user.type(screen.getByPlaceholderText(/search downloads/i), 'fedora')
    await user.keyboard('{Enter}')
    expect(onOpenTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c' })
    )
  })

  it('shows the empty state for no matches', async () => {
    const { user } = setup()
    await user.type(screen.getByPlaceholderText(/search downloads/i), 'zzzz')
    expect(screen.getByText(/no matching tasks/i)).toBeInTheDocument()
  })
})
