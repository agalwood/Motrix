import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlacklistTrackerPanel } from './blacklist-tracker-panel'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))

const SETTINGS_RESPONSE = {
  tracker: {
    sourcesEnabled: true,
    sources: [],
    blacklistEnabled: true,
    blacklistSources: [
      {
        id: 'bl',
        label: 'BL',
        url: 'http://bl',
        builtin: true,
        enabled: true,
        cdn: false,
      },
    ],
  },
}

const LIST_RESPONSE = {
  effective: [],
  blacklist: ['udp://bad-tracker:80'],
  healthMap: {},
  sourceMap: { 'udp://bad-tracker:80': ['bl'] },
  lastSyncAt: 0,
  lastProbeAt: 0,
}

describe('<BlacklistTrackerPanel>', () => {
  beforeEach(() => {
    vi.mocked(transport.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === Queries.GetSettings) return SETTINGS_RESPONSE
      if (cmd === Queries.GetTrackerList) return LIST_RESPONSE
      return undefined
    })
  })
  afterEach(() => vi.clearAllMocks())

  it('hydrates blacklistEnabled into the switch', async () => {
    render(<BlacklistTrackerPanel />)
    const sw = await screen.findByRole('switch')
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'))
  })

  it('renders blacklist URLs', async () => {
    render(<BlacklistTrackerPanel />)
    expect(await screen.findByText('udp://bad-tracker:80')).toBeInTheDocument()
  })

  it('switch toggle calls UpdateSettings with blacklistEnabled', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<BlacklistTrackerPanel />)
    const sw = await screen.findByRole('switch')
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'))
    await user.click(sw)
    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      tracker: { blacklistEnabled: false },
    })
  })

  it('shows disabled hint when blacklistEnabled is false', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === Queries.GetSettings)
        return {
          tracker: { ...SETTINGS_RESPONSE.tracker, blacklistEnabled: false },
        }
      if (cmd === Queries.GetTrackerList) return LIST_RESPONSE
      return undefined
    })
    render(<BlacklistTrackerPanel />)
    expect(await screen.findByText(/turn on/i)).toBeInTheDocument()
  })
})
