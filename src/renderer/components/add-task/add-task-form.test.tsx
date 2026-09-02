import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { readTorrentFile } from '@renderer/lib/parse-torrent-file'
import type { PlatformServices } from '@renderer/platform/services'
import { PlatformServicesProvider } from '@renderer/platform/services'
import { Events } from '@shared/protocol/events'
import { AddTaskForm } from './add-task-form'

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn().mockResolvedValue({ gid: 'test-gid' }),
    on: vi.fn(),
    off: vi.fn(),
  },
}))

vi.mock('@renderer/lib/parse-torrent-file', () => ({
  readTorrentFile: vi.fn(),
}))

const mockServices: PlatformServices = {
  kind: 'electron',
  pickSaveDir: vi.fn().mockResolvedValue('/picked'),
  closeHost: vi.fn(),
  readClipboard: vi.fn().mockResolvedValue(''),
  openExternal: vi.fn(),
  notify: vi.fn(),
}

function renderForm(props = {}, services: PlatformServices = mockServices) {
  return render(
    <PlatformServicesProvider services={services}>
      <AddTaskForm
        onCancel={vi.fn()}
        onSubmitSuccess={vi.fn()}
        defaultValues={{ tab: 'links', urls: '', saveDir: '/d' }}
        subscribeEvents={false}
        {...props}
      />
    </PlatformServicesProvider>
  )
}

