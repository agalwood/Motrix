import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { toast } from '@renderer/components/ui/toast'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginLogTab } from './plugin-log-tab'

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('@renderer/lib/transport', () => ({ transport: { invoke: vi.fn() } }))
vi.mock('@renderer/components/ui/toast', () => ({ toast: { add: vi.fn() } }))
vi.mock('../hooks/use-plugin-log-stream', () => ({
  usePluginLogStream: () => ({
    entries: [{ ts: 1, level: 'error', msg: 'original failure' }],
    refresh,
  }),
}))
vi.mock('../hooks/use-plugin-log-state', () => ({
  usePluginLogState: () => ({
    verbose: false,
    pending: false,
    setVerbose: vi.fn(),
  }),
}))
beforeEach(() => {
  vi.clearAllMocks()
  refresh.mockResolvedValue(undefined)
})

describe('plugin log clear feedback', () => {
  it('reports a failed clear and keeps the existing entries visible for retry', async () => {
    vi.mocked(transport.invoke)
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    render(<PluginLogTab pluginId="alice.demo" />)
    const clear = screen.getByRole('button', { name: 'Clear' })
    await user.click(clear)
    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith({
        title: 'Couldn’t clear logs. Try again.',
        type: 'error',
      })
    )
    expect(screen.getByText('original failure')).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
    expect(clear).toBeEnabled()
    await user.click(clear)
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  })
  it('disables duplicate clear submissions until the command and refresh finish', async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(transport.invoke).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    render(<PluginLogTab pluginId="alice.demo" />)
    const clear = screen.getByRole('button', { name: 'Clear' })
    fireEvent.click(clear)
    expect(clear).toBeDisabled()
    fireEvent.click(clear)
    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith(
      Commands.ClearPluginLogs,
      { pluginId: 'alice.demo' }
    )
    await act(async () => resolve({ ok: true }))
    expect(refresh).toHaveBeenCalledOnce()
    expect(clear).toBeEnabled()
  })
})
