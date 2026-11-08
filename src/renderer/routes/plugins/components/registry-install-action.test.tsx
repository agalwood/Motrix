import '@test-utils/dom-animations'
import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { Commands } from '@shared/protocol/commands'
import type { ConsentPayload } from '@shared/types/plugin-install'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke, on: vi.fn(), off: vi.fn() },
}))

import { usePluginsStore } from '../store'
import { RegistryInstallAction } from './registry-install-action'

function prepared(id = 'stage', name = 'Smart Link') {
  const consent: ConsentPayload = {
    manifest: {
      id: 'acme.smart-link',
      name,
      version: '1.0.0',
      description: 'Finds downloads.',
    },
    source: {
      type: 'registry',
      url: 'https://example.com/plugin.moext',
      bundleSha256: 'a'.repeat(64),
      recordedAt: 0,
    },
    trustSurface: {
      permissions: [
        { name: 'http', description: '' },
        { name: 'metadata', description: '' },
      ],
      optionalPermissions: [
        { name: 'fs.task.read', description: '' },
        { name: 'notify', description: '' },
      ],
      hostPermissions: [{ pattern: 'https://example.com/*', broad: false }],
      invokesCommands: [],
      publicCommandsExposed: [],
      enginesMotrix: '^2.0.0',
      notVerified: true,
    },
    diff: null,
    ffmpegRuntime: { requiredByPlugin: 'none', available: false },
  }
  return { stagingId: id, consent, committed: false }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function start() {
  fireEvent.click(screen.getByTestId('registry-install-btn'))
}
function confirm() {
  fireEvent.click(screen.getByTestId('install-commit-btn'))
}

beforeEach(() => {
  invoke
    .mockReset()
    .mockImplementation(async (channel) =>
      channel === Commands.InstallPlugin ? prepared() : undefined
    )
  usePluginsStore.setState({ updates: {} })
})

describe('RegistryInstallAction', () => {
  it('prepares in the button, then reviews parsed permissions before committing', async () => {
    const download = deferred<ReturnType<typeof prepared>>()
    invoke.mockReturnValueOnce(download.promise)
    render(<RegistryInstallAction pluginId="acme.smart-link" />)
    start()
    expect(screen.getByRole('button', { name: 'Preparing…' })).toBeDisabled()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText(/Downloading and checking/)).toBeNull()
    await act(async () => download.resolve(prepared()))
    expect(await screen.findByRole('dialog')).toBeVisible()
    const optional = screen.getAllByRole('switch')
    expect(optional).toHaveLength(2)
    for (const toggle of optional)
      expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Read and write task metadata')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Host access' }))
    expect(await screen.findByText('https://example.com/*')).toBeVisible()
    fireEvent.click(screen.getByRole('switch', { name: 'Read download files' }))
    confirm()
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(Commands.ConfirmPluginInstall, {
        stagingId: 'stage',
        grants: { 'fs.task.read': 'granted' },
      })
    )
    expect(
      await screen.findByRole('button', { name: 'Installed' })
    ).toBeDisabled()
  })

  it('keeps signature failures inline and retries the same registry source', async () => {
    invoke.mockRejectedValueOnce(
      new Error('plugin.install.official_signature_invalid')
    )
    render(<RegistryInstallAction pluginId="acme.smart-link" />)
    start()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The official plugin signature could not be verified'
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('dialog')
    expect(
      invoke.mock.calls.filter(
        ([channel]) => channel === Commands.InstallPlugin
      )
    ).toEqual([
      [
        Commands.InstallPlugin,
        { sourceType: 'registry', pluginId: 'acme.smart-link' },
      ],
      [
        Commands.InstallPlugin,
        { sourceType: 'registry', pluginId: 'acme.smart-link' },
      ],
    ])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('discards a cancelled result without replacing the next consent', async () => {
    const old = deferred<ReturnType<typeof prepared>>()
    const current = deferred<ReturnType<typeof prepared>>()
    invoke.mockReturnValueOnce(old.promise)
    render(<RegistryInstallAction pluginId="acme.smart-link" />)
    start()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(screen.getByTestId('registry-install-btn')).toBeEnabled()
    )
    invoke.mockReturnValueOnce(current.promise)
    start()
    await act(async () => old.resolve(prepared('old', 'Old plugin')))
    expect(invoke).toHaveBeenCalledWith(Commands.CancelPluginInstall, {
      stagingId: 'old',
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () =>
      current.resolve(prepared('current', 'Current plugin'))
    )
    expect(
      await screen.findByRole('heading', {
        name: 'Install Current plugin 1.0.0?',
      })
    ).toBeVisible()
    confirm()
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(Commands.ConfirmPluginInstall, {
        stagingId: 'current',
        grants: {},
      })
    )
  })

  it('cleans up staging that returns after navigation away', async () => {
    const download = deferred<ReturnType<typeof prepared>>()
    invoke.mockReturnValueOnce(download.promise)
    const view = render(<RegistryInstallAction pluginId="acme.smart-link" />)
    start()
    view.unmount()
    await act(async () => download.resolve(prepared('abandoned')))
    expect(invoke).toHaveBeenCalledWith(Commands.CancelPluginInstall, {
      stagingId: 'abandoned',
    })
    expect(
      invoke.mock.calls.some(
        ([channel]) => channel === Commands.ConfirmPluginInstall
      )
    ).toBe(false)
  })

  it('cleans up visible consent on unmount', async () => {
    const view = render(<RegistryInstallAction pluginId="acme.smart-link" />)
    start()
    await screen.findByRole('dialog')
    view.unmount()
    expect(invoke).toHaveBeenCalledWith(Commands.CancelPluginInstall, {
      stagingId: 'stage',
    })
  })

  it('retains consent through dismissal and resets grants on reopening', async () => {
    const exit = deferred<Animation>()
    const animation = { finished: exit.promise } as Animation
    const animations = vi
      .spyOn(Element.prototype, 'getAnimations')
      .mockImplementation(function (this: Element) {
        return this.getAttribute('data-slot') === 'dialog-content' &&
          this.hasAttribute('data-closed')
          ? [animation]
          : []
      })
    try {
      render(<RegistryInstallAction pluginId="acme.smart-link" />)
      start()
      const popup = await screen.findByRole('dialog')
      const toggle = screen.getByRole('switch', {
        name: 'Send notifications',
      })
      fireEvent.click(toggle)
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))

      await waitFor(() => expect(popup).toHaveAttribute('data-closed'))
      expect(popup).toBeInTheDocument()
      expect(popup).toHaveTextContent('Install Smart Link 1.0.0?')
      expect(toggle).toHaveAttribute('aria-checked', 'true')

      await act(async () => exit.resolve(animation))
      await waitFor(() => expect(popup).not.toBeInTheDocument())
      start()
      expect(
        await screen.findByRole('switch', { name: 'Send notifications' })
      ).toHaveAttribute('aria-checked', 'false')
    } finally {
      animations.mockRestore()
    }
  })

  it('locks confirmation and grants until the commit completes', async () => {
    const commit = deferred<undefined>()
    render(<RegistryInstallAction pluginId="acme.smart-link" />)
    start()
    await screen.findByRole('dialog')
    invoke.mockReturnValueOnce(commit.promise)
    confirm()
    confirm()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    for (const toggle of screen.getAllByRole('switch')) {
      expect(toggle).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-checked', 'false')
    }
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(
      invoke.mock.calls.filter(
        ([channel]) => channel === Commands.ConfirmPluginInstall
      )
    ).toHaveLength(1)
    expect(
      invoke.mock.calls.filter(
        ([channel]) => channel === Commands.CancelPluginInstall
      )
    ).toHaveLength(0)
    await act(async () => commit.resolve(undefined))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('keeps consent and grants when staging cancellation fails', async () => {
    render(<RegistryInstallAction pluginId="acme.smart-link" />)
    start()
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('switch', { name: 'Send notifications' }))
    invoke.mockRejectedValueOnce(new Error('Could not cancel staging'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not cancel staging'
    )
    expect(
      screen.getByRole('switch', { name: 'Send notifications' })
    ).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() =>
      expect(screen.getByTestId('registry-install-btn')).toHaveFocus()
    )
    start()
    expect(
      await screen.findByRole('switch', { name: 'Send notifications' })
    ).toHaveAttribute('aria-checked', 'false')
  })

  it('clears an update only after a successful trust-equivalent install', async () => {
    usePluginsStore.setState({
      updates: {
        'acme.smart-link': { latestVersion: '1.1.0', channel: 'community' },
      },
    })
    invoke.mockResolvedValueOnce({
      committed: true,
      pluginId: 'acme.smart-link',
    })
    render(
      <RegistryInstallAction pluginId="acme.smart-link" updateVersion="1.1.0" />
    )
    fireEvent.click(screen.getByTestId('plugin-update-btn'))
    await waitFor(() =>
      expect(
        usePluginsStore.getState().updates['acme.smart-link']
      ).toBeUndefined()
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not start a download on mount or duplicate it under StrictMode', async () => {
    render(
      <StrictMode>
        <RegistryInstallAction pluginId="acme.smart-link" />
      </StrictMode>
    )
    expect(invoke).not.toHaveBeenCalled()
    start()
    start()
    await screen.findByRole('dialog')
    expect(
      invoke.mock.calls.filter(
        ([channel]) => channel === Commands.InstallPlugin
      )
    ).toHaveLength(1)
  })

  it('does not install another plugin when the selection changes', async () => {
    const download = deferred<ReturnType<typeof prepared>>()
    invoke.mockReturnValueOnce(download.promise)
    const view = render(<RegistryInstallAction pluginId="acme.smart-link" />)
    start()
    view.rerender(<RegistryInstallAction pluginId="acme.other" />)
    expect(screen.getByRole('button', { name: 'Install' })).toBeEnabled()
    await act(async () => download.resolve(prepared('old')))
    expect(
      invoke.mock.calls.filter(
        ([channel]) => channel === Commands.InstallPlugin
      )
    ).toHaveLength(1)
  })
})
