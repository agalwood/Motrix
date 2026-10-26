import { invalidateTaskList } from '@renderer/hooks/use-task-list'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { readTorrentFile } from '@renderer/lib/parse-torrent-file'
import type { PlatformServices } from '@renderer/platform/services'
import { PlatformServicesProvider } from '@renderer/platform/services'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { holdExitAnimation } from '@test-utils/hold-exit-animation'
import { AddTaskForm } from './add-task-form'

const { recordRecentMock, invokeMock } = vi.hoisted(() => ({
  recordRecentMock: vi.fn().mockResolvedValue(undefined),
  invokeMock: vi.fn().mockResolvedValue({ gid: 'test-gid' }),
}))
vi.mock('@renderer/hooks/use-task-list', () => ({
  invalidateTaskList: vi.fn(),
}))
vi.mock('@renderer/lib/directory-preferences', () => ({
  recordRecentDirectory: (...args: unknown[]) => recordRecentMock(...args),
}))
vi.mock('@renderer/components/desktop-kit/directory-history-menu', () => ({
  DirectoryHistoryMenu: ({
    onSelect,
  }: {
    onSelect: (path: string) => void
  }) => (
    <button type="button" onClick={() => onSelect('/later')}>
      History
    </button>
  ),
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: invokeMock,
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
  it('explains an unnamed header and allows removing it before submission', async () => {
    renderForm({
      defaultValues: {
        tab: 'links',
        urls: 'https://example.com/archive.zip',
        saveDir: '/new/downloads',
      },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add header' }))
    await userEvent.type(screen.getByLabelText('Header value'), 'fresh-value')
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(
      await screen.findByText('Enter a header name or remove this header.')
    ).toBeVisible()
    expect(screen.getByLabelText('Header name')).toHaveAccessibleDescription(
      'Enter a header name or remove this header.'
    )
    expect(
      invokeMock.mock.calls.filter(
        ([channel]) => channel === Commands.CreateTask
      )
    ).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Remove header' }))
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        Commands.CreateTask,
        expect.objectContaining({ headers: [] })
      )
    )
  })

  it('keeps migration guidance visible while editing and submits only newly entered request settings', async () => {
    renderForm({
      defaultValues: {
        tab: 'links',
        urls: 'https://example.com/archive.zip',
        saveDir: '/new/downloads',
        legacyRequestOptions: ['header', 'all-proxy'],
      },
    })
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(
      screen.getByText('Saved request settings: header, all-proxy')
    ).toBeVisible()
    expect(screen.getByLabelText('Cookie')).toHaveValue('')
    expect(
      invokeMock.mock.calls.filter(
        ([channel]) => channel === Commands.CreateTask
      )
    ).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Add header' }))
    await userEvent.type(screen.getByLabelText('Header name'), 'X-Download-Key')
    await userEvent.type(screen.getByLabelText('Header value'), 'fresh-value')
    await userEvent.type(screen.getByLabelText('Cookie'), 'session=fresh')
    await userEvent.type(
      screen.getByLabelText('Proxy'),
      'http://localhost:8080'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(
      screen.getByText('The old request settings were not copied.', {
        exact: false,
      })
    ).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        Commands.CreateTask,
        expect.objectContaining({
          headers: [
            { name: 'X-Download-Key', value: 'fresh-value' },
            { name: 'Cookie', value: 'session=fresh' },
          ],
          proxy: 'http://localhost:8080',
        })
      )
    )
    const request = invokeMock.mock.calls.find(
      ([channel]) => channel === Commands.CreateTask
    )?.[1]
    expect(request).not.toHaveProperty('legacyRequestOptions')
  })

  it('preserves an opaque legacy magnet source without offering ignored request fields', async () => {
    renderForm({
      defaultValues: {
        tab: 'links',
        urls: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
        saveDir: '/new/downloads',
        legacySourceTaskId: 'legacy-magnet',
        legacyRequestOptions: ['all-proxy'],
      },
    })
    expect(
      screen.getByText(
        'This download will use the old proxy settings from the migration backup.'
      )
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Advanced' })
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Proxy')).not.toBeInTheDocument()
    expect(
      screen.queryByText('The old request settings were not copied.', {
        exact: false,
      })
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        Commands.CreateTask,
        expect.objectContaining({
          type: 'bt',
          legacySourceTaskId: 'legacy-magnet',
        })
      )
    )
    const request = invokeMock.mock.calls.find(
      ([channel]) => channel === Commands.CreateTask
    )?.[1]
    expect(request).not.toHaveProperty('proxy')
    expect(request).not.toHaveProperty('legacyRequestOptions')
  })

  it('rejects a legacy magnet draft changed to HTTP with a localized error', async () => {
    renderForm({
      defaultValues: {
        tab: 'links',
        urls: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
        saveDir: '/new/downloads',
        legacySourceTaskId: 'legacy-magnet',
      },
    })
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'https://example.com/other.zip' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(
      await screen.findByText(
        'The old task data has changed. Check again before importing.'
      )
    ).toBeVisible()
    expect(mockServices.notify).toHaveBeenCalledWith(
      'error',
      'legacyImport.errors.changedSource'
    )
    expect(
      invokeMock.mock.calls.filter(
        ([channel]) => channel === Commands.CreateTask
      )
    ).toHaveLength(0)
  })

  it('localizes a legacy proxy mismatch rejected by task creation', async () => {
    invokeMock.mockImplementation(async (channel) => {
      if (channel === Commands.CreateTask)
        throw new Error('legacyImport.errors.requestSettingsMismatch')
      return {}
    })
    renderForm({
      defaultValues: {
        tab: 'links',
        urls: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
        saveDir: '/new/downloads',
        legacySourceTaskId: 'legacy-magnet',
      },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(
      await screen.findByText(
        'This task’s request settings differ from the existing task. Choose another download folder.'
      )
    ).toBeVisible()
    expect(mockServices.notify).toHaveBeenCalledWith(
      'error',
      'legacyImport.errors.requestSettingsMismatch'
    )
  })

  it('shows restored proxy guidance for a legacy torrent and retains transfer controls', async () => {
    renderForm({
      defaultValues: {
        tab: 'torrent',
        source: 'file',
        base64: 'dG9ycmVudA==',
        torrentMeta: {
          name: 'file.bin',
          infoHash: 'a'.repeat(40),
          totalSize: 1,
          files: [{ index: 0, path: 'file.bin', size: 1, extension: '.bin' }],
        },
        selectedFiles: [0],
        saveDir: '/new/downloads',
        legacySourceTaskId: 'legacy-bt',
      },
    })
    expect(
      screen.getByText(
        'This download will use the old proxy settings from the migration backup.'
      )
    ).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(screen.queryByLabelText('Proxy')).not.toBeInTheDocument()
    expect(screen.getAllByRole('spinbutton')).toHaveLength(3)
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        Commands.CreateTask,
        expect.objectContaining({ type: 'bt', legacySourceTaskId: 'legacy-bt' })
      )
    )
  })

  it('clears restored proxy guidance when an ordinary draft is hydrated', async () => {
    const { transport } = await import('@renderer/lib/transport')
    renderForm({
      subscribeEvents: true,
      defaultValues: {
        tab: 'links',
        urls: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
        saveDir: '/new/downloads',
        legacySourceTaskId: 'legacy-magnet',
      },
    })
    const setModeListener = vi
      .mocked(transport.on)
      .mock.calls.find(([channel]) => channel === Events.SetAddTaskMode)?.[1]
    await act(async () => {
      setModeListener?.({
        tab: 'links',
        urls: 'https://example.com/ordinary.zip',
      })
    })
    expect(
      screen.queryByText(
        'This download will use the old proxy settings from the migration backup.'
      )
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(screen.getByLabelText('Proxy')).toBeVisible()
  })

  it('hydrates a migration reminder without names and removes it for the next ordinary draft', async () => {
    const { transport } = await import('@renderer/lib/transport')
    renderForm({ subscribeEvents: true })
    const setModeListener = vi
      .mocked(transport.on)
      .mock.calls.find(([channel]) => channel === Events.SetAddTaskMode)?.[1]
    await act(async () => {
      setModeListener?.({
        tab: 'links',
        urls: 'https://example.com/archive.zip',
        saveDir: '/new/downloads',
        legacyRequestOptions: [],
      })
    })
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(
      screen.getByText('The old request settings were not copied.', {
        exact: false,
      })
    ).toBeVisible()
    await act(async () => {
      setModeListener?.({
        tab: 'links',
        urls: 'https://example.com/ordinary.zip',
      })
    })
    expect(
      screen.queryByText('The old request settings were not copied.', {
        exact: false,
      })
    ).not.toBeInTheDocument()
  })

  it('submits only valid lines and retains rejected input', async () => {
    const onSubmitSuccess = vi.fn()
    renderForm({
      onSubmitSuccess,
      defaultValues: {
        tab: 'links',
        urls: 'https://a/file\nsftp://a/file',
        saveDir: '/d',
      },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() =>
      expect(screen.getByRole('textbox')).toHaveValue('sftp://a/file')
    )
    expect(
      invokeMock.mock.calls.filter(
        ([channel]) => channel === 'command:createTask'
      )
    ).toHaveLength(1)
    expect(onSubmitSuccess).not.toHaveBeenCalled()
  })

  it('retries only unfinished rows with the same request ID after a lost response', async () => {
    let retry = false
    invokeMock.mockImplementation(async (channel, request) => {
      if (channel !== 'command:createTask') return {}
      if (request.uris[0] === 'https://a/second' && !retry)
        throw new TypeError('Failed to fetch')
      return {
        outcome: retry ? 'reused' : 'created',
        taskId: 'task',
        gid: 'gid',
      }
    })
    renderForm({
      defaultValues: {
        tab: 'links',
        urls: 'https://a/first\nhttps://a/second',
        saveDir: '/d',
      },
    })
    await userEvent.click(screen.getByRole('button', { name: /download/i }))
    await waitFor(() =>
      expect(screen.getByRole('textbox')).toHaveValue('https://a/second')
    )
    retry = true
    await userEvent.click(screen.getByRole('button', { name: /download/i }))
    const submitted = invokeMock.mock.calls
      .filter(([channel]) => channel === 'command:createTask')
      .map(([, request]) => request)
    expect(submitted).toHaveLength(3)
    expect(submitted[0].requestId).not.toBe(submitted[1].requestId)
    expect(submitted[1].requestId).toBe(submitted[2].requestId)
    expect(submitted[2].uris).toEqual(['https://a/second'])
  })
  it('autofills bare hashes from the clipboard as magnet links', async () => {
    const hash = 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc'
    vi.mocked(mockServices.readClipboard).mockResolvedValueOnce(
      `${hash}\nhttps://a/b`
    )
    renderForm()
    await waitFor(() =>
      expect(screen.getByRole('textbox')).toHaveValue(
        `magnet:?xt=urn:btih:${hash}\nhttps://a/b`
      )
    )
  })

  it('submits a typed hash as a BT task even without a blur or paste event', async () => {
    const user = userEvent.setup()
    const hash = 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc'
    const onSubmitSuccess = vi.fn()
    renderForm({ onSubmitSuccess })
    const textbox = screen.getByRole('textbox')
    await user.type(textbox, hash)
    fireEvent.click(screen.getByRole('button', { name: /download/i }))
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.map(([, payload]) => payload)
      ).toContainEqual(
        expect.objectContaining({
          type: 'bt',
          payload: { kind: 'magnet', uri: `magnet:?xt=urn:btih:${hash}` },
        })
      )
    )
    expect(onSubmitSuccess).toHaveBeenCalledWith('test-gid')
  })

  afterEach(() => {
    vi.clearAllMocks()
    localStorage.removeItem('motrix.pending-create-inputs.v1')
    invokeMock.mockResolvedValue({ gid: 'test-gid' })
  })

  it('recovers the request ID after closing and reopening an unconfirmed submission', async () => {
    let retry = false
    invokeMock.mockImplementation(async (channel) => {
      if (channel !== 'command:createTask') return {}
      if (!retry) throw new TypeError('Failed to fetch')
      return { outcome: 'reused', taskId: 'task', gid: 'gid' }
    })
    const props = {
      defaultValues: {
        tab: 'links',
        urls: 'https://a/uncertain',
        saveDir: '/d',
      },
    }
    const first = renderForm(props)
    await userEvent.click(screen.getByRole('button', { name: /download/i }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The result is unconfirmed'
      )
    )
    const requestId = invokeMock.mock.calls.find(
      ([channel]) => channel === 'command:createTask'
    )?.[1].requestId
    first.unmount()
    retry = true
    renderForm(props)
    await userEvent.click(screen.getByRole('button', { name: /download/i }))
    const submissions = invokeMock.mock.calls.filter(
      ([channel]) => channel === 'command:createTask'
    )
    expect(submissions).toHaveLength(2)
    expect(submissions[1][1].requestId).toBe(requestId)
    expect(localStorage.getItem('motrix.pending-create-inputs.v1')).toBeNull()
  })

  it('renders links tab by default', () => {
    renderForm()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('measures natural content separately from the scroll viewport', () => {
    const { container } = renderForm()
    const content = container.querySelector('[data-adaptive-content]')

    expect(content).toBeInTheDocument()
    expect(content).not.toHaveClass('overflow-y-auto')
    expect(content?.parentElement).toHaveAttribute(
      'data-slot',
      'scroll-area-viewport'
    )
    expect(content?.parentElement).toHaveAttribute('tabindex', '-1')
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

  it.each(['', '  \n  '])(
    'keeps blank input idle on blur, shortcut submission and clearing (%j)',
    async (blank) => {
      const user = userEvent.setup()
      renderForm()
      const textbox = screen.getByRole('textbox', { name: 'URLs' })
      expect(screen.queryByText('URLs')).not.toBeInTheDocument()
      await user.click(textbox)
      fireEvent.change(textbox, { target: { value: blank } })
      await user.tab()
      fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
      fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
      await waitFor(() => {
        expect(textbox).toHaveAttribute('aria-invalid', 'false')
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      })

      await user.type(textbox, 'htps://example.com')
      await user.tab()
      expect(textbox).toHaveAttribute('aria-invalid', 'true')
      await user.clear(textbox)
      await user.tab()
      await waitFor(() => {
        expect(textbox).toHaveAttribute('aria-invalid', 'false')
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      })
      expect(screen.getByRole('status')).toBeEmptyDOMElement()
      expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled()
      expect(
        invokeMock.mock.calls.filter(
          ([channel]) => channel === 'command:createTask'
        )
      ).toHaveLength(0)
    }
  )

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
    expect(recordRecentMock).not.toHaveBeenCalled()
  })

  it.each([
    'https://a/file.zip',
    'magnet:?xt=urn:btih:a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc',
  ])(
    'closes after host acceptance without another directory request for %s',
    async (url) => {
      const onSubmitSuccess = vi.fn()
      renderForm({
        onSubmitSuccess,
        defaultValues: { tab: 'links', urls: url, saveDir: '/d' },
      })

      await userEvent.click(screen.getByRole('button', { name: 'Download' }))
      await waitFor(() =>
        expect(onSubmitSuccess).toHaveBeenCalledWith('test-gid')
      )
      expect(recordRecentMock).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['electron', 'created'],
    ['electron', 'reused'],
    ['electron', 'rechecked'],
    ['web', 'created'],
    ['web', 'reused'],
    ['web', 'rechecked'],
  ] as const)(
    'submits the %s %s directory snapshot and leaves history to the host',
    async (kind, outcome) => {
      let accept!: (value: unknown) => void
      const { transport } = await import('@renderer/lib/transport')
      vi.mocked(transport.invoke).mockImplementation(async (channel) => {
        if (channel === 'query:getSettings') return { app: {} }
        if (channel === 'command:createTask')
          return new Promise((resolve) => {
            accept = resolve
          })
        return {}
      })
      const success = vi.fn()
      renderForm(
        {
          onSubmitSuccess: success,
          defaultValues: {
            tab: 'links',
            urls: 'https://a/1',
            saveDir: '/submitted ',
          },
        },
        { ...mockServices, kind }
      )
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Download' }))
      await waitFor(() => expect(accept).toBeDefined())
      await user.click(screen.getByRole('button', { name: 'History' }))
      expect(recordRecentMock).not.toHaveBeenCalled()
      await act(async () =>
        accept({ outcome, gid: 'accepted', taskId: 'accepted' })
      )
      expect(success).toHaveBeenCalledWith('accepted')
      expect(transport.invoke).toHaveBeenCalledWith(
        'command:createTask',
        expect.objectContaining({ saveDir: '/submitted ' })
      )
      expect(recordRecentMock).not.toHaveBeenCalled()
    }
  )

  it.each(['electron', 'web'] as const)(
    'records %s picker confirmation but not history-only selection or parent cancellation',
    async (kind) => {
      const { transport } = await import('@renderer/lib/transport')
      vi.mocked(transport.invoke).mockResolvedValue({ app: {} })
      const onCancel = vi.fn()
      const pick = vi.fn().mockResolvedValue('/selected ')
      renderForm({ onCancel }, { ...mockServices, kind, pickSaveDir: pick })
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'History' }))
      expect(recordRecentMock).not.toHaveBeenCalled()
      await user.click(screen.getByRole('button', { name: 'Change directory' }))
      expect(pick).toHaveBeenCalledWith('/later')
      expect(recordRecentMock.mock.calls).toEqual([['/selected ']])
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(onCancel).toHaveBeenCalledOnce()
      expect(recordRecentMock.mock.calls).toEqual([['/selected ']])
    }
  )

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
    expect(recordRecentMock).not.toHaveBeenCalled()
  })

  it.each(['created', 'conflict', 'failure'] as const)(
    'leaves local batch history to the host when its second item is %s',
    async (secondOutcome) => {
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
      vi.mocked(transport.invoke).mockImplementation(
        async (channel, request) => {
          if (channel === 'query:getSettings') {
            return { app: { defaultSaveDir: '/d' } }
          }
          if (channel === 'command:createTask') {
            const base64 = (request as { payload?: { base64?: string } })
              .payload?.base64
            if (base64 === 'YmV0YQ==' && secondOutcome === 'failure')
              throw new Error('test rejection')
            if (base64 === 'YmV0YQ==' && secondOutcome === 'conflict')
              return { outcome: 'conflict' }
            return {
              outcome: 'created',
              gid: base64 === 'YWxwaGE=' ? 'alpha-gid' : 'beta-gid',
              taskId: base64 === 'YWxwaGE=' ? 'alpha-task' : 'beta-task',
            }
          }
          return {}
        }
      )
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
      expect(recordRecentMock).not.toHaveBeenCalled()
    }
  )

  it.each([2, 1, 0])(
    'closes App batch only if at least one torrent is accepted (%s)',
    async (succeeded) => {
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
            succeeded,
            failed: 2 - succeeded,
            firstTaskId: succeeded > 0 ? 'first-task' : null,
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
      if (succeeded > 0) {
        expect(onSubmitSuccess).toHaveBeenCalledWith('first-task')
        expect(recordRecentMock).not.toHaveBeenCalled()
      } else {
        expect(onSubmitSuccess).not.toHaveBeenCalled()
        expect(recordRecentMock).not.toHaveBeenCalled()
      }
    }
  )

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
    expect(onSubmitSuccess).not.toHaveBeenCalled()
    expect(invalidateTaskList).toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toHaveValue('https://bad/2')
    expect(recordRecentMock).not.toHaveBeenCalled()
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
    expect(recordRecentMock).not.toHaveBeenCalled()
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

  it('keeps a closing draft visible without accepting click or global shortcut submissions', async () => {
    const { transport } = await import('@renderer/lib/transport')
    renderForm({
      active: false,
      defaultValues: {
        tab: 'links',
        urls: 'https://example.test/closing.zip',
        saveDir: '/d',
      },
    })
    expect(screen.getByRole('textbox')).toHaveValue(
      'https://example.test/closing.zip'
    )
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
    await userEvent.click(screen.getByRole('button', { name: /download/i }))
    expect(transport.invoke).not.toHaveBeenCalledWith(
      'command:createTask',
      expect.anything()
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
    expect(recordRecentMock).not.toHaveBeenCalled()
    const conflictDialog = screen.getByRole('alertdialog')
    const conflictContent = conflictDialog.textContent
    const finishExit = holdExitAnimation(conflictDialog)
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
    expect(recordRecentMock).not.toHaveBeenCalled()
    expect(conflictDialog.textContent).toBe(conflictContent)
    await finishExit()
  })
})
