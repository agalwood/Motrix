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
  app: { magnetFileSelection: true },
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
})
