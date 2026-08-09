import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import type { GeoIPStatus } from '@shared/types/geoip'
import type { TaskPeer } from '@shared/types/peer'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// Tests mock the hooks; PeersTab only reads task.id and task.status.
const makeTask = (id: string, status = TaskStatus.Downloading) =>
  makeDownloadTask({ id, status })

const samplePeers: TaskPeer[] = [
  {
    id: '203.0.113.10:6881',
    ip: '203.0.113.10',
    port: 6881,
    client: 'qBittorrent',
    clientVersion: '4.6.7',
    progress: 1,
    downSpeed: 524288,
    upSpeed: 0,
    seeder: true,
    amChoking: false,
    peerChoking: false,
  },
  {
    id: '198.51.100.5:51413',
    ip: '198.51.100.5',
    port: 51413,
    client: 'Transmission',
    clientVersion: '4.0.0',
    progress: 0.42,
    downSpeed: 0,
    upSpeed: 16384,
    seeder: false,
    amChoking: false,
    peerChoking: true,
  },
]

const baseStatus: GeoIPStatus = {
  enabled: false,
  hasDatabase: false,
  loaded: false,
  lastUpdatedAt: 0,
  databaseVersion: '',
  sizeBytes: 0,
  isDownloading: false,
  lastError: null,
}

let mockGeoStatus: GeoIPStatus = baseStatus

vi.mock('@renderer/hooks/use-task-peers', () => ({
  useTaskPeers: () => ({ peers: samplePeers }),
}))
vi.mock('@renderer/hooks/use-geoip-status', () => ({
  useGeoIPStatus: () => ({
    status: mockGeoStatus,
    progress: null,
    triggerUpdate: vi.fn(),
    refresh: vi.fn(),
  }),
}))

import { clientLabel, flagsString, PeerRow, PeersTab } from './peers-tab'

describe('flagsString', () => {
  it('returns DUS when peer is uploading to us, we are uploading to them, and they are a seeder', () => {
    expect(
      flagsString({
        ...samplePeers[0],
        peerChoking: false,
        amChoking: false,
        seeder: true,
      })
    ).toBe('DUS')
  })

  it('returns underscores for inactive states', () => {
    expect(
      flagsString({
        ...samplePeers[0],
        peerChoking: true,
        amChoking: true,
        seeder: false,
      })
    ).toBe('___')
  })

  it('marks half-active connection correctly', () => {
    expect(
      flagsString({
        ...samplePeers[0],
        peerChoking: true,
        amChoking: false,
        seeder: false,
      })
    ).toBe('_U_')
  })
})

describe('clientLabel', () => {
  it('joins name and version when both are present', () => {
    expect(clientLabel(samplePeers[0])).toBe('qBittorrent 4.6.7')
  })

  it('returns name alone when version is null', () => {
    expect(clientLabel({ ...samplePeers[0], clientVersion: null })).toBe(
      'qBittorrent'
    )
  })

  it('returns dash when client is unknown', () => {
    expect(
      clientLabel({ ...samplePeers[0], client: null, clientVersion: null })
    ).toBe('—')
  })
})

describe('PeerRow', () => {
  it('renders the endpoint, client, and flags', () => {
    const { container } = render(
      <PeerRow peer={samplePeers[0]} locale="en" showCountry={false} />
    )
    expect(container.textContent).toContain('203.0.113.10')
    expect(container.textContent).toContain('6881')
    expect(container.textContent).toContain('qBittorrent 4.6.7')
    expect(container.textContent).toContain('DUS')
    expect(container.textContent).toContain('100%')
  })

  it('shows a dash for zero speeds', () => {
    const { container } = render(
      <PeerRow peer={samplePeers[1]} locale="en" showCountry={false} />
    )
    // upSpeed > 0 → shows formatted bytes; downSpeed = 0 → dash
    expect(container.textContent).toContain('—')
    expect(container.textContent).toContain('16.0 KB/s')
  })

  it('renders the country flag and code when showCountry is true and peer.country is present', () => {
    const { container } = render(
      <PeerRow
        peer={{
          ...samplePeers[0],
          country: { code: 'US', name: 'United States' },
        }}
        locale="en"
        showCountry
      />
    )
    expect(container.textContent).toContain('🇺🇸')
    expect(container.textContent).toContain('US')
  })

  it('omits the country cells entirely when showCountry is false', () => {
    const { container } = render(
      <PeerRow
        peer={{
          ...samplePeers[0],
          country: { code: 'US', name: 'United States' },
        }}
        locale="en"
        showCountry={false}
      />
    )
    expect(container.textContent).not.toContain('🇺🇸')
    expect(container.textContent).not.toMatch(/\bUS\b/)
  })
})

describe('PeersTab — GeoIP disabled', () => {
  it('shows the peer-count summary including seeders', () => {
    mockGeoStatus = baseStatus
    const { container } = render(<PeersTab task={makeTask('t-1')} />)
    expect(container.textContent).toMatch(/2 peers/)
    expect(container.textContent).toMatch(/1 seeder/)
  })

  it('does not render the country column header when GeoIP is disabled', () => {
    mockGeoStatus = baseStatus
    const { queryByText, getByText } = render(
      <PeersTab task={makeTask('t-1')} />
    )
    expect(queryByText(/^Geo$/)).not.toBeInTheDocument()
    expect(getByText(/IP : Port/)).toBeInTheDocument()
  })
})

describe('PeersTab — GeoIP enabled', () => {
  it('renders the country column header when GeoIP is enabled', () => {
    mockGeoStatus = { ...baseStatus, enabled: true }
    const { getByText } = render(<PeersTab task={makeTask('t-1')} />)
    expect(getByText(/^Geo$/)).toBeInTheDocument()
    expect(getByText(/IP : Port/)).toBeInTheDocument()
  })
})

describe('PeersTab empty state', () => {
  it('shows empty placeholder when there are no peers', async () => {
    vi.resetModules()
    vi.doMock('@renderer/hooks/use-task-peers', () => ({
      useTaskPeers: () => ({ peers: [] }),
    }))
    vi.doMock('@renderer/hooks/use-geoip-status', () => ({
      useGeoIPStatus: () => ({
        status: baseStatus,
        progress: null,
        triggerUpdate: vi.fn(),
        refresh: vi.fn(),
      }),
    }))
    const { PeersTab: EmptyPeersTab } = await import('./peers-tab')
    const { getByText } = render(<EmptyPeersTab task={makeTask('t-2')} />)
    expect(getByText(/No peers connected/)).toBeInTheDocument()
  })
})