describe('AddTaskForm', () => {
  afterEach(() => vi.clearAllMocks())

  it('renders links tab by default', () => {
    renderForm()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('measures natural content separately from the scroll viewport', () => {
    const { container } = renderForm()
    const content = container.querySelector('[data-adaptive-content]')

    expect(content).toBeInTheDocument()
    expect(content).not.toHaveClass('overflow-y-auto')
    expect(content?.parentElement).toHaveClass('overflow-y-auto')
  })

  it('keeps the footer inside an in-page dialog', () => {
    const { container } = renderForm({ presentation: 'dialog' })
    const body = container.querySelector('[data-slot="add-task-form-body"]')
    const footer = container.querySelector('[data-slot="add-task-form-footer"]')

    expect(body).toHaveClass('min-h-0', 'flex-auto')
    expect(footer).not.toHaveClass('fixed', 'bottom-0', 'left-0')
  })

  it('keeps the footer fixed in the standalone Electron window', () => {
    const { container } = renderForm()
    const footer = container.querySelector('[data-slot="add-task-form-footer"]')

    expect(footer).toHaveClass('fixed', 'bottom-0', 'left-0')
  })

  it('disables submit when urls are empty', () => {
    renderForm()
    const submit = screen.getByRole('button', { name: /download/i })
    expect(submit).toBeDisabled()
  })

  it('disables submit when saveDir is empty even if urls are filled', async () => {
    const user = userEvent.setup()
    renderForm({ defaultValues: { tab: 'links', urls: '', saveDir: '' } })

    await user.type(screen.getByRole('textbox'), 'https://a/b')
    const submit = screen.getByRole('button', { name: /download/i })
    expect(submit).toBeDisabled()
  })

  it('cancel button calls onCancel', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    renderForm({ onCancel })
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('prefills empty urls from the clipboard when autofill is enabled', async () => {
    vi.mocked(mockServices.readClipboard).mockResolvedValue(
      'https://example.com/f.zip'
    )
    renderForm()
    await waitFor(() =>
      expect(screen.getByRole('textbox')).toHaveValue(
        'https://example.com/f.zip'
      )
    )
  })

  it('only reads the clipboard after a precreated window is shown', async () => {
    vi.mocked(mockServices.readClipboard).mockResolvedValue(
      'https://example.com/after-show.zip'
    )
    renderForm({ subscribeEvents: true })
    expect(mockServices.readClipboard).not.toHaveBeenCalled()

    const { transport } = await import('@renderer/lib/transport')
    const setModeListener = vi
      .mocked(transport.on)
      .mock.calls.find(([channel]) => channel === Events.SetAddTaskMode)?.[1]
    expect(setModeListener).toBeTypeOf('function')

    act(() => {
      setModeListener?.({ mode: 'links' })
    })

    await waitFor(() =>
      expect(screen.getByRole('textbox')).toHaveValue(
        'https://example.com/after-show.zip'
      )
    )
    expect(mockServices.readClipboard).toHaveBeenCalledOnce()
  })

  it('refreshes the default save directory when a precreated window is shown', async () => {
    const { transport } = await import('@renderer/lib/transport')
    vi.mocked(transport.invoke).mockImplementation(async (channel: string) => {
      if (channel === 'query:getSettings') {
        return {
          app: {
            autofillClipboardLinks: false,
            defaultSaveDir: '/downloads/new',
          },
        }
      }
      return { gid: 'test-gid' }
    })
    renderForm({
      subscribeEvents: true,
      defaultValues: {
        tab: 'links',
        urls: '',
        saveDir: '/downloads/old',
      },
    })
    expect(screen.getAllByTitle('/downloads/old').length).toBeGreaterThan(0)

    const setModeListener = vi
      .mocked(transport.on)
      .mock.calls.find(([channel]) => channel === Events.SetAddTaskMode)?.[1]
    act(() => {
      setModeListener?.({ mode: 'links' })
    })

    await waitFor(() =>
      expect(screen.getAllByTitle('/downloads/new').length).toBeGreaterThan(0)
    )
    expect(screen.queryAllByTitle('/downloads/old')).toHaveLength(0)
  })

  it('preserves a dirty per-task save directory when the mode is refreshed', async () => {
    const user = userEvent.setup()
    const { transport } = await import('@renderer/lib/transport')
    vi.mocked(transport.invoke).mockImplementation(async (channel: string) => {
      if (channel === 'query:getSettings') {
        return {
          app: {
            autofillClipboardLinks: false,
            defaultSaveDir: '/downloads/default',
          },
        }
      }
      return { gid: 'test-gid' }
    })
    vi.mocked(mockServices.pickSaveDir).mockResolvedValueOnce(
      '/downloads/per-task'
    )
    renderForm({ subscribeEvents: true })

    await user.click(screen.getByRole('button', { name: /change directory/i }))
    await waitFor(() =>
      expect(
        screen.getAllByTitle('/downloads/per-task').length
      ).toBeGreaterThan(0)
    )

    const setModeListener = vi
      .mocked(transport.on)
      .mock.calls.find(([channel]) => channel === Events.SetAddTaskMode)?.[1]
    await act(async () => {
      setModeListener?.({ mode: 'links' })
      await Promise.resolve()
    })

    expect(transport.invoke).toHaveBeenCalledTimes(2)
    expect(screen.getAllByTitle('/downloads/per-task').length).toBeGreaterThan(
      0
    )
    expect(screen.queryAllByTitle('/downloads/default')).toHaveLength(0)
  })

  it('does not prefill when the setting is turned off', async () => {
    const { transport } = await import('@renderer/lib/transport')
    vi.mocked(transport.invoke).mockImplementation(async (channel: string) => {
      if (channel === 'query:getSettings') {
        return { app: { autofillClipboardLinks: false } }
      }
      return { gid: 'test-gid' }
    })
    vi.mocked(mockServices.readClipboard).mockResolvedValue(
      'https://example.com/f.zip'
    )
    renderForm()
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith('query:getSettings')
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(mockServices.readClipboard).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('does not overwrite urls that are already filled', async () => {
    const { transport } = await import('@renderer/lib/transport')
    vi.mocked(transport.invoke).mockImplementation(async (channel: string) =>
      channel === 'query:getSettings'
        ? { app: { autofillClipboardLinks: true } }
        : { gid: 'test-gid' }
    )
    vi.mocked(mockServices.readClipboard).mockResolvedValue('https://clip/x')
    renderForm({
      defaultValues: { tab: 'links', urls: 'https://kept/1', saveDir: '/d' },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(screen.getByRole('textbox')).toHaveValue('https://kept/1')
  })

  it('ignores clipboard content that is not a downloadable link', async () => {
    const { transport } = await import('@renderer/lib/transport')
    vi.mocked(transport.invoke).mockImplementation(async (channel: string) =>
      channel === 'query:getSettings'
        ? { app: { autofillClipboardLinks: true } }
        : { gid: 'test-gid' }
    )
    vi.mocked(mockServices.readClipboard).mockResolvedValue(
      'hello world\nnot a url'
    )
    renderForm()
    await waitFor(() => expect(mockServices.readClipboard).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('stays quiet when the clipboard cannot be read', async () => {
    const { transport } = await import('@renderer/lib/transport')
    vi.mocked(transport.invoke).mockImplementation(async (channel: string) =>
      channel === 'query:getSettings'
        ? { app: { autofillClipboardLinks: true } }
        : { gid: 'test-gid' }
    )
    vi.mocked(mockServices.readClipboard).mockRejectedValue(new Error('denied'))
    renderForm()
    await waitFor(() => expect(mockServices.readClipboard).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('submit flow calls transport and onSubmitSuccess', async () => {
    const onSubmitSuccess = vi.fn()
    const user = userEvent.setup()
    const { transport } = await import('@renderer/lib/transport')
    renderForm({ onSubmitSuccess })

    await user.type(screen.getByRole('textbox'), 'https://a/b')
    await user.click(screen.getByRole('button', { name: /download/i }))

    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        'command:createTask',
        expect.objectContaining({ type: 'http', uris: ['https://a/b'] })
      )
    )
    expect(onSubmitSuccess).toHaveBeenCalledWith('test-gid')
  })

  it('submits one createTask per link line', async () => {
    const onSubmitSuccess = vi.fn()
    const user = userEvent.setup()
    const { transport } = await import('@renderer/lib/transport')
    renderForm({ onSubmitSuccess })

    await user.type(
      screen.getByRole('textbox'),
      'https://a/1{Enter}https://b/2'
    )
    await user.click(screen.getByRole('button', { name: /download/i }))

    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        'command:createTask',
        expect.objectContaining({ type: 'http', uris: ['https://b/2'] })
      )
    )
    expect(transport.invoke).toHaveBeenCalledWith(
      'command:createTask',
      expect.objectContaining({ type: 'http', uris: ['https://a/1'] })
    )
    expect(onSubmitSuccess).toHaveBeenCalledWith('test-gid')
    expect(mockServices.notify).toHaveBeenCalledWith('info', 'task.add.created')
  })

  it('parses and creates a local multi-torrent batch without shell RPCs', async () => {
    const onSubmitSuccess = vi.fn()
    const user = userEvent.setup()
    const { transport } = await import('@renderer/lib/transport')
    vi.mocked(readTorrentFile).mockImplementation(async (file) => {
      const isAlpha = file.name.startsWith('alpha')
      return {
        name: file.name,
        base64: isAlpha ? 'YWxwaGE=' : 'YmV0YQ==',
        meta: {
          name: isAlpha ? 'alpha.bin' : 'beta.bin',
          infoHash: isAlpha ? 'a'.repeat(40) : 'b'.repeat(40),
          totalSize: 1,
          comment: '',
          isPrivate: false,
          files: [
            {
              index: 0,
              path: isAlpha ? 'alpha.bin' : 'beta.bin',
              size: 1,
              extension: 'bin',
            },
          ],
        },
      }
    })
    vi.mocked(transport.invoke).mockImplementation(async (channel, request) => {
      if (channel === 'query:getSettings') {
        return { app: { defaultSaveDir: '/d' } }
      }
      if (channel === 'command:createTask') {
        const base64 = (request as { payload?: { base64?: string } }).payload
          ?.base64
        return {
          outcome: 'created',
          gid: base64 === 'YWxwaGE=' ? 'alpha-gid' : 'beta-gid',
          taskId: base64 === 'YWxwaGE=' ? 'alpha-task' : 'beta-task',
        }
      }
      return {}
    })
    const webServices = { ...mockServices, kind: 'web' as const }
    const { container } = renderForm(
      {
        onSubmitSuccess,
        defaultValues: { tab: 'torrent', saveDir: '/d' },
      },
      webServices
    )
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).toHaveAttribute('multiple')

    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [
          new File(['alpha'], 'alpha.torrent'),
          new File(['beta'], 'beta.torrent'),
        ],
      },
    })

    expect(await screen.findByText('Torrent 1 of 2')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Download All (2)' }))

    await waitFor(() =>
      expect(onSubmitSuccess).toHaveBeenCalledWith('alpha-task')
    )
    expect(transport.invoke).toHaveBeenCalledWith(
      'command:createTask',
      expect.objectContaining({
        payload: { kind: 'torrent-base64', base64: 'YWxwaGE=' },
      })
    )
    expect(transport.invoke).toHaveBeenCalledWith(
      'command:createTask',
      expect.objectContaining({
        payload: { kind: 'torrent-base64', base64: 'YmV0YQ==' },
      })
    )
    expect(transport.invoke).not.toHaveBeenCalledWith(
      'command:downloadAllTorrents'
    )
  })

  it('passes the current torrent form options to the App batch command', async () => {
    const onSubmitSuccess = vi.fn()
    const user = userEvent.setup()
    const { transport } = await import('@renderer/lib/transport')
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === 'query:getSettings') {
        return { app: { defaultSaveDir: '/default' } }
      }
      if (channel === 'command:downloadAllTorrents') {
        return {
          total: 2,
          succeeded: 2,
          failed: 0,
          firstTaskId: 'first-task',
        }
      }
      return {}
    })
    renderForm({
      subscribeEvents: true,
      onSubmitSuccess,
      defaultValues: {
        tab: 'torrent',
        source: 'file',
        base64: 'dG9ycmVudA==',
        torrentMeta: {
          name: 'current.bin',
          infoHash: 'a'.repeat(40),
          totalSize: 2,
          files: [
            { index: 0, path: 'skip.bin', size: 1, extension: '.bin' },
            { index: 1, path: 'keep.bin', size: 1, extension: '.bin' },
          ],
        },
        selectedFiles: [1],
        saveDir: '/custom',
        dlLimit: 2048,
        ulLimit: 1024,
        seedRatio: 1.5,
      },
    })

    const queueListener = vi
      .mocked(transport.on)
      .mock.calls.find(
        ([channel]) => channel === Events.TorrentQueueSizeChanged
      )?.[1]
    act(() => queueListener?.({ queueTotal: 2 }))
    await user.click(
      await screen.findByRole('button', { name: 'Download All (2)' })
    )

    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        'command:downloadAllTorrents',
        {
          selectedFiles: [1],
          saveDir: '/custom',
          dlLimit: 2048,
          ulLimit: 1024,
          seedRatio: 1.5,
        }
      )
    )
    expect(onSubmitSuccess).toHaveBeenCalledWith('first-task')
  })

  it('closes an external queue when the shell reports no valid next torrent', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    const { transport } = await import('@renderer/lib/transport')
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === 'query:getSettings') {
        return { app: { defaultSaveDir: '/default' } }
      }
      if (channel === 'command:nextTorrent') return { advanced: false }
      return {}
    })
    renderForm({
      subscribeEvents: true,
      onCancel,
      defaultValues: {
        tab: 'torrent',
        source: 'file',
        base64: 'dG9ycmVudA==',
        torrentMeta: {
          name: 'current.bin',
          infoHash: 'a'.repeat(40),
          totalSize: 1,
          files: [
            { index: 0, path: 'current.bin', size: 1, extension: '.bin' },
          ],
        },
        selectedFiles: [0],
        saveDir: '/custom',
      },
    })

    const queueListener = vi
      .mocked(transport.on)
      .mock.calls.find(
        ([channel]) => channel === Events.TorrentQueueSizeChanged
      )?.[1]
    act(() => queueListener?.({ queueTotal: 2 }))
    await user.click(await screen.findByRole('button', { name: 'Skip' }))

    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce())
    expect(screen.queryByText('Torrent 1 of 2')).not.toBeInTheDocument()
  })

  it('reports a partial failure when some lines fail', async () => {
    const onSubmitSuccess = vi.fn()
    const user = userEvent.setup()
    const { transport } = await import('@renderer/lib/transport')
    vi.mocked(transport.invoke).mockImplementation(
      async (channel: string, payload?: unknown) => {
        if (channel !== 'command:createTask') return {}
        const req = payload as { uris?: string[] }
        if (req.uris?.[0] === 'https://bad/2') throw new Error('boom')
        return { gid: 'ok-gid' }
      }
    )
    renderForm({ onSubmitSuccess })

    await user.type(
      screen.getByRole('textbox'),
      'https://a/1{Enter}https://bad/2'
    )
    await user.click(screen.getByRole('button', { name: /download/i }))

    await waitFor(() =>
      expect(mockServices.notify).toHaveBeenCalledWith(
        'warn',
        'task.add.createdPartial',
        { ok: 1, failed: 1 }
      )
    )
    expect(onSubmitSuccess).toHaveBeenCalledWith('ok-gid')
  })

  it('surfaces the create failure reason without Electron IPC prefixes', async () => {
    const onSubmitSuccess = vi.fn()
    const user = userEvent.setup()
    const { transport } = await import('@renderer/lib/transport')
    const reason =
      'ffmpeg is required to download this video: its video and audio are separate streams that must be muxed. Install ffmpeg (or set MOTRIX_FFMPEG_BIN) and restart Motrix.'
    vi.mocked(transport.invoke).mockImplementation(async (channel: string) => {
      if (channel === 'query:getSettings') return { app: {} }
      throw new Error(
        `Error invoking remote method 'command:createTask': AppError: ${reason}`
      )
    })
    renderForm({ onSubmitSuccess })

    await user.type(screen.getByRole('textbox'), 'https://a/video')
    const submit = screen.getByRole('button', { name: /download/i })
    await user.click(submit)

    await waitFor(() =>
      expect(mockServices.notify).toHaveBeenCalledWith(
        'error',
        'task.add.createFailedWithReason',
        { reason }
      )
    )
    expect(onSubmitSuccess).not.toHaveBeenCalled()
    await waitFor(() => expect(submit).toBeEnabled())
  })

  it('leaves connections unset so new downloads use the app setting', async () => {
    const user = userEvent.setup()
    const { transport } = await import('@renderer/lib/transport')
    vi.mocked(transport.invoke).mockImplementation(async (channel: string) => {
      if (channel === 'query:getSettings') {
        return {
          app: { defaultSaveDir: '/d', autofillClipboardLinks: true },
          engine: { split: 32 },
        }
      }
      return { outcome: 'created', gid: 'profile-gid', taskId: 'profile-task' }
    })
    renderForm()

    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith('query:getSettings')
    )
    await user.type(screen.getByRole('textbox'), 'https://a/profile.zip')
    await user.click(screen.getByRole('button', { name: /download/i }))

    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        'command:createTask',
        expect.not.objectContaining({ connections: expect.any(Number) })
      )
    )
  })

  it('requires confirmation before creating a renamed torrent copy', async () => {
    const onSubmitSuccess = vi.fn()
    const user = userEvent.setup()
    const { transport } = await import('@renderer/lib/transport')
    let createCalls = 0
    vi.mocked(transport.invoke).mockImplementation(async (channel: string) => {
      if (channel === 'query:getSettings') return { app: {} }
      createCalls += 1
      if (createCalls === 1) {
        return {
          outcome: 'conflict',
          conflict: {
            reason: 'selection-mismatch',
            infoHash: 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc',
            targetDir: '/d',
            existingTaskId: 'existing-task',
            existingTaskName: 'sample-data',
            existingTaskStatus: 'completed',
            canCreateCopy: true,
          },
        }
      }
      return {
        outcome: 'created',
        gid: 'copy-gid',
        taskId: 'copy-task',
      }
    })
    renderForm({ onSubmitSuccess })

    await user.type(
      screen.getByRole('textbox'),
      'magnet:?xt=urn:btih:a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc'
    )
    await user.click(screen.getByRole('button', { name: /download/i }))

    expect(
      await screen.findByRole('heading', {
        name: 'This torrent already exists',
      })
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole('button', { name: 'Create separate copy' })
    )

    await waitFor(() =>
      expect(transport.invoke).toHaveBeenLastCalledWith(
        'command:createTask',
        expect.objectContaining({ duplicatePolicy: 'create-copy' })
      )
    )
    expect(onSubmitSuccess).toHaveBeenCalledWith('copy-task')
  })
})
