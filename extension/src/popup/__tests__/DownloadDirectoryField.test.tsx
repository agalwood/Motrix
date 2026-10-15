import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/background/MessageBus', () => ({ send: vi.fn() }))

import { send } from '@/background/MessageBus'
import { DownloadDirectoryConnectionProvider } from '@/popup/DownloadDirectoryConnection'
import { DownloadDirectoryField } from '@/popup/DownloadDirectoryField'
import type { PopupState } from '@/popup/usePopupState'
import { i18n } from '@/shared/i18n'
import { DOWNLOAD_ERROR } from '@/shared/integration'
import { defaultTaskOptions, type TaskOptions } from '@/shared/taskOptions'

let user: ReturnType<typeof userEvent.setup>

const binding = {
  endpointId: 'local',
  endpointRevision: 0,
  instanceId: 'instance-a',
}
const result = {
  status: 'ready' as const,
  binding,
  directories: {
    defaultSaveDir: '/downloads',
    favorites: ['/movies'],
    recent: ['/movies', '/recent'],
  },
}
const connectedState: PopupState = {
  loading: false,
  connection: 'connected',
  pairing: 'stored',
  phase: 'ready',
  attemptIntent: null,
  lastError: null,
  lastErrorReason: null,
  endpoint: {
    version: 3,
    activeEndpointId: 'local',
    servers: [],
    cleanupTombstones: [],
  },
  server: {
    name: 'Motrix',
    version: '2',
    runtime: 'electron',
    instanceId: binding.instanceId,
  },
  backoff: null,
  recoveryExhaustedUnattended: false,
  degraded: false,
  capabilities: { taskReveal: true, downloadDirectories: true },
  pairingCode: null,
}
function Form({
  initial = defaultTaskOptions(''),
  onChange = vi.fn(),
}: {
  initial?: TaskOptions
  onChange?: (value: TaskOptions) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <DownloadDirectoryField
      value={value}
      disabled={false}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}
beforeEach(async () => {
  user = userEvent.setup()
  vi.mocked(send).mockReset()
  await i18n.changeLanguage('en-US')
})
describe('download directory picker', () => {
  it('loads directories when the existing popup poll observes a connection and ignores unchanged polls', async () => {
    vi.mocked(send)
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockResolvedValueOnce(result)
    const form = <Form />
    const view = render(
      <DownloadDirectoryConnectionProvider
        state={{ ...connectedState, connection: 'disconnected', server: null }}
      >
        {form}
      </DownloadDirectoryConnectionProvider>
    )
    await screen.findByText(i18n.t('popup.taskForm.directoryOffline'))
    view.rerender(
      <DownloadDirectoryConnectionProvider state={connectedState}>
        {form}
      </DownloadDirectoryConnectionProvider>
    )
    await screen.findByText(i18n.t('popup.taskForm.directoryHint'))
    view.rerender(
      <DownloadDirectoryConnectionProvider state={{ ...connectedState }}>
        {form}
      </DownloadDirectoryConnectionProvider>
    )
    expect(send).toHaveBeenCalledTimes(2)
    await user.click(screen.getByRole('combobox'))
    expect(await screen.findByRole('option', { name: '/movies' })).toBeTruthy()
  })
  it('discards an in-flight directory response after the authenticated instance changes and preserves the draft', async () => {
    let finish!: (value: typeof result) => void
    const pending = new Promise<typeof result>((resolve) => {
      finish = resolve
    })
    vi.mocked(send)
      .mockImplementationOnce(() => pending)
      .mockResolvedValueOnce({
        ...result,
        binding: { ...binding, instanceId: 'instance-b' },
      })
    const onChange = vi.fn()
    const form = (
      <Form
        initial={{
          ...defaultTaskOptions(''),
          directory: { ...binding, path: '/movies' },
        }}
        onChange={onChange}
      />
    )
    const view = render(
      <DownloadDirectoryConnectionProvider state={connectedState}>
        {form}
      </DownloadDirectoryConnectionProvider>
    )
    view.rerender(
      <DownloadDirectoryConnectionProvider
        state={{
          ...connectedState,
          server: { ...connectedState.server!, instanceId: 'instance-b' },
        }}
      >
        {form}
      </DownloadDirectoryConnectionProvider>
    )
    await screen.findByText(i18n.t('popup.taskForm.directoryUnavailable'))
    await act(async () => finish(result))
    expect(screen.getByRole('combobox').getAttribute('aria-invalid')).toBe(
      'true'
    )
    expect(screen.getByRole('combobox').textContent).toContain('/movies')
    expect(onChange).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('connects once and refreshes directories without changing the draft or submitting a task', async () => {
    let finish!: (value: { ok: true }) => void
    const connection = new Promise<{ ok: true }>((resolve) => {
      finish = resolve
    })
    vi.mocked(send)
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockImplementationOnce(() => connection)
      .mockResolvedValueOnce(result)
    const onChange = vi.fn()
    const form = <Form onChange={onChange} />
    const view = render(
      <DownloadDirectoryConnectionProvider
        state={{ ...connectedState, connection: 'disconnected', server: null }}
      >
        {form}
      </DownloadDirectoryConnectionProvider>
    )
    await screen.findByText(i18n.t('popup.taskForm.directoryOffline'))
    const connect = screen.getByRole('button', {
      name: i18n.t('popup.reconnect'),
    })
    await user.dblClick(connect)
    view.rerender(
      <DownloadDirectoryConnectionProvider
        state={{ ...connectedState, connection: 'connecting', server: null }}
      >
        {form}
      </DownloadDirectoryConnectionProvider>
    )
    expect(connect.getAttribute('aria-busy')).toBe('true')
    expect(connect.hasAttribute('disabled')).toBe(true)
    expect(
      screen
        .getByRole('button', {
          name: i18n.t('popup.taskForm.directoryRefresh'),
        })
        .hasAttribute('disabled')
    ).toBe(true)
    expect(vi.mocked(send).mock.calls).toEqual([
      ['bg.getDownloadDirectories', undefined],
      ['bg.viewTasks', undefined],
    ])
    finish({ ok: true })
    await screen.findByText(i18n.t('popup.taskForm.directoryHint'))
    expect(vi.mocked(send).mock.calls).toEqual([
      ['bg.getDownloadDirectories', undefined],
      ['bg.viewTasks', undefined],
      ['bg.getDownloadDirectories', undefined],
    ])
    expect(connect.hasAttribute('disabled')).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })
  it.each([
    ['connection failed', 'errors.connection.generic'],
    [DOWNLOAD_ERROR.pairingRequired, 'popup.integration.pairingRequired'],
  ])(
    'retains the selected directory on connection failure: %s',
    async (message, key) => {
      vi.mocked(send)
        .mockResolvedValueOnce({ status: 'unavailable' })
        .mockRejectedValueOnce(new Error(message))
      const onChange = vi.fn()
      render(
        <Form
          initial={{
            ...defaultTaskOptions(''),
            directory: { ...binding, path: '/movies' },
          }}
          onChange={onChange}
        />
      )
      await screen.findByText(i18n.t('popup.taskForm.directoryUnavailable'))
      await user.click(
        screen.getByRole('button', { name: i18n.t('popup.reconnect') })
      )
      expect((await screen.findByRole('alert')).textContent).toBe(i18n.t(key))
      expect(screen.getByRole('combobox').textContent).toContain('/movies')
      expect(
        screen
          .getByRole('button', { name: i18n.t('popup.reconnect') })
          .hasAttribute('disabled')
      ).toBe(false)
      expect(onChange).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledTimes(2)
    }
  )
  it('does not refresh after closing the form during a connection', async () => {
    let finish!: (value: { ok: true }) => void
    const connection = new Promise<{ ok: true }>((resolve) => {
      finish = resolve
    })
    vi.mocked(send)
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockImplementationOnce(() => connection)
    const view = render(<Form />)
    await screen.findByText(i18n.t('popup.taskForm.directoryOffline'))
    await user.click(
      screen.getByRole('button', { name: i18n.t('popup.reconnect') })
    )
    view.unmount()
    finish({ ok: true })
    await connection
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('keeps the default usable offline and loads choices after connecting and refreshing', async () => {
    vi.mocked(send)
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockResolvedValueOnce(result)
    const onChange = vi.fn()
    render(<Form onChange={onChange} />)
    await screen.findByText(i18n.t('popup.taskForm.directoryOffline'))
    expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('combobox').textContent).toContain(
      i18n.t('popup.taskForm.directoryAutomatic')
    )
    expect(onChange).not.toHaveBeenCalled()
    await user.click(
      screen.getByRole('button', {
        name: i18n.t('popup.taskForm.directoryRefresh'),
      })
    )
    await screen.findByText(i18n.t('popup.taskForm.directoryHint'))
    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: '/movies' }))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ directory: { ...binding, path: '/movies' } })
    )
  })
  it('preserves an explicit directory while offline and validates it after reconnecting', async () => {
    vi.mocked(send)
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockResolvedValueOnce(result)
    const onChange = vi.fn()
    render(
      <Form
        initial={{
          ...defaultTaskOptions(''),
          directory: { ...binding, path: '/movies' },
        }}
        onChange={onChange}
      />
    )
    await screen.findByText(i18n.t('popup.taskForm.directoryUnavailable'))
    expect(screen.getByRole('combobox').textContent).toContain('/movies')
    await user.click(
      screen.getByRole('button', {
        name: i18n.t('popup.taskForm.directoryRefresh'),
      })
    )
    await screen.findByText(i18n.t('popup.taskForm.directoryHint'))
    expect(screen.getByRole('combobox').getAttribute('aria-invalid')).toBe(
      'false'
    )
    expect(screen.getByRole('combobox').textContent).toContain('/movies')
    expect(onChange).not.toHaveBeenCalled()
  })
  it('selects a grouped directory together with its target binding', async () => {
    vi.mocked(send).mockResolvedValue(result)
    const onChange = vi.fn()
    render(<Form onChange={onChange} />)
    await screen.findByText(i18n.t('popup.taskForm.directoryHint'))
    await user.click(screen.getByRole('combobox'))
    expect(
      await screen.findAllByRole('option', { name: '/movies' })
    ).toHaveLength(1)
    await user.click(await screen.findByRole('option', { name: '/movies' }))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ directory: { ...binding, path: '/movies' } })
    )
  })
  it('retains an unavailable choice until the user explicitly selects default', async () => {
    vi.mocked(send).mockResolvedValue({ status: 'unsupported' })
    const onChange = vi.fn()
    render(
      <Form
        initial={{
          ...defaultTaskOptions(''),
          directory: { ...binding, path: '/movies' },
        }}
        onChange={onChange}
      />
    )
    await screen.findByText(i18n.t('popup.taskForm.directoryUnavailable'))
    expect(onChange).not.toHaveBeenCalled()
    await user.click(screen.getByRole('combobox'))
    await user.click(
      await screen.findByRole('option', {
        name: i18n.t('popup.taskForm.directoryAutomatic'),
      })
    )
    expect(onChange.mock.lastCall?.[0].directory).toBeUndefined()
  })
  it('allows explicit reselection of the same path on a new instance', async () => {
    vi.mocked(send).mockResolvedValue({
      ...result,
      binding: { ...binding, instanceId: 'instance-b' },
    })
    const onChange = vi.fn()
    render(
      <Form
        initial={{
          ...defaultTaskOptions(''),
          directory: { ...binding, path: '/movies' },
        }}
        onChange={onChange}
      />
    )
    await screen.findByText(i18n.t('popup.taskForm.directoryUnavailable'))
    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: '/movies' }))
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          directory: { ...binding, instanceId: 'instance-b', path: '/movies' },
        })
      )
    )
  })
})
