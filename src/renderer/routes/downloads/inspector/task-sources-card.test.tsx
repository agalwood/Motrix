import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { TaskKind, TaskType } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskSourcesCard } from './task-sources-card'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn(), platform: 'darwin' },
}))
vi.mock('@renderer/features/application-menu/task-context', () => ({
  taskWritesAvailable: () => true,
}))

const task = makeDownloadTask({ id: 'owner', engineTaskId: 'gid' })
const snapshot = {
  taskId: task.id,
  engineTaskId: task.engineTaskId,
  kind: 'http',
  uris: ['https://old.test/file'],
  editable: true,
}
beforeEach(() => {
  vi.mocked(transport.invoke).mockReset()
  vi.mocked(transport.on).mockClear()
})

async function edit(bt = false) {
  render(
    <TaskSourcesCard
      task={bt ? { ...task, type: TaskType.Bt, kind: TaskKind.Bt } : task}
    />
  )
  const button = await screen.findByRole('button', { name: 'Edit' })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  return within(await screen.findByRole('dialog'))
}

describe('task sources editor', () => {
  it('sends domain identity, ordered sources and the original snapshot', async () => {
    vi.mocked(transport.invoke)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({ ...snapshot, uris: ['https://new.test/file'] })
    const dialog = await edit()
    fireEvent.change(dialog.getByRole('textbox'), {
      target: { value: 'https://new.test/file' },
    })
    fireEvent.click(dialog.getByRole('button', { name: 'Apply' }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(Commands.SetTaskSources, {
        taskId: 'owner',
        engineTaskId: 'gid',
        previous: snapshot.uris,
        uris: ['https://new.test/file'],
      })
    )
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(screen.getByText('https://new.test/file')).toBeVisible()
  })

  it('keeps the editing baseline when an engine refresh arrives during an edit', async () => {
    vi.mocked(transport.invoke)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({
        ...snapshot,
        uris: ['https://external.test/file'],
      })
      .mockRejectedValueOnce(new Error('task.sources.changed'))
    const dialog = await edit()
    fireEvent.change(dialog.getByRole('textbox'), {
      target: { value: 'https://draft.test/file' },
    })
    const refresh = vi
      .mocked(transport.on)
      .mock.calls.find(([event]) => event === Events.EngineStateChanged)?.[1]
    await act(async () => {
      refresh?.(undefined)
    })
    await waitFor(() =>
      expect(dialog.getByRole('button', { name: 'Apply' })).toBeEnabled()
    )
    expect(dialog.getByRole('textbox')).toHaveValue('https://draft.test/file')
    fireEvent.click(dialog.getByRole('button', { name: 'Apply' }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.SetTaskSources,
        expect.objectContaining({ previous: snapshot.uris })
      )
    )
    await waitFor(() =>
      expect(dialog.getByRole('alert')).toHaveTextContent('Sources changed')
    )
  })

  it('rejects an empty HTTP source list without sending a mutation', async () => {
    vi.mocked(transport.invoke).mockResolvedValue(snapshot)
    const dialog = await edit()
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: '' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Apply' }))
    expect(dialog.getByRole('alert')).toHaveTextContent('valid URLs')
    expect(transport.invoke).toHaveBeenCalledTimes(1)
  })

  it('allows removing every webseed', async () => {
    vi.mocked(transport.invoke)
      .mockResolvedValueOnce({ ...snapshot, kind: 'webseed' })
      .mockResolvedValueOnce({ ...snapshot, kind: 'webseed', uris: [] })
    const dialog = await edit(true)
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: '' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Apply' }))
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.SetTaskSources,
        expect.objectContaining({ uris: [] })
      )
    )
  })

  it('reloads a stale snapshot before applying further edits', async () => {
    vi.mocked(transport.invoke)
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new Error('task.sources.changed'))
      .mockResolvedValueOnce({
        ...snapshot,
        uris: ['https://external.test/file'],
      })
    const dialog = await edit()
    fireEvent.change(dialog.getByRole('textbox'), {
      target: { value: 'https://new.test/file' },
    })
    fireEvent.click(dialog.getByRole('button', { name: 'Apply' }))
    await waitFor(() =>
      expect(dialog.getByRole('alert')).toHaveTextContent('Sources changed')
    )
    fireEvent.click(dialog.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(dialog.getByRole('textbox')).toHaveValue(
        'https://external.test/file'
      )
    )
    expect(transport.invoke).toHaveBeenLastCalledWith(Queries.GetTaskSources, {
      taskId: 'owner',
      engineTaskId: 'gid',
    })
  })

  it('disables editing when the engine exposes a read-only state', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      ...snapshot,
      editable: false,
    })
    render(<TaskSourcesCard task={task} />)
    await screen.findByText('https://old.test/file')
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
  })
})
