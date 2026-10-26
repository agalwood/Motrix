import '@test-utils/dom-animations'
import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { toast } from '@renderer/components/ui/toast'
import { openAddTaskDialog } from '@renderer/lib/open-add-task-dialog'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  TaskInstancePhase,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LegacyFreshDownload } from './legacy-fresh-download'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), platform: 'darwin' },
}))
vi.mock('@renderer/lib/open-add-task-dialog', () => ({
  openAddTaskDialog: vi.fn(),
}))
vi.mock('@renderer/components/ui/toast', () => ({
  toast: { add: vi.fn() },
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
    vi.mocked(openAddTaskDialog).mockReset()
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

describe('legacy HTTP activation and explicit fresh download', () => {
  const httpTask = makeDownloadTask({
    id: 'legacy-http',
    type: TaskType.Http,
    status: TaskStatus.Paused,
    saveDir: '/original/downloads',
    instances: [
      {
        instanceId: 'legacy-http-instance',
        motrixId: 'legacy-http',
        gid: null,
        phase: TaskInstancePhase.HttpDownload,
        status: TaskStatus.Paused,
        progress: 0,
        totalBytes: 0,
        downloadedBytes: 0,
        uploadedBytes: 0,
        diskPath: '/original/downloads',
        transitionPhase: TransitionPhase.Idle,
        uris: ['https://example.com/file.zip'],
        uriHash: null,
        createdAt: 0,
        updatedAt: 0,
        payload: {
          legacyImport: {
            version: 1,
            sourceId: 'source',
            itemKey: 'item',
            activation: 'inactive',
            storagePolicy: 'legacy-read-only',
            reason: 'request-settings-required',
            requestOptions: ['header', 'all-proxy'],
            selectionKnown: true,
            selectedFiles: [],
          },
        },
      },
    ],
  })

  beforeEach(() => {
    vi.mocked(transport.invoke).mockReset()
    vi.mocked(openAddTaskDialog).mockReset()
    vi.mocked(toast.add).mockReset()
    vi.mocked(transport.invoke).mockImplementation(async (channel) =>
      channel === Queries.GetLegacyHttpActivationAvailability
        ? { available: true, reason: null, directory: httpTask.saveDir }
        : false
    )
  })

  it('explains restored proxy settings and omitted options for imported magnets', () => {
    const magnetTask = {
      ...httpTask,
      type: TaskType.Magnet,
      instances: httpTask.instances.map((instance) => ({
        ...instance,
        payload: {
          legacyImport: {
            ...(instance.payload.legacyImport as Record<string, unknown>),
            reason: 'metadata-required',
            requestOptions: ['all-proxy'],
            ignoredOptions: ['header', 'on-download-complete'],
          },
        },
      })),
    }
    render(<LegacyFreshDownload task={magnetTask} />)
    expect(
      screen.getByText(
        'This download will use the old proxy settings from the migration backup.'
      )
    ).toBeVisible()
    expect(
      screen.getByText(
        'Unsupported options omitted: header, on-download-complete'
      )
    ).toBeVisible()
    expect(
      screen.queryByText('The old request settings were not copied.', {
        exact: false,
      })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Verify and continue' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Looking for your old downloads…')
    ).not.toBeInTheDocument()
    expect(transport.invoke).not.toHaveBeenCalled()
  })

  it('checks HTTP availability and resumes with only the task identity after an explicit click', async () => {
    render(<LegacyFreshDownload task={httpTask} />)
    const button = screen.getByRole('button', { name: 'Verify and continue' })
    await waitFor(() => expect(button).toBeEnabled())
    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith(
      Queries.GetLegacyHttpActivationAvailability,
      { taskId: httpTask.id }
    )
    expect(screen.getByText(httpTask.saveDir)).toBeVisible()
    expect(
      screen.getByText('Saved request settings: header, all-proxy')
    ).toBeVisible()
    expect(
      screen.getByText('Motrix will compare all downloaded ranges', {
        exact: false,
      })
    ).toHaveTextContent('saved request settings stay in memory.')
    expect(
      screen.queryByText('The old request settings were not copied.', {
        exact: false,
      })
    ).not.toBeInTheDocument()
    fireEvent.click(button)
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.ActivateLegacyHttp,
        {
          taskId: httpTask.id,
        }
      )
    )
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.PrepareLegacyFreshDownload,
      expect.anything()
    )
    expect(openAddTaskDialog).not.toHaveBeenCalled()
  })

  it('offers verification for HTTP records without custom request settings', async () => {
    render(<LegacyFreshDownload task={{ ...httpTask, instances: [] }} />)
    const button = screen.getByRole('button', { name: 'Verify and continue' })
    await waitFor(() => expect(button).toBeEnabled())
    expect(
      screen.getByRole('button', { name: 'Download again…' })
    ).toBeEnabled()
    fireEvent.click(button)
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.ActivateLegacyHttp,
        {
          taskId: httpTask.id,
        }
      )
    )
  })

  it('disables unavailable HTTP resume and keeps a manual fallback without launching it', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      available: false,
      reason: 'legacyImport.errors.controlRequired',
      directory: httpTask.saveDir,
    })
    render(<LegacyFreshDownload task={httpTask} />)
    await screen.findByText(
      'The saved download progress is missing. Download again in a new folder.'
    )
    expect(
      screen.getByRole('button', { name: 'Verify and continue' })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Reconfigure and download…' })
    ).toBeEnabled()
    expect(transport.invoke).toHaveBeenCalledTimes(1)
    expect(openAddTaskDialog).not.toHaveBeenCalled()
  })

  it('explains verification traffic, blocks duplicate activation, and permits cancellation', async () => {
    let complete: (value: boolean) => void = () => {}
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetLegacyHttpActivationAvailability)
        return { available: true, reason: null, directory: httpTask.saveDir }
      if (channel === Commands.ActivateLegacyHttp)
        return new Promise((resolve) => {
          complete = resolve
        })
      return true
    })
    render(<LegacyFreshDownload task={httpTask} />)
    const button = screen.getByRole('button', { name: 'Verify and continue' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    fireEvent.click(button)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Preparing or verifying…'
    )
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(
          ([channel]) => channel === Commands.ActivateLegacyHttp
        )
    ).toHaveLength(1)
    expect(
      screen.getByRole('button', { name: 'Reconfigure and download…' })
    ).toBeDisabled()
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    fireEvent.click(cancel)
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.CancelLegacyHttpActivation,
        { taskId: httpTask.id }
      )
    )
    expect(cancel).toBeDisabled()
    await act(async () => complete(false))
    expect(button).toBeEnabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(openAddTaskDialog).not.toHaveBeenCalled()
  })

  it.each([TaskType.Http, TaskType.Bt, TaskType.Magnet])(
    'keeps cancellation bound to its original HTTP task after selecting %s',
    async (nextType) => {
      let complete: (value: boolean) => void = () => {}
      vi.mocked(transport.invoke).mockImplementation(async (channel) => {
        if (channel === Commands.ActivateLegacyHttp)
          return new Promise((resolve) => {
            complete = resolve
          })
        if (channel === Commands.CancelLegacyHttpActivation) return true
        return { available: true, reason: null, directory: httpTask.saveDir }
      })
      const { rerender } = render(<LegacyFreshDownload task={httpTask} />)
      const start = screen.getByRole('button', { name: 'Verify and continue' })
      await waitFor(() => expect(start).toBeEnabled())
      fireEvent.click(start)
      const next = makeDownloadTask({
        id: 'other-task',
        name: 'other-file',
        type: nextType,
      })
      rerender(<LegacyFreshDownload task={next} />)
      expect(screen.getByRole('status')).toHaveTextContent(httpTask.name)
      expect(screen.getByRole('status')).not.toHaveTextContent('other-file')
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await waitFor(() =>
        expect(transport.invoke).toHaveBeenCalledWith(
          Commands.CancelLegacyHttpActivation,
          { taskId: httpTask.id }
        )
      )
      expect(transport.invoke).not.toHaveBeenCalledWith(
        Commands.CancelLegacyHttpActivation,
        { taskId: next.id }
      )
      await act(async () => complete(false))
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    }
  )

  it.each([
    [
      'httpContentChanged',
      'The downloaded data differs from the server content.',
    ],
    [
      'httpRangeUnsupported',
      'The server does not support the required byte ranges.',
    ],
    [
      'httpValidatorRequired',
      'The server does not provide a strong resource version.',
    ],
    ['httpVerificationFailed', 'Could not verify the downloaded data.'],
    [
      'httpRequestUnsupported',
      'The engine or request settings do not support safe resume.',
    ],
    ['httpVerificationCancelled', 'Verification cancelled.'],
    [
      'httpRedirectUnsupported',
      'Redirected links cannot be safely resumed in place.',
    ],
  ])(
    'reports %s and never starts a new download automatically',
    async (code, message) => {
      vi.mocked(transport.invoke).mockImplementation(async (channel) => {
        if (channel === Queries.GetLegacyHttpActivationAvailability)
          return { available: true, reason: null, directory: httpTask.saveDir }
        throw new Error(`legacyImport.errors.${code}`)
      })
      render(<LegacyFreshDownload task={httpTask} />)
      const button = screen.getByRole('button', { name: 'Verify and continue' })
      await waitFor(() => expect(button).toBeEnabled())
      fireEvent.click(button)
      await waitFor(() =>
        expect(toast.add).toHaveBeenCalledWith({
          type: 'error',
          title: expect.stringContaining(message),
          description: 'Your existing files were kept.',
        })
      )
      expect(button).toBeEnabled()
      expect(transport.invoke).not.toHaveBeenCalledWith(
        Commands.PrepareLegacyFreshDownload,
        expect.anything()
      )
      expect(openAddTaskDialog).not.toHaveBeenCalled()
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    }
  )

  it('requires confirmation and hands the settings reminder to the download form', async () => {
    const prefill = {
      tab: 'links' as const,
      urls: 'https://example.com/file.zip',
      saveDir: '/new/downloads',
      legacyRequestOptions: ['header', 'all-proxy'],
    }
    vi.mocked(transport.invoke).mockImplementation(async (channel) =>
      channel === Queries.GetLegacyHttpActivationAvailability
        ? { available: true, reason: null, directory: httpTask.saveDir }
        : prefill
    )
    render(<LegacyFreshDownload task={httpTask} />)
    await waitFor(() => expect(transport.invoke).toHaveBeenCalledTimes(1))
    fireEvent.click(
      screen.getByRole('button', { name: 'Reconfigure and download…' })
    )
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'The old request settings were not copied.'
    )
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'It will start from the beginning and leave your old files untouched.'
    )
    expect(transport.invoke).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(transport.invoke).toHaveBeenCalledTimes(1)
    fireEvent.click(
      screen.getByRole('button', { name: 'Reconfigure and download…' })
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Choose another location…' })
    )
    await waitFor(() => expect(openAddTaskDialog).toHaveBeenCalledWith(prefill))
    expect(transport.invoke).toHaveBeenCalledWith(
      Commands.PrepareLegacyFreshDownload,
      { taskId: httpTask.id }
    )
    expect(transport.invoke).toHaveBeenCalledTimes(2)
  })

  it('keeps the confirmation open when choosing a new destination is cancelled', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (channel) =>
      channel === Queries.GetLegacyHttpActivationAvailability
        ? { available: true, reason: null, directory: httpTask.saveDir }
        : null
    )
    render(<LegacyFreshDownload task={httpTask} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Reconfigure and download…' })
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Choose another location…' })
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Choose another location…' })
      ).toBeEnabled()
    )
    expect(screen.getByRole('alertdialog')).toBeVisible()
    expect(openAddTaskDialog).not.toHaveBeenCalled()
  })
})
