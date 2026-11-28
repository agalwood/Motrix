import '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import type { BtStorageCommandResult } from '@shared/schemas/bt-storage'
import { TaskStatus, TaskType } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BtStorageDialog } from './bt-storage-dialog'

vi.mock('@renderer/lib/transport', () => ({
  transport: { platform: 'web', invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))
vi.mock('@renderer/hooks/use-task-list', () => ({
  invalidateTaskList: vi.fn(),
}))
const task = makeDownloadTask({
  id: 'bt',
  type: TaskType.Bt,
  status: TaskStatus.Completed,
  name: 'movie',
  finalName: 'movie',
  saveDir: '/downloads',
  finalPath: '/downloads/movie',
})
const complete: BtStorageCommandResult = {
  taskId: task.id,
  path: task.finalPath,
  verification: {
    complete: true,
    totalPieces: 10,
    checkedPieces: 10,
    validPieces: 10,
    missingFiles: [],
    invalidFiles: [],
  },
  resumed: false,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('BT storage dialog', () => {
  it('runs a recheck without requesting repair or automatic seeding', async () => {
    vi.mocked(transport.invoke).mockResolvedValue(complete)
    render(<BtStorageDialog task={task} mode="recheck" onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check files…' }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.ChangeBtStorage,
        expect.objectContaining({
          taskId: 'bt',
          mode: 'recheck',
          resume: false,
        })
      )
    )
    expect(
      await screen.findByText('Your files are ready to seed.')
    ).toBeTruthy()
  })

  it('shows verification failure without claiming seeding resumed', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      ...complete,
      verification: {
        ...complete.verification,
        complete: false,
        validPieces: 3,
      },
    })
    render(<BtStorageDialog task={task} mode="recheck" onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check files…' }))
    expect(
      await screen.findByText(/Some files are missing or incomplete/)
    ).toBeTruthy()
    expect(screen.getByText('Verified: 30%')).toBeTruthy()
  })

  it('keeps the dialog open while checking, permits cancellation and removes its event listener', async () => {
    let finish!: (result: BtStorageCommandResult) => void
    vi.mocked(transport.invoke).mockImplementation(async (command) =>
      command === Commands.ChangeBtStorage
        ? new Promise((resolve) => {
            finish = resolve
          })
        : { ok: true }
    )
    const onClose = vi.fn()
    const { unmount } = render(
      <BtStorageDialog task={task} mode="recheck" onClose={onClose} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check files…' }))
    const cancel = await screen.findByRole('button', { name: 'Cancel' })
    fireEvent.click(cancel)
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.CancelBtStorage,
      'bt'
    )
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => finish({ error: 'cancelled' }))
    expect(await screen.findByText('Check cancelled.')).toBeTruthy()
    const listener = vi
      .mocked(transport.on)
      .mock.calls.find(([event]) => event === Events.BtStorageProgress)?.[1]
    unmount()
    expect(transport.off).toHaveBeenCalledWith(
      Events.BtStorageProgress,
      listener
    )
  })
})
