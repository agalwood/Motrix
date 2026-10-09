import '@test-utils/dom-animations'
import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { TaskStatus, TaskType } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LegacyFreshDownload } from './legacy-fresh-download'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), platform: 'darwin' },
}))
vi.mock('@renderer/lib/open-add-task-dialog', () => ({
  openAddTaskDialog: vi.fn(),
}))
const task = makeDownloadTask({
  id: 'legacy-bt',
  type: TaskType.Bt,
  status: TaskStatus.Paused,
  saveDir: '/original/downloads',
})
describe('legacy BT activation entry', () => {
  beforeEach(() => {
    vi.mocked(transport.invoke).mockReset()
  })
  it('shows the original directory and only sends opaque task identity on explicit activation', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (channel) =>
      channel === Queries.GetLegacyBtActivationAvailability
        ? { available: true, reason: null, directory: task.saveDir }
        : false
    )
    render(<LegacyFreshDownload task={task} />)
    const button = await screen.findByRole('button', {
      name: 'Verify and continue',
    })
    await waitFor(() => expect(button).toBeEnabled())
    expect(screen.getByText(task.saveDir)).toBeVisible()
    expect(
      screen.queryByText('This version imports task records only.', {
        exact: false,
      })
    ).not.toBeInTheDocument()
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.ActivateLegacyBt,
      expect.anything()
    )
    fireEvent.click(button)
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(Commands.ActivateLegacyBt, {
        taskId: task.id,
      })
    )
    expect(
      screen.getByRole('button', { name: 'Download again…' })
    ).toBeEnabled()
  })
  it('disables an unsupported engine and keeps the fresh download entry', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      available: false,
      reason: 'legacyImport.errors.checkpointUnavailable',
      directory: task.saveDir,
    })
    render(<LegacyFreshDownload task={task} />)
    await screen.findByText(
      'This version can’t resume the old files. You can download again in a new folder.'
    )
    expect(
      screen.getByRole('button', { name: 'Verify and continue' })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Download again…' })
    ).toBeEnabled()
  })
  it('guards activation double clicks and recovers after picker cancellation', async () => {
    let complete: (value: boolean) => void = () => {}
    vi.mocked(transport.invoke).mockImplementation(async (channel) =>
      channel === Queries.GetLegacyBtActivationAvailability
        ? { available: true, reason: null, directory: task.saveDir }
        : new Promise((resolve) => {
            complete = resolve
          })
    )
    render(<LegacyFreshDownload task={task} />)
    const button = screen.getByRole('button', { name: 'Verify and continue' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    fireEvent.click(button)
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(([channel]) => channel === Commands.ActivateLegacyBt)
    ).toHaveLength(1)
    complete(false)
    await waitFor(() => expect(button).toBeEnabled())
  })
})
