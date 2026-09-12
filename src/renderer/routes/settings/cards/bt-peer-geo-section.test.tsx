import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { Commands } from '@shared/protocol/commands'
import { DEFAULT_GEOIP_SETTINGS } from '@shared/schemas/geoip-settings'
import type { GeoIPStatus } from '@shared/types/geoip'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

const mockInvoke = vi.fn()
const mockOn = vi.fn()
const mockOff = vi.fn()

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: (...args: unknown[]) => mockInvoke(...args),
    on: (...args: unknown[]) => mockOn(...args),
    off: (...args: unknown[]) => mockOff(...args),
    platform: 'darwin',
  },
}))

const SAMPLE_STATUS: GeoIPStatus = {
  enabled: true,
  hasDatabase: true,
  loaded: true,
  lastUpdatedAt: 1_700_000_000_000,
  databaseVersion: 'v1.2026.05',
  sizeBytes: 9_400_000,
  isDownloading: false,
  lastError: null,
}

import { BtPeerGeoSection } from './bt-peer-geo-section'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('BtPeerGeoSection', () => {
  beforeAll(() => {
    // jsdom doesn't implement these; Radix Select needs them.
    if (!HTMLElement.prototype.hasPointerCapture) {
      HTMLElement.prototype.hasPointerCapture = () => false
    }
    if (!HTMLElement.prototype.releasePointerCapture) {
      HTMLElement.prototype.releasePointerCapture = () => {}
    }
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = () => {}
    }
  })

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    mockInvoke.mockReset()
    mockOn.mockReset()
    mockOff.mockReset()
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'query:getSettings') {
        return {
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
      }
      if (channel === 'query:getGeoIPStatus') {
        return { ...SAMPLE_STATUS, enabled: false, hasDatabase: false }
      }
      return undefined
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders the section heading and the enable toggle', async () => {
    render(<BtPeerGeoSection />)
    expect(await screen.findByText(/GeoIP Database/i)).toBeInTheDocument()
    expect(screen.getByText(/Enable IP-to-country lookup/i)).toBeInTheDocument()
  })

  it('persists the enable toggle via UpdateSettings on click', async () => {
    render(<BtPeerGeoSection />)
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('query:getSettings')
    )
    const enableSwitch = screen.getByRole('switch', {
      name: /Enable IP-to-country lookup/i,
    })
    fireEvent.click(enableSwitch)
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
        geoip: { enabled: true },
      })
    })
  })

  it('reveals the custom URL input when source is switched to custom', async () => {
    render(<BtPeerGeoSection />)
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('query:getSettings')
    )
    // Radix Select is gated by `disabled={!enabled}`, so flip the toggle first.
    const enableSwitch = screen.getByRole('switch', {
      name: /Enable IP-to-country lookup/i,
    })
    fireEvent.click(enableSwitch)
    // pointerEventsCheck is disabled because Radix Select sets
    // `pointer-events: none` on the body during portaled-content open transitions
    // and jsdom doesn't model that reliably.
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const trigger = screen.getByRole('combobox')
    await user.click(trigger)
    const customOption = await screen.findByRole('option', {
      name: /Custom URL/i,
    })
    await user.click(customOption)
    expect(
      await screen.findByPlaceholderText(/GeoLite2-Country\.mmdb/i)
    ).toBeInTheDocument()
  })

  it('disables the Update now button when GeoIP is disabled', async () => {
    render(<BtPeerGeoSection />)
    const button = await screen.findByRole('button', { name: /Update now/i })
    expect(button).toBeDisabled()
  })

  it('subscribes to status + progress events on mount', async () => {
    render(<BtPeerGeoSection />)
    await waitFor(() => expect(mockOn).toHaveBeenCalled())
    const channels = mockOn.mock.calls.map((call) => call[0])
    expect(channels).toContain('event:geoipUpdateProgress')
    expect(channels).toContain('event:geoipStatusChanged')
  })

  async function selectCustomSource() {
    const original = mockInvoke.getMockImplementation()
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'query:getSettings')
        return { geoip: { ...DEFAULT_GEOIP_SETTINGS, enabled: true } }
      return original?.(channel)
    })
    render(<BtPeerGeoSection />)
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.click(await screen.findByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: /Custom URL/i }))
    return {
      user,
      input: await screen.findByRole('textbox', { name: /custom.*url/i }),
    }
  }

  it('blocks invalid custom URLs and saves the corrected source and address together before updating', async () => {
    const { user, input } = await selectCustomSource()
    fireEvent.change(input, { target: { value: 'example.com/country.mmdb' } })
    await user.click(screen.getByRole('button', { name: /Update now/i }))
    expect(
      await screen.findByText(
        'Enter a full address starting with http:// or https://.'
      )
    ).toBeVisible()
    expect(mockInvoke).not.toHaveBeenCalledWith(
      Commands.UpdateSettings,
      expect.anything()
    )
    expect(mockInvoke).not.toHaveBeenCalledWith(Commands.UpdateGeoIPDatabase)
    fireEvent.change(input, {
      target: { value: 'https://example.com/country.mmdb' },
    })
    await user.click(screen.getByRole('button', { name: /Update now/i }))
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(Commands.UpdateGeoIPDatabase)
    )
    const saveIndex = mockInvoke.mock.calls.findIndex(
      ([command]) => command === Commands.UpdateSettings
    )
    const updateIndex = mockInvoke.mock.calls.findIndex(
      ([command]) => command === Commands.UpdateGeoIPDatabase
    )
    expect(mockInvoke.mock.calls[saveIndex]).toEqual([
      Commands.UpdateSettings,
      {
        geoip: {
          source: 'custom',
          customUrl: 'https://example.com/country.mmdb',
        },
      },
    ])
    expect(saveIndex).toBeLessThan(updateIndex)
  })

  it('allows disabling GeoIP with an invalid custom URL without saving that draft', async () => {
    const { user, input } = await selectCustomSource()
    fireEvent.change(input, { target: { value: 'broken address' } })
    await user.click(
      screen.getByRole('switch', { name: /Enable IP-to-country lookup/i })
    )
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
        geoip: { enabled: false },
      })
    )
    const writes = mockInvoke.mock.calls.filter(
      ([command]) => command === Commands.UpdateSettings
    )
    expect(writes).toEqual([
      [Commands.UpdateSettings, { geoip: { enabled: false } }],
    ])
  })

  it('does not update the database after a save failure and retries the same draft', async () => {
    const { user, input } = await selectCustomSource()
    const original = mockInvoke.getMockImplementation()
    let fail = true
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === Commands.UpdateSettings && fail)
        throw new Error('internal transport error')
      return original?.(channel)
    })
    fireEvent.change(input, {
      target: { value: 'https://example.com/country.mmdb' },
    })
    await user.click(screen.getByRole('button', { name: /Update now/i }))
    expect(
      await screen.findByText('Couldn’t save your changes. Try again.')
    ).toBeVisible()
    expect(mockInvoke).not.toHaveBeenCalledWith(Commands.UpdateGeoIPDatabase)
    fail = false
    await user.click(screen.getByRole('button', { name: /Update now/i }))
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(Commands.UpdateGeoIPDatabase)
    )
  })
})
