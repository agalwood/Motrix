import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { electronServices } from '@renderer/platform/electron-services'
import { PlatformServicesProvider } from '@renderer/platform/services'
import { Commands } from '@shared/protocol/commands'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaMergeDialogHost } from './media-merge-dialog'
import { MediaMergeForm } from './media-merge-form'
import { useMediaMergeDialog, useMediaMergeSessions } from './media-merge-store'

vi.mock('@renderer/lib/transport', () => ({ transport: { invoke: vi.fn() } }))
const invoke = vi.mocked(transport.invoke)
const pluginId = 'community.media-merge'
const inputs = {
  videoInput: '/downloads/video.mp4',
  audioInput: '/downloads/audio.mp4',
  output: '/downloads/merged.mp4',
}
const job = {
  pluginId,
  id: '04f56840-f5af-4960-884e-72b7cd15781a',
  status: 'running',
  percent: 0,
  output: inputs.output,
}

describe('manual media merge dialog', () => {
  beforeEach(() => {
    useMediaMergeSessions.setState({ sessions: {} })
    useMediaMergeDialog.setState({ open: false, request: {} })
    invoke.mockReset().mockImplementation(async (command) => {
      if (command === Commands.GetMediaMergeState)
        return { providers: [{ pluginId, title: 'Media Merge' }], job: null }
      if (command === Commands.GetMediaMergeSelection) return inputs
      if (command === Commands.StartMediaMerge) return job
      if (command === Commands.GetMediaMergeJob)
        return { ...job, status: 'completed', percent: 100 }
      if (command === Commands.CancelMediaMerge)
        return { ...job, status: 'cancelled' }
      return null
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    cleanup()
    useMediaMergeSessions.setState({ sessions: {} })
    useMediaMergeDialog.setState({ open: false, request: {} })
  })

  it('pre-fills completed downloads, runs once, and shows the output', async () => {
    render(
      <PlatformServicesProvider services={electronServices}>
        <MediaMergeDialogHost />
      </PlatformServicesProvider>
    )
    act(() =>
      useMediaMergeDialog.getState().openWith({ taskIds: ['video', 'audio'] })
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Browse Video file' })
      ).toHaveAttribute('title', inputs.videoInput)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))
    await screen.findByText('Merged successfully')
    expect(invoke).toHaveBeenCalledWith(Commands.GetMediaMergeSelection, [
      'video',
      'audio',
    ])
    expect(invoke).toHaveBeenCalledWith(Commands.StartMediaMerge, {
      ...inputs,
      pluginId,
    })
    expect(screen.getByText(inputs.output)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(Commands.RevealInFolder, {
        mediaMergeJobId: job.id,
      })
    )
    expect(
      screen.getByRole('button', { name: 'Merge another file' })
    ).toBeEnabled()
  })

  it('selects local files and suggests a new output filename', async () => {
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (command, ...args) =>
      command === Commands.PickFile ? inputs.videoInput : base(command, ...args)
    )
    render(
      <PlatformServicesProvider services={electronServices}>
        <MediaMergeDialogHost />
      </PlatformServicesProvider>
    )
    act(() => useMediaMergeDialog.getState().openWith({ pluginId }))
    const browse = await screen.findByRole('button', {
      name: 'Browse Video file',
    })
    await waitFor(() => expect(browse).toBeEnabled())
    fireEvent.click(browse)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Browse Video file' })
      ).toHaveAttribute('title', inputs.videoInput)
    )
    expect(
      screen.getByRole('button', { name: 'Browse Output file' })
    ).toHaveAttribute('title', '/downloads/video-merged.mp4')
  })

  it('allows cancellation and reports the terminal cancelled state', async () => {
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (command, ...args) =>
      command === Commands.GetMediaMergeJob ? job : base(command, ...args)
    )
    render(
      <PlatformServicesProvider services={electronServices}>
        <MediaMergeDialogHost />
      </PlatformServicesProvider>
    )
    act(() =>
      useMediaMergeDialog.getState().openWith({ taskIds: ['video', 'audio'] })
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Browse Video file' })
      ).toHaveAttribute('title', inputs.videoInput)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))
    expect(screen.queryByRole('button', { name: 'Open folder' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await screen.findByText('Merge cancelled')
    expect(invoke).toHaveBeenCalledWith(Commands.CancelMediaMerge, job.id)
  })

  it('explains the missing plugin and prevents submission', async () => {
    invoke.mockResolvedValue({ providers: [], job: null })
    render(
      <PlatformServicesProvider services={electronServices}>
        <MediaMergeDialogHost />
      </PlatformServicesProvider>
    )
    act(() => useMediaMergeDialog.getState().openWith())
    await screen.findByText(/Install and enable a media merge plugin/)
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled()
  })
  it('keeps a completed output visible and reports a folder-opening failure', async () => {
    useMediaMergeSessions.getState().save(pluginId, {
      values: { ...inputs, pluginId },
      job: { ...job, status: 'completed' },
    })
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (command, ...args) => {
      if (command === Commands.RevealInFolder)
        throw new Error('Folder is unavailable')
      return base(command, ...args)
    })
    render(
      <PlatformServicesProvider services={electronServices}>
        <MediaMergeForm pluginId={pluginId} />
      </PlatformServicesProvider>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Open folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Folder is unavailable'
    )
    expect(screen.getByText(inputs.output)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Open folder' })).toBeEnabled()
  })

  it('does not offer a local folder action for a Server output', async () => {
    vi.stubGlobal('__MOTRIX_TARGET__', 'web')
    useMediaMergeSessions.getState().save(pluginId, {
      values: { ...inputs, pluginId },
      job: { ...job, status: 'completed' },
    })
    render(
      <PlatformServicesProvider services={electronServices}>
        <MediaMergeForm pluginId={pluginId} />
      </PlatformServicesProvider>
    )
    await screen.findByText('Merged successfully')
    expect(screen.getByText(inputs.output)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Open folder' })).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith(
      Commands.RevealInFolder,
      expect.anything()
    )
  })
  it('restores an operation draft and retrieves its completed job after leaving the page', async () => {
    useMediaMergeSessions.getState().save(pluginId, {
      values: { ...inputs, pluginId },
      job: { ...job, status: 'running' },
    })
    render(
      <PlatformServicesProvider services={electronServices}>
        <MediaMergeForm pluginId={pluginId} />
      </PlatformServicesProvider>
    )
    await screen.findByText('Merged successfully')
    expect(
      screen.getByRole('button', { name: 'Browse Video file' })
    ).toHaveAttribute('title', inputs.videoInput)
    expect(invoke).toHaveBeenCalledWith(Commands.GetMediaMergeJob, job.id)
    fireEvent.click(screen.getByRole('button', { name: 'Merge another file' }))
    expect(
      screen.getByRole('button', { name: 'Browse Output file' })
    ).not.toHaveAttribute('title')
    expect(
      screen.getByRole('button', { name: 'Browse Audio file' })
    ).toHaveAttribute('title', inputs.audioInput)
    expect(screen.getByRole('button', { name: 'Merge' })).toBeVisible()
    expect(useMediaMergeSessions.getState().sessions[pluginId].job).toBeNull()
  })

  it('does not show another plugin’s job as its own or allow cancellation of it', async () => {
    const otherJob = { ...job, pluginId: 'other.merger' }
    invoke.mockImplementation(async (command) => {
      if (command === Commands.GetMediaMergeState)
        return {
          providers: [{ pluginId, title: 'Media Merge' }],
          job: otherJob,
        }
      if (command === Commands.GetMediaMergeJob) return otherJob
      return null
    })
    render(
      <PlatformServicesProvider services={electronServices}>
        <MediaMergeForm pluginId={pluginId} />
      </PlatformServicesProvider>
    )
    await screen.findByText('Another merge is already running.')
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled()
  })

  it('refreshes availability when the plugin is enabled without losing chosen inputs', async () => {
    useMediaMergeSessions
      .getState()
      .save(pluginId, { values: { ...inputs, pluginId } })
    const view = render(
      <PlatformServicesProvider services={electronServices}>
        <MediaMergeForm pluginId={pluginId} enabled={false} />
      </PlatformServicesProvider>
    )
    await screen.findByText('Enable this plugin to merge files.')
    view.rerender(
      <PlatformServicesProvider services={electronServices}>
        <MediaMergeForm pluginId={pluginId} enabled />
      </PlatformServicesProvider>
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Merge' })).toBeEnabled()
    )
    expect(
      screen.getByRole('button', { name: 'Browse Video file' })
    ).toHaveAttribute('title', inputs.videoInput)
  })
  it('keeps the job handle when navigation happens while starting the merge', async () => {
    useMediaMergeSessions
      .getState()
      .save(pluginId, { values: { ...inputs, pluginId } })
    let finish!: (value: typeof job) => void
    const pending = new Promise<typeof job>((resolve) => {
      finish = resolve
    })
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation((command, ...args) =>
      command === Commands.StartMediaMerge ? pending : base(command, ...args)
    )
    const view = render(
      <PlatformServicesProvider services={electronServices}>
        <MediaMergeForm pluginId={pluginId} />
      </PlatformServicesProvider>
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Merge' })).toBeEnabled()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(Commands.StartMediaMerge, {
        ...inputs,
        pluginId,
      })
    )
    view.unmount()
    await act(async () => {
      finish(job)
      await pending
    })
    expect(useMediaMergeSessions.getState().sessions[pluginId].job?.id).toBe(
      job.id
    )
  })
  it('changes only the output extension and submits the chosen format', async () => {
    useMediaMergeSessions.getState().save(pluginId, {
      values: {
        ...inputs,
        output: '/downloads/my.movie.final.MP4',
        pluginId,
      },
    })
    render(
      <PlatformServicesProvider services={electronServices}>
        <MediaMergeForm pluginId={pluginId} />
      </PlatformServicesProvider>
    )
    const mkv = screen.getByRole('button', { name: 'MKV' })
    await waitFor(() => expect(mkv).toBeEnabled())
    expect(screen.getByRole('button', { name: 'MP4' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    fireEvent.click(mkv)
    expect(mkv).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByRole('button', { name: 'Browse Output file' })
    ).toHaveAttribute('title', '/downloads/my.movie.final.mkv')
    fireEvent.click(mkv)
    expect(mkv).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))
    await screen.findByText('Merged successfully')
    expect(invoke).toHaveBeenCalledWith(Commands.StartMediaMerge, {
      ...inputs,
      output: '/downloads/my.movie.final.mkv',
      pluginId,
    })
    expect(mkv).toBeDisabled()
  })

  it('remembers a format chosen before files and uses it for dropped video and the save picker', async () => {
    const services = {
      ...electronServices,
      getPathForFile: vi.fn(() => '/downloads/clip.mp4'),
      pickFile: vi.fn(async () => null),
    }
    const view = render(
      <PlatformServicesProvider services={services}>
        <MediaMergeForm pluginId={pluginId} />
      </PlatformServicesProvider>
    )
    const mkv = screen.getByRole('button', { name: 'MKV' })
    await waitFor(() => expect(mkv).toBeEnabled())
    fireEvent.click(mkv)
    view.unmount()
    render(
      <PlatformServicesProvider services={services}>
        <MediaMergeForm pluginId={pluginId} />
      </PlatformServicesProvider>
    )
    const video = screen.getByRole('button', { name: 'Browse Video file' })
    await waitFor(() => expect(video).toBeEnabled())
    expect(screen.getByRole('button', { name: 'MKV' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    const file = new File(['video'], 'clip.mp4')
    fireEvent.drop(video, { dataTransfer: { files: [file] } })
    expect(services.getPathForFile).toHaveBeenCalledWith(file)
    expect(video).toHaveAttribute('title', '/downloads/clip.mp4')
    const output = screen.getByRole('button', { name: 'Browse Output file' })
    expect(output).toHaveAttribute('title', '/downloads/clip-merged.mkv')
    fireEvent.click(output)
    await waitFor(() =>
      expect(services.pickFile).toHaveBeenCalledWith({
        kind: 'save',
        defaultPath: '/downloads/clip-merged.mkv',
        extensions: ['mkv'],
      })
    )
    expect(invoke).not.toHaveBeenCalledWith(
      Commands.StartMediaMerge,
      expect.anything()
    )
  })

  it('restores the format from a saved output path and synchronizes with a newly selected filename', async () => {
    useMediaMergeSessions.getState().save(pluginId, {
      values: { ...inputs, output: '/downloads/old.mkv', pluginId },
    })
    const services = {
      ...electronServices,
      pickFile: vi.fn(async () => '/downloads/new.mp4'),
    }
    render(
      <PlatformServicesProvider services={services}>
        <MediaMergeForm pluginId={pluginId} />
      </PlatformServicesProvider>
    )
    const output = screen.getByRole('button', { name: 'Browse Output file' })
    await waitFor(() => expect(output).toBeEnabled())
    expect(screen.getByRole('button', { name: 'MKV' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    fireEvent.click(output)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'MP4' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    )
    expect(output).toHaveAttribute('title', '/downloads/new.mp4')
  })
})
