import '@test-utils/dom-animations'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { Commands } from '@shared/protocol/commands'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue({
    stagingId: 's_1',
    consent: {
      manifest: {
        id: 'acme.speed-boost',
        name: 'Speed Boost',
        version: '1.0.0',
        description: 'x',
      },
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
  mockInvoke.mockReset().mockResolvedValue(preparedInstall('s_1'))
  usePluginsStore.setState({ updates: {} })
})

function preparedInstall(stagingId: string) {
  return {
    stagingId,
    committed: false,
    consent: {
      manifest: {
        id: 'acme.speed-boost',
        name: 'Speed Boost',
        version: '1.0.0',
        description: 'x',
      },
      ffmpegRuntime: { requiredByPlugin: 'none', available: false },
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('PluginInstallDialog with fixedSource', () => {
  it('shows download and verification progress until the consent is ready', async () => {
    const download = deferred<ReturnType<typeof preparedInstall>>()
    mockInvoke.mockReturnValueOnce(download.promise)
    render(
      <PluginInstallDialog
        open
        onOpenChange={vi.fn()}
        fixedSource={{ sourceType: 'registry', pluginId: 'acme.speed-boost' }}
      />
    )
    expect(
      screen.getByRole('heading', { name: 'Install plugin' })
    ).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Preparing…')
    expect(screen.queryByText(/Paste a plugin address/)).toBeNull()
    expect(screen.queryByTestId('plugin-input-group')).toBeNull()
    expect(screen.queryByTestId('consent-panel')).toBeNull()
    expect(screen.queryByTestId('install-commit-btn')).toBeNull()

    await act(async () => download.resolve(preparedInstall('s_ready')))
    expect(await screen.findByTestId('consent-panel')).toBeVisible()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByTestId('install-commit-btn')).toBeEnabled()
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it('offers retry after a download fails without returning to manual source entry', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Download failed'))
    render(
      <PluginInstallDialog
        open
        onOpenChange={vi.fn()}
        fixedSource={{ sourceType: 'registry', pluginId: 'acme.speed-boost' }}
      />
    )
    expect(await screen.findByText('Download failed')).toBeVisible()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByTestId('install-commit-btn')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('consent-panel')).toBeVisible()
    expect(screen.queryByText('Download failed')).toBeNull()
    expect(screen.queryByTestId('plugin-input-group')).toBeNull()
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it('discards a dismissed download when it finishes after reopening', async () => {
    const previous = deferred<ReturnType<typeof preparedInstall>>()
    const current = deferred<ReturnType<typeof preparedInstall>>()
    mockInvoke.mockReturnValueOnce(previous.promise)
    const onOpenChange = vi.fn()
    const source = {
      sourceType: 'registry' as const,
      pluginId: 'acme.speed-boost',
    }
    const { rerender } = render(
      <PluginInstallDialog
        open
        onOpenChange={onOpenChange}
        fixedSource={source}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    rerender(
      <PluginInstallDialog
        open={false}
        onOpenChange={onOpenChange}
        fixedSource={source}
      />
    )
    mockInvoke.mockReturnValueOnce(current.promise)
    rerender(
      <PluginInstallDialog
        open
        onOpenChange={onOpenChange}
        fixedSource={source}
      />
    )

    await act(async () => previous.resolve(preparedInstall('s_dismissed')))
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(Commands.CancelPluginInstall, {
        stagingId: 's_dismissed',
      })
    )
    expect(screen.queryByTestId('consent-panel')).toBeNull()
    expect(screen.getByRole('status')).toBeVisible()

    await act(async () => current.resolve(preparedInstall('s_current')))
    expect(await screen.findByTestId('consent-panel')).toBeVisible()
    fireEvent.click(screen.getByTestId('install-commit-btn'))
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(Commands.ConfirmPluginInstall, {
        stagingId: 's_current',
        grants: {},
      })
    )
  })

  it('cancels staged consent when dismissed with the close button', async () => {
    const onOpenChange = vi.fn()
    render(
      <PluginInstallDialog
        open
        onOpenChange={onOpenChange}
        fixedSource={{ sourceType: 'registry', pluginId: 'acme.speed-boost' }}
      />
    )
    await screen.findByTestId('consent-panel')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(Commands.CancelPluginInstall, {
        stagingId: 's_1',
      })
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('keeps the dialog open while the confirmed installation is committing', async () => {
    const commit = deferred<undefined>()
    const onOpenChange = vi.fn()
    render(
      <PluginInstallDialog
        open
        onOpenChange={onOpenChange}
        fixedSource={{ sourceType: 'registry', pluginId: 'acme.speed-boost' }}
      />
    )
    await screen.findByTestId('consent-panel')
    mockInvoke.mockReturnValueOnce(commit.promise)
    fireEvent.click(screen.getByTestId('install-commit-btn'))
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onOpenChange).not.toHaveBeenCalled()
    await act(async () => commit.resolve(undefined))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('explains media-merge compatibility without showing consent or allowing commit', async () => {
    mockInvoke.mockResolvedValueOnce({
      incompatible: {
        required: '>=2.0.0-beta.47 <3.0.0',
        hostVersion: '2.0.0-beta.46',
      },
    })
    const onOpenChange = vi.fn()
    render(
      <PluginInstallDialog
        open
        onOpenChange={onOpenChange}
        fixedSource={{ sourceType: 'registry', pluginId: 'motrix.media-merge' }}
      />
    )
    expect(
      await screen.findByText(
        /This plugin requires Motrix >=2.0.0-beta.47 <3.0.0; current version: 2.0.0-beta.46/
      )
    ).toBeInTheDocument()
    expect(screen.queryByTestId('consent-panel')).toBeNull()
    expect(screen.queryByTestId('install-commit-btn')).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

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
    expect(screen.queryByTestId('install-commit-btn')).toBeNull()
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
