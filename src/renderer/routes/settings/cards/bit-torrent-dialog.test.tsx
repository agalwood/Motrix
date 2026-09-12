// src/renderer/routes/settings/cards/bit-torrent-dialog.test.tsx

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { BitTorrentDialog } from './bit-torrent-dialog'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))

// BtPeerGeoSection uses radix components that require ResizeObserver in jsdom
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver =
    MockResizeObserver as unknown as typeof ResizeObserver
}

const FIXTURE = {
  engine: {
    listenPort: 6881,
    dhtListenPort: 6881,
    dhtEnabled: true,
    btMaxPeers: 128,
    btEnableLpd: true,
    seedRatio: 1,
    seedTime: 60,
  },
  app: {
    magnetFileSelection: true,
    magnetFileSelectionAutoDownload: false,
    magnetFileSelectionTimeoutSeconds: 60,
  },
  tracker: {
    autoSync: true,
    syncIntervalHours: 24,
    probeEnabled: true,
    probeTimeoutMs: 5000,
    healthyThresholdMs: 2000,
    minSuccessRate: 0.5,
    maxTrackerCount: 50,
    sources: [],
  },
  geoip: {
    enabled: false,
    source: 'loyalsoldier',
    customUrl: '',
    maxmindLicenseKey: '',
    autoUpdate: true,
    autoUpdateIntervalDays: 7,
    lastUpdatedAt: 0,
    databaseVersion: '',
  },
}

describe('<BitTorrentDialog>', () => {
  beforeEach(() => {
    vi.mocked(transport.invoke).mockReset()
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetSettings) return FIXTURE
      return { saved: true, requiresRestart: false, changedRestartKeys: [] }
    })
  })

  it('saves the opt-in and waiting time together using only dirty fields', async () => {
    render(
      <BitTorrentDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.bittorrent.title"
        descKey="settings.cards.bittorrent.desc"
      />
    )
    await waitFor(() => screen.getByDisplayValue('128'))
    expect(
      screen.queryByRole('spinbutton', {
        name: 'File selection timeout (seconds)',
      })
    ).toBeNull()
    const user = userEvent.setup()
    const toggle = screen.getByRole('switch', {
      name: 'Download all files when selection times out',
    })
    expect(toggle).not.toBeChecked()
    await user.click(toggle)
    const timeout = screen.getByRole('spinbutton', {
      name: 'File selection timeout (seconds)',
    })
    expect(timeout).toHaveValue(60)
    fireEvent.change(timeout, { target: { value: '120' } })
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      app: {
        magnetFileSelectionAutoDownload: true,
        magnetFileSelectionTimeoutSeconds: 120,
      },
    })
  })

  it('rejects out-of-range waiting times before saving', async () => {
    render(
      <BitTorrentDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.bittorrent.title"
        descKey="settings.cards.bittorrent.desc"
      />
    )
    await waitFor(() => screen.getByDisplayValue('128'))
    const user = userEvent.setup()
    await user.click(
      screen.getByRole('switch', {
        name: 'Download all files when selection times out',
      })
    )
    fireEvent.change(
      screen.getByRole('spinbutton', {
        name: 'File selection timeout (seconds)',
      }),
      { target: { value: '0' } }
    )
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(
      screen.getByText('Enter a whole number from 10 to 3600.')
    ).toBeInTheDocument()
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.UpdateSettings,
      expect.anything()
    )
  })

  it('disables automatic selection when magnet file selection is off', async () => {
    render(
      <BitTorrentDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.bittorrent.title"
        descKey="settings.cards.bittorrent.desc"
      />
    )
    await waitFor(() => screen.getByDisplayValue('128'))
    const user = userEvent.setup()
    await user.click(
      screen.getByRole('switch', {
        name: 'Open file selection after magnet metadata loads',
      })
    )
    expect(
      screen.getByRole('switch', {
        name: 'Download all files when selection times out',
      })
    ).toHaveAttribute('aria-disabled', 'true')
  })

  it('hydrates engine + app + tracker fields', async () => {
    render(
      <BitTorrentDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.bittorrent.title"
        descKey="settings.cards.bittorrent.desc"
      />
    )
    await waitFor(() => {
      expect(screen.getByDisplayValue('128')).toBeInTheDocument()
    })
  })

  it('saves a listen-port change without a pre-save confirmation', async () => {
    render(
      <BitTorrentDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.bittorrent.title"
        descKey="settings.cards.bittorrent.desc"
      />
    )
    await waitFor(() => screen.getAllByDisplayValue('6881'))
    const user = userEvent.setup()
    const listenInput = screen.getAllByDisplayValue('6881')[0]
    fireEvent.change(listenInput, { target: { value: '6882' } })
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      engine: { listenPort: 6882 },
    })
    expect(screen.queryByText(/restart to apply changes/i)).toBeNull()
  })

  it('shows hint paragraph pointing users to the Trackers page Blacklist tab', async () => {
    render(
      <BitTorrentDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.bittorrent.title"
        descKey="settings.cards.bittorrent.desc"
      />
    )
    await waitFor(() => screen.getByText(/blacklist/i))
    expect(
      screen.getByText(/managed in the sidebar Trackers page/i)
    ).toBeInTheDocument()
  })

  it('keeps the dialog open when the GeoIP subform is invalid', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetSettings)
        return {
          ...FIXTURE,
          geoip: {
            ...FIXTURE.geoip,
            enabled: true,
            source: 'custom',
            customUrl: 'invalid address',
          },
        }
      return { saved: true }
    })
    const onClose = vi.fn()
    render(<BitTorrentDialog open onClose={onClose} labelKey="" descKey="" />)
    await screen.findByDisplayValue('invalid address')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(
      await screen.findByText(
        'Enter a full address starting with http:// or https://.'
      )
    ).toBeVisible()
    expect(onClose).not.toHaveBeenCalled()
    expect(transport.invoke).not.toHaveBeenCalledWith(
      Commands.UpdateSettings,
      expect.anything()
    )
  })
})
