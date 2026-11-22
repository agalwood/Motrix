import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { makeDownloadTask } from '@test-utils/task'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { TaskFileRenameDialog } from './task-file-rename-dialog'

vi.mock('@renderer/lib/transport', () => ({
  transport: { platform: 'darwin', invoke: vi.fn() },
}))
const task = makeDownloadTask({ id: 'task', engineTaskId: 'engine' })
const file = {
  index: 3,
  path: 'nested/original.bin',
  size: 100,
  completedBytes: 50,
  selected: true,
}
beforeEach(() => vi.mocked(transport.invoke).mockReset())
it('waits for the committed engine view before closing and refreshing files', async () => {
  let finish!: () => void
  vi.mocked(transport.invoke).mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve
    })
  )
  const close = vi.fn(),
    refresh = vi.fn(async () => {})
  render(
    <TaskFileRenameDialog
      task={task}
      file={file}
      onClose={close}
      onRenamed={refresh}
    />
  )
  fireEvent.change(screen.getByRole('textbox', { name: 'File name' }), {
    target: { value: 'changed.bin' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  expect(transport.invoke).toHaveBeenCalledWith(Commands.RenameTaskFile, {
    taskId: 'task',
    engineTaskId: 'engine',
    fileIndex: 3,
    expectedName: 'original.bin',
    name: 'changed.bin',
  })
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox')).toBeDisabled()
  await act(async () => finish())
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(refresh).toHaveBeenCalledOnce()
})
it('rejects path traversal before dispatch', () => {
  render(
    <TaskFileRenameDialog
      task={task}
      file={file}
      onClose={vi.fn()}
      onRenamed={vi.fn()}
    />
  )
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: '../escape' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  expect(screen.getByRole('alert')).toHaveTextContent('valid filename')
  expect(transport.invoke).not.toHaveBeenCalled()
})
it('keeps the dialog open and reloads actual files after an unconfirmed rename', async () => {
  vi.mocked(transport.invoke).mockImplementation(async (channel) => {
    if (channel === Commands.RenameTaskFile)
      throw new Error('task.fileRename.pending')
    return undefined
  })
  const close = vi.fn(),
    refresh = vi.fn(async () => {})
  render(
    <TaskFileRenameDialog
      task={task}
      file={file}
      onClose={close}
      onRenamed={refresh}
    />
  )
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'changed.bin' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert')).toHaveTextContent('not confirmed')
  expect(close).not.toHaveBeenCalled()
  expect(refresh).toHaveBeenCalledOnce()
})
