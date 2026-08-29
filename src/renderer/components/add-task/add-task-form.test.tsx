import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
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

const mockServices: PlatformServices = {
  kind: 'electron',
  pickSaveDir: vi.fn().mockResolvedValue('/picked'),
  closeHost: vi.fn(),
  readClipboard: vi.fn().mockResolvedValue(''),
  openExternal: vi.fn(),
  notify: vi.fn(),
}

function renderForm(props = {}) {
  return render(
    <PlatformServicesProvider services={mockServices}>
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
