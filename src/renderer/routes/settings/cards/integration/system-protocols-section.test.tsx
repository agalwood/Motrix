import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { LinuxDefaultAssociations } from '@shared/types/linux-default-apps'
import type { WindowsDefaultAssociations } from '@shared/types/windows-default-apps'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FormProvider, useForm } from 'react-hook-form'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationFormValues } from './integration-dialog'
import { SystemProtocolsSection } from './system-protocols-section'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), off: vi.fn(), on: vi.fn(), platform: 'win32' },
}))

let windowsStatus: WindowsDefaultAssociations
let linuxStatus: LinuxDefaultAssociations

function renderSection(platform: typeof transport.platform) {
  Object.defineProperty(transport, 'platform', {
    configurable: true,
    value: platform,
  })

  function Harness() {
    const form = useForm<IntegrationFormValues>({
      defaultValues: {
        app: {
          browserBridgeEnabled: true,
          protocols: { magnet: true },
        },
        media: {
          ffmpegBinaryPath: '',
          ffmpegStagingMB: 512,
          ffmpegOpTimeoutSec: 300,
        },
      },
    })
    return (
      <FormProvider {...form}>
        <SystemProtocolsSection />
      </FormProvider>
    )
  }

  return render(<Harness />)
}

describe('<SystemProtocolsSection>', () => {
  beforeEach(() => {
    windowsStatus = {
      supported: true,
      registered: true,
      scope: 'user',
      torrent: true,
      magnet: false,
    }
    linuxStatus = {
      supported: true,
      packageKind: 'native',
      registered: true,
      canSetTorrentDefault: true,
      torrent: false,
      magnet: true,
    }
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetWindowsDefaultAssociations) {
        return windowsStatus
      }
      if (channel === Queries.GetLinuxDefaultAssociations) {
        return linuxStatus
      }
      if (channel === Commands.RequestDefaultTorrentHandler) {
        return { ok: true, action: 'set' }
      }
      if (channel === Commands.EnableAppImageIntegration) {
        return { supported: true, status: 'healthy' }
      }
      return { ok: true }
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('shows current Windows status and opens the system settings', async () => {
    renderSection('win32')

    expect(
      screen.queryByText('Open magnet links with Motrix')
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('Default app for torrents and magnet links')
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        /Motrix appears there after installation with Motrix Setup/u
      )
    ).toBeInTheDocument()
    expect(await screen.findByText('Default')).toBeInTheDocument()
    expect(screen.getByText('Not default')).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Open Windows settings' })
    )
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.RequestDefaultTorrentHandler
      )
    )
  })

  it('refreshes association status when the window regains focus', async () => {
    windowsStatus = { ...windowsStatus, torrent: false }
    renderSection('win32')
    expect(await screen.findAllByText('Not default')).toHaveLength(2)

    windowsStatus = { ...windowsStatus, torrent: true, magnet: true }
    act(() => window.dispatchEvent(new Event('focus')))

    await waitFor(() => {
      expect(screen.getAllByText('Default')).toHaveLength(2)
    })
  })

  it('explains when the portable ZIP has no installer registration', async () => {
    windowsStatus = { ...windowsStatus, registered: false, scope: null }
    renderSection('win32')

    expect(await screen.findAllByText('Setup required')).toHaveLength(2)
  })

  it('shows live native Linux defaults and offers a verified one-click action', async () => {
    renderSection('linux')

    expect(
      screen.getByText('Open magnet links with Motrix')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Linux file and link associations')
    ).toBeInTheDocument()
    expect(await screen.findByText('Package: deb / rpm')).toBeVisible()
    expect(screen.getByText('Not default')).toBeVisible()
    expect(screen.getByText('Default')).toBeVisible()

    fireEvent.click(
      screen.getByRole('button', { name: 'Set .torrent default' })
    )
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.RequestDefaultTorrentHandler
      )
    )
    expect(
      await screen.findByText('Motrix is now the default for .torrent files.')
    ).toBeVisible()
  })

  it('routes AppImage users to the dedicated desktop integration controls', async () => {
    linuxStatus = {
      ...linuxStatus,
      packageKind: 'appimage',
      canSetTorrentDefault: false,
      torrent: true,
    }
    renderSection('linux')

    expect(await screen.findByText('Package: AppImage')).toBeVisible()
    expect(screen.getByText(/Use Desktop integration below/u)).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Set .torrent default' })
    ).not.toBeInTheDocument()
    expect(screen.getByText(/Applied immediately after saving/u)).toBeVisible()
  })

  it('offers a transaction-safe repair for a legacy AppImage association', async () => {
    linuxStatus = {
      ...linuxStatus,
      packageKind: 'appimage',
      registered: true,
      canSetTorrentDefault: false,
      torrent: false,
    }
    renderSection('linux')

    fireEvent.click(
      await screen.findByRole('button', { name: 'Repair associations' })
    )
    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith(
        Commands.EnableAppImageIntegration
      )
    )
  })

  it('explains sandbox ownership and distinguishes an unreadable default', async () => {
    linuxStatus = {
      ...linuxStatus,
      packageKind: 'flatpak',
      canSetTorrentDefault: false,
      torrent: null,
      magnet: null,
    }
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetLinuxDefaultAssociations) return linuxStatus
      if (channel === Commands.RequestDefaultTorrentHandler) {
        return { ok: true, action: 'opened-fallback' }
      }
      return { ok: true }
    })
    renderSection('linux')

    expect(await screen.findByText('Package: Flatpak')).toBeVisible()
    expect(screen.getAllByText('Couldn’t verify')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'View setup steps' }))
    expect(
      await screen.findByText(/Setup instructions were opened instead/u)
    ).toBeVisible()
  })
})
