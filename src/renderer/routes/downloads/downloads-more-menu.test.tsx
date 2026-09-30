import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { CompletionShutdownState } from '@shared/schemas/completion-shutdown'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (value: unknown) => void>(),
  transport: { platform: 'darwin', invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
  toast: vi.fn(),
}))
vi.mock('@renderer/lib/transport', () => ({ transport: mocks.transport }))
vi.mock('@renderer/components/ui/toast', () => ({
  toast: { add: mocks.toast },
}))

import { DownloadsMoreMenu } from './downloads-more-menu'

const off: CompletionShutdownState = {
  supported: true,
  phase: 'off',
  deadline: null,
  error: null,
}

describe('DownloadsMoreMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listeners.clear()
    mocks.transport.platform = 'darwin'
    mocks.transport.on.mockImplementation((event, listener) =>
      mocks.listeners.set(event, listener)
    )
    mocks.transport.invoke.mockResolvedValue(off)
  })
  afterEach(cleanup)

  it('enables and cancels through the desktop host and displays live state', async () => {
    mocks.transport.invoke.mockImplementation(async (channel, payload) => {
      if (channel === Queries.GetCompletionShutdown) return off
      const state = { ...off, phase: payload.enabled ? 'waiting' : 'off' }
      mocks.listeners.get(Events.CompletionShutdownChanged)?.(state)
      return state
    })
    const user = userEvent.setup()
    render(<DownloadsMoreMenu />)
    const button = screen.getByRole('button', { name: 'More download actions' })
    await user.click(button)
    await user.click(
      await screen.findByRole('menuitem', {
        name: 'Shut down after all downloads finish',
      })
    )
    expect(mocks.transport.invoke).toHaveBeenCalledWith(
      Commands.SetCompletionShutdown,
      { enabled: true }
    )
    expect(button).toHaveAttribute('data-active', 'true')
    await user.click(button)
    await user.click(
      await screen.findByRole('menuitem', {
        name: 'Cancel shutdown after downloads',
      })
    )
    expect(mocks.transport.invoke).toHaveBeenCalledWith(
      Commands.SetCompletionShutdown,
      { enabled: false }
    )
    expect(button).toHaveAttribute('data-active', 'false')
  })

  it('does not overwrite a live event with a stale initial query', async () => {
    let resolve!: (value: unknown) => void
    mocks.transport.invoke.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    render(<DownloadsMoreMenu />)
    await act(async () => {
      mocks.listeners.get(Events.CompletionShutdownChanged)?.({
        ...off,
        phase: 'waiting',
      })
      resolve(off)
    })
    expect(screen.getByRole('button')).toHaveAttribute('data-active', 'true')
  })

  it('makes the action unavailable on the web without invoking desktop IPC', async () => {
    mocks.transport.platform = 'web'
    const user = userEvent.setup()
    render(<DownloadsMoreMenu />)
    await user.click(screen.getByRole('button'))
    expect(await screen.findByRole('menuitem')).toHaveAttribute(
      'aria-disabled',
      'true'
    )
    expect(screen.getByRole('status')).toHaveTextContent('unavailable')
    expect(mocks.transport.invoke).not.toHaveBeenCalled()
  })

  it('reports permission failures without showing an enabled indicator', async () => {
    mocks.transport.invoke.mockImplementation(async (channel) =>
      channel === Queries.GetCompletionShutdown
        ? off
        : { ...off, phase: 'failed', error: 'unavailable' }
    )
    const user = userEvent.setup()
    render(<DownloadsMoreMenu />)
    await user.click(screen.getByRole('button'))
    await user.click(await screen.findByRole('menuitem'))
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' })
      )
    )
    expect(screen.getByRole('button')).toHaveAttribute('data-active', 'false')
  })
})
