import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { Commands } from '@shared/protocol/commands'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }))
vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: mockInvoke, on: vi.fn(), off: vi.fn() },
}))

import { usePluginsStore } from '../store'
import { BuiltinUpdateDialog } from './builtin-update-dialog'

beforeEach(() => {
  mockInvoke.mockReset()
  usePluginsStore.setState({ updates: {} })
})

describe('BuiltinUpdateDialog', () => {
  it('renders the added list on needsConsent and confirm invokes ConfirmBuiltinUpdate', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === Commands.InstallBuiltinUpdate) {
        return Promise.resolve({
          needsConsent: true,
          stagingId: 's1',
          added: ['perm:ffmpeg'],
          newVersion: '1.1.0',
        })
      }
      if (channel === Commands.ConfirmBuiltinUpdate) {
        return Promise.resolve({ ok: true, restartRequired: false })
      }
      return Promise.resolve(undefined)
    })

    render(
      <BuiltinUpdateDialog
        pluginId="motrix.scraper-hook"
        open
        onOpenChange={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(Commands.InstallBuiltinUpdate, {
        pluginId: 'motrix.scraper-hook',
      })
    )
    expect(await screen.findByText('perm:ffmpeg')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('builtin-update-confirm'))

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(Commands.ConfirmBuiltinUpdate, {
        stagingId: 's1',
      })
    )
  })

  it('shows the restart notice when the response is restartRequired', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === Commands.InstallBuiltinUpdate) {
        return Promise.resolve({ ok: true, restartRequired: true })
      }
      return Promise.resolve(undefined)
    })

    render(
      <BuiltinUpdateDialog
        pluginId="motrix.scraper-hook"
        open
        onOpenChange={vi.fn()}
      />
    )

    expect(
      await screen.findByText(
        'Update installed. Restart Motrix to finish applying it.'
      )
    ).toBeInTheDocument()
  })

  it('shows the updateInstalled message and clears the store update entry on a restartRequired:false success', async () => {
    usePluginsStore.setState({
      updates: {
        'motrix.scraper-hook': { latestVersion: '1.1.0', channel: 'builtin' },
      },
    })
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === Commands.InstallBuiltinUpdate) {
        return Promise.resolve({ ok: true, restartRequired: false })
      }
      return Promise.resolve(undefined)
    })

    render(
      <BuiltinUpdateDialog
        pluginId="motrix.scraper-hook"
        open
        onOpenChange={vi.fn()}
      />
    )

    expect(await screen.findByText('Update installed.')).toBeInTheDocument()
    expect(
      usePluginsStore.getState().updates['motrix.scraper-hook']
    ).toBeUndefined()
  })

  it('routes a rejected confirm into the error phase', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === Commands.InstallBuiltinUpdate) {
        return Promise.resolve({
          needsConsent: true,
          stagingId: 's1',
          added: ['perm:ffmpeg'],
          newVersion: '1.1.0',
        })
      }
      if (channel === Commands.ConfirmBuiltinUpdate) {
        return Promise.reject(new Error('commit failed'))
      }
      return Promise.resolve(undefined)
    })

    render(
      <BuiltinUpdateDialog
        pluginId="motrix.scraper-hook"
        open
        onOpenChange={vi.fn()}
      />
    )

    expect(await screen.findByText('perm:ffmpeg')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('builtin-update-confirm'))

    expect(await screen.findByText('commit failed')).toBeInTheDocument()
  })
})
