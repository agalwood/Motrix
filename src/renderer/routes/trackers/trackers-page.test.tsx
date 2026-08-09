import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { Queries } from '@shared/protocol/queries'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TrackersPage } from './trackers-page'

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
  vi.stubGlobal(
    'window',
    Object.assign(window, {
      motrix: {
        platform: 'darwin',
        invoke: vi.fn(async (cmd: string) => {
          if (cmd === Queries.GetSettings) return SETTINGS_RESPONSE
          if (cmd === Queries.GetTrackerList) return TRACKER_LIST_RESPONSE
          return undefined
        }),
        on: vi.fn().mockReturnValue(() => {}),
        off: vi.fn(),
      },
    })
  )
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
})
