import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EffectiveTrackerPanel } from './effective-tracker-panel'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))

const SETTINGS_RESPONSE = {
  tracker: {
    sourcesEnabled: true,
    sources: [
      {
        id: 'a',
        label: 'A',
        url: 'http://a',
        builtin: true,
        enabled: true,
        cdn: false,
      },
    ],
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

describe('<EffectiveTrackerPanel>', () => {
  beforeEach(() => {
    vi.mocked(transport.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === Queries.GetSettings) return SETTINGS_RESPONSE
      if (cmd === Queries.GetTrackerList) return TRACKER_LIST_RESPONSE
      return undefined
    })
  })
  afterEach(() => vi.clearAllMocks())

  it('renders switch hydrated from settings.tracker.sourcesEnabled', async () => {
    render(<EffectiveTrackerPanel />)
    const sw = await screen.findByRole('switch')
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'))
  })

  it('clicking the switch calls UpdateSettings with the new value', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<EffectiveTrackerPanel />)
    const sw = await screen.findByRole('switch')
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'))
    await user.click(sw)
    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      tracker: { sourcesEnabled: false },
    })
  })

  it('renders effective list rows with URL and health columns', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === Queries.GetSettings) return SETTINGS_RESPONSE
      if (cmd === Queries.GetTrackerList)
        return {
          effective: ['udp://x:80', 'udp://y:80'],
          blacklist: [],
          healthMap: {
            'udp://x:80': {
              url: 'udp://x:80',
              protocol: 'udp',
              status: 'healthy',
              lastProbeMs: 12,
              lastProbeAt: 0,
              successCount: 1,
              failCount: 0,
              successRate: 1,
            },
          },
          sourceMap: { 'udp://x:80': ['a'] },
          lastSyncAt: 0,
          lastProbeAt: 0,
        }
      return undefined
    })
    render(<EffectiveTrackerPanel />)
    await screen.findByText('udp://x:80')
    expect(screen.getByText('udp://y:80')).toBeInTheDocument()
    // Health is now rendered as a colored dot (aria-hidden) plus the
    // response time. Assert the response-time text from the healthy row.
    expect(screen.getByText('12 ms')).toBeInTheDocument()
  })

  it('shows disabled hint when sourcesEnabled is false', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === Queries.GetSettings)
        return {
          tracker: { ...SETTINGS_RESPONSE.tracker, sourcesEnabled: false },
        }
      if (cmd === Queries.GetTrackerList) return TRACKER_LIST_RESPONSE
      return undefined
    })
    render(<EffectiveTrackerPanel />)
    expect(await screen.findByText(/turn on/i)).toBeInTheDocument()
  })

  it('filters list by page-level search prop', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (cmd: string) => {
      if (cmd === Queries.GetSettings) return SETTINGS_RESPONSE
      if (cmd === Queries.GetTrackerList)
        return {
          effective: ['udp://alpha', 'udp://beta'],
          blacklist: [],
          healthMap: {},
          sourceMap: {},
          lastSyncAt: 0,
          lastProbeAt: 0,
        }
      return undefined
    })
    render(<EffectiveTrackerPanel filter="alpha" />)
    await screen.findByText('udp://alpha')
    expect(screen.queryByText('udp://beta')).not.toBeInTheDocument()
  })
})
