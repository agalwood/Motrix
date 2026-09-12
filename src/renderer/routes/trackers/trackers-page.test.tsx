import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { TrackerSyncStatus } from '@shared/schemas/tracker-sync'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TrackersPage } from './trackers-page'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))

let syncStatus: TrackerSyncStatus = 'idle'

const SETTINGS_RESPONSE = {
  tracker: {
    sourcesEnabled: true,
    sources: [],
    blacklistEnabled: true,
    blacklistSources: [],
  },
}

const TRACKER_LIST_RESPONSE = {
  effective: [],
  blacklist: [],
  healthMap: {},
  sourceMap: {},
  lastSyncAt: null,
  lastProbeAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  syncStatus = 'idle'
  vi.mocked(transport.invoke).mockImplementation(async (cmd: string) => {
    if (cmd === Queries.GetSettings) return SETTINGS_RESPONSE
    if (cmd === Queries.GetTrackerList) return TRACKER_LIST_RESPONSE
    if (cmd === Queries.GetTrackerSyncStatus) return syncStatus
    return undefined
  })
})

describe('TrackersPage', () => {
  it('renders panel title and the two tabs', () => {
    render(<TrackersPage />)
    expect(screen.getByText('Trackers')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /effective/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /blacklist/i })).toBeInTheDocument()
  })

  it('renders a Sync Now button in the footer', () => {
    render(<TrackersPage />)
    expect(screen.getByRole('button', { name: 'Sync Now' })).toBeInTheDocument()
  })

  it('defaults to the Effective tab', () => {
    render(<TrackersPage />)
    expect(screen.getByRole('tab', { name: /effective/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('switches to Blacklist tab on click', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<TrackersPage />)
    await user.click(screen.getByRole('tab', { name: /blacklist/i }))
    expect(screen.getByRole('tab', { name: /blacklist/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('shows background sync in the footer and both empty lists, then restores the button', async () => {
    syncStatus = 'probing'
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<TrackersPage />)
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Checking tracker availability…'
      )
    )
    expect(screen.getByRole('button', { name: 'Syncing...' })).toBeDisabled()
    expect(
      within(screen.getByRole('tabpanel')).getByText(
        'Checking tracker availability…'
      )
    ).toBeVisible()
    await user.click(screen.getByRole('tab', { name: /blacklist/i }))
    expect(
      within(screen.getByRole('tabpanel')).getByText(
        'Checking tracker availability…'
      )
    ).toBeVisible()
    syncStatus = 'idle'
    act(() => {
      for (const [channel, listener] of vi.mocked(transport.on).mock.calls) {
        if (channel === Events.TrackerSyncStatusChanged) listener()
      }
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sync Now' })).toBeEnabled()
    )
    expect(
      screen.queryByText('Checking tracker availability…')
    ).not.toBeInTheDocument()
  })

  it('shows a helpful background failure and lets the user retry', async () => {
    syncStatus = 'failed'
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<TrackersPage />)
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Sync incomplete. Check your network or sources and try again.'
      )
    )
    await user.click(screen.getByRole('button', { name: 'Sync Now' }))
    expect(transport.invoke).toHaveBeenCalledWith(Commands.SyncTrackers)
  })
})
