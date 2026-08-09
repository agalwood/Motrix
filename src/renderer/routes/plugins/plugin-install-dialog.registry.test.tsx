import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { Commands } from '@shared/protocol/commands'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue({
    stagingId: 's_1',
    consent: {
      manifest: { name: 'Speed Boost', description: 'x' },
      ffmpegRuntime: { requiredByPlugin: 'none', available: false },
    },
  }),
}))
vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: mockInvoke, on: vi.fn(), off: vi.fn() },
}))
vi.mock('./components/inline-consent-panel', () => ({
  InlineConsentPanel: () => <div data-testid="consent-panel" />,
}))
vi.mock('./components/plugin-input-group', () => ({
  PluginInputGroup: () => <div data-testid="plugin-input-group" />,
}))

import { PluginInstallDialog } from './plugin-install-dialog'
import { usePluginsStore } from './store'

beforeEach(() => {
  mockInvoke.mockClear()
  usePluginsStore.setState({ updates: {} })
})

describe('PluginInstallDialog with fixedSource', () => {
  it('auto-starts a registry install and hides the source picker', async () => {
    render(
      <PluginInstallDialog
        open
        onOpenChange={() => {}}
        fixedSource={{ sourceType: 'registry', pluginId: 'acme.speed-boost' }}
      />
    )
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(Commands.InstallPlugin, {
        sourceType: 'registry',
        pluginId: 'acme.speed-boost',
      })
    )
    expect(mockInvoke).toHaveBeenCalledTimes(1)
    await screen.findByTestId('consent-panel')
    expect(screen.queryByTestId('plugin-input-group')).toBeNull()
  })

  it('clears the store update entry after a successful registry install commit', async () => {
    usePluginsStore.setState({
      updates: {
        'acme.speed-boost': { latestVersion: '2.0.0', channel: 'community' },
      },
    })

    render(
      <PluginInstallDialog
        open
        onOpenChange={() => {}}
        fixedSource={{ sourceType: 'registry', pluginId: 'acme.speed-boost' }}
      />
    )
    await screen.findByTestId('consent-panel')

    fireEvent.click(screen.getByTestId('install-commit-btn'))

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        Commands.ConfirmPluginInstall,
        expect.objectContaining({ stagingId: 's_1' })
      )
    )
    await waitFor(() =>
      expect(
        usePluginsStore.getState().updates['acme.speed-boost']
      ).toBeUndefined()
    )
  })

  it('does not touch the store on cancel', async () => {
    usePluginsStore.setState({
      updates: {
        'acme.speed-boost': { latestVersion: '2.0.0', channel: 'community' },
      },
    })

    render(
      <PluginInstallDialog
        open
        onOpenChange={() => {}}
        fixedSource={{ sourceType: 'registry', pluginId: 'acme.speed-boost' }}
      />
    )
    await screen.findByTestId('consent-panel')

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        Commands.CancelPluginInstall,
        expect.objectContaining({ stagingId: 's_1' })
      )
    )
    expect(usePluginsStore.getState().updates['acme.speed-boost']).toEqual({
      latestVersion: '2.0.0',
      channel: 'community',
    })
  })
})
