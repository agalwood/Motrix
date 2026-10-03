import '@test-utils/dom-animations'
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
  it('explains why a retired builtin package cannot be installed as optional', async () => {
    mockInvoke.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'command:installPlugin': AppError: plugin.install.official_builtin_hook"
      )
    )
    render(
      <PluginInstallDialog
        open
        onOpenChange={() => {}}
        fixedSource={{
          sourceType: 'registry',
          pluginId: 'motrix.scraper-hook',
        }}
      />
    )
    expect(
      await screen.findByText(/This version requires built-in privileges/)
    ).toBeInTheDocument()
    expect(screen.getByTestId('install-commit-btn')).toBeDisabled()
  })

  it('closes after a trust-equivalent upgrade commits during staging', async () => {
    mockInvoke.mockResolvedValueOnce({
      committed: true,
      pluginId: 'motrix.optional-demo',
    })
    const onOpenChange = vi.fn()
    usePluginsStore.setState({
      updates: {
        'motrix.optional-demo': {
          latestVersion: '1.0.1',
          channel: 'community',
        },
      },
    })
    render(
      <PluginInstallDialog
        open
        onOpenChange={onOpenChange}
        fixedSource={{
          sourceType: 'registry',
          pluginId: 'motrix.optional-demo',
        }}
      />
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(
      usePluginsStore.getState().updates['motrix.optional-demo']
    ).toBeUndefined()
  })

  it('keeps consent open and displays a localized verification failure at commit', async () => {
    const onOpenChange = vi.fn()
    render(
      <PluginInstallDialog
        open
        onOpenChange={onOpenChange}
        fixedSource={{
          sourceType: 'registry',
          pluginId: 'motrix.optional-demo',
        }}
      />
    )
    await screen.findByTestId('consent-panel')
    mockInvoke.mockRejectedValueOnce(
      new Error('plugin.install.official_signature_invalid')
    )
    fireEvent.click(screen.getByTestId('install-commit-btn'))
    expect(
      await screen.findByText(
        /The official plugin signature could not be verified/
      )
    ).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
