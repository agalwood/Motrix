import '@testing-library/jest-dom/vitest'
import { i18n } from '@renderer/lib/i18n'
import { ErrorCode } from '@shared/errors'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { Commands } from '@shared/protocol/commands'
import {
  NatPortReachability,
  NatProtocol,
  NatState,
  type NatStatus,
  NatType,
} from '@shared/types/nat'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardTileViewport } from '../layout/dashboard-registry'

const { mockInvoke, openExternalMock, toastAddMock } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  openExternalMock: vi.fn(),
  toastAddMock: vi.fn(),
}))
const natState = vi.hoisted(() => ({ status: null as NatStatus | null }))

vi.mock('react-router', async () => {
  const actual = (await vi.importActual('react-router')) as object
  return {
    ...actual,
    Link: ({
      children,
      to,
      ...props
    }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  }
})

vi.mock('@renderer/hooks/use-nat-status', () => ({
  useNatStatus: () => natState.status,
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: mockInvoke,
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))

vi.mock('@renderer/components/ui/toast', () => ({
  toast: { add: toastAddMock, close: vi.fn() },
}))

vi.mock('@renderer/platform/services', () => ({
  usePlatformServices: () => ({ openExternal: openExternalMock }),
}))

const { NatTile } = await import('./nat-tile')

const COMPACT = {
  span: { w: 1, h: 1 },
  orientation: 'square',
  contentLevel: 'compact',
} satisfies DashboardTileViewport

const SUMMARY = {
  span: { w: 2, h: 1 },
  orientation: 'wide',
  contentLevel: 'summary',
} satisfies DashboardTileViewport

const TALL_DETAILED = {
  span: { w: 1, h: 2 },
  orientation: 'tall',
  contentLevel: 'detailed',
} satisfies DashboardTileViewport

const SQUARE_DETAILED = {
  span: { w: 2, h: 2 },
  orientation: 'square',
  contentLevel: 'detailed',
} satisfies DashboardTileViewport

const FOCUS = {
  span: { w: 2, h: 3 },
  orientation: 'tall',
  contentLevel: 'focus',
} satisfies DashboardTileViewport

function makeStatus(overrides: Partial<NatStatus> = {}): NatStatus {
  return {
    state: NatState.Active,
    enabled: true,
    activeMappings: [],
    gatewayInfo: null,
    lastError: null,
    lastDiagnostic: null,
    retryAttempt: 0,
    maxRetries: 3,
    ...overrides,
  }
}

describe('NatTile', () => {
  beforeEach(() => {
    mockInvoke.mockReset().mockResolvedValue({ ok: true })
    openExternalMock.mockReset()
    toastAddMock.mockReset()
    natState.status = makeStatus()
  })

  afterEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('renders the tile title', () => {
    render(<NatTile viewport={COMPACT} />)
    expect(screen.getByText('NAT')).toBeInTheDocument()
  })

  it('uses a concise compact label and the Engine tile status dot in the footer', () => {
    natState.status = makeStatus({ state: NatState.Active })
    const { container } = render(<NatTile viewport={COMPACT} />)
    const stateLabel = screen.getByText('Mapped')
    expect(stateLabel).toBeInTheDocument()
    expect(stateLabel.parentElement).toHaveClass('text-[22px]', 'h-8')
    expect(stateLabel).toHaveClass('leading-[26px]')
    expect(screen.getByTestId('nat-hero')).not.toContainElement(
      container.querySelector('[data-slot="status-dot"]')
    )
    expect(container.querySelector('[data-slot="status-dot"]')).toHaveAttribute(
      'data-pulse',
      'true'
    )
  })

  it('pulses while mapping and settles to a neutral dot after retries are exhausted', () => {
    natState.status = makeStatus({ state: NatState.Discovering })
    const { container, rerender } = render(<NatTile viewport={COMPACT} />)
    expect(screen.getByText('Mapping')).toBeInTheDocument()
    const dot = container.querySelector('[data-slot="status-dot"]')
    expect(dot).toHaveClass('status-dot', 'bg-amber-500')
    expect(dot).toHaveAttribute('data-pulse', 'true')

    natState.status = makeStatus({
      state: NatState.Failed,
      retryAttempt: 3,
      maxRetries: 3,
    })
    rerender(<NatTile viewport={COMPACT} />)
    const settledDot = container.querySelector('[data-slot="status-dot"]')
    expect(settledDot).not.toHaveAttribute('data-pulse')
    expect(settledDot).toHaveAttribute('data-bucket', 'failed')
    expect(settledDot).toHaveClass('bg-muted-foreground/40')
    expect(screen.getByText('Mapping')).toBeInTheDocument()
    expect(screen.queryByText('Failed')).not.toBeInTheDocument()
  })

  it('localizes the state label to Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    natState.status = makeStatus({ state: NatState.Active })
    render(<NatTile viewport={COMPACT} />)
    expect(screen.getByText('已映射')).toBeInTheDocument()
  })

  it('keeps retries in the menu and does not offer another attempt while retrying', async () => {
    natState.status = makeStatus({
      state: NatState.Failed,
      retryAttempt: 2,
      maxRetries: 3,
    })
    render(<NatTile viewport={COMPACT} />)
    expect(screen.getByText('Mapping')).toBeInTheDocument()
    expect(screen.queryByText(/Automatic retries/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'NAT controls' }))
    expect(await screen.findByText('Automatic retries (2/3)')).toBeVisible()
    expect(
      screen.queryByRole('menuitem', { name: 'Retry' })
    ).not.toBeInTheDocument()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('shows the Off label when NAT status is unavailable', () => {
    natState.status = null
    render(<NatTile viewport={COMPACT} />)
    expect(screen.getByText('Off')).toBeInTheDocument()
  })

  it('shows a health summary without the detailed diagnostics', () => {
    natState.status = makeStatus({
      lastDiagnostic: {
        runAt: Date.now(),
        natType: NatType.PortRestricted,
        gatewayInfo: null,
        portReachability: {
          btListenPort: NatPortReachability.Unknown,
          dhtListenPort: NatPortReachability.Unknown,
        },
        protocolAvailability: { pcp: true, natpmp: true, upnp: true },
        healthScore: 'good',
        recommendations: [],
      },
    })

    render(<NatTile viewport={SUMMARY} />)

    const summary = screen.getByTestId('nat-summary')
    expect(summary).toHaveTextContent('Health')
    expect(summary).toHaveTextContent('Good')
    expect(summary).toHaveTextContent('Type')
    expect(summary).toHaveTextContent('Port restricted')
    expect(summary).toHaveTextContent('Mappings')
    expect(summary).toHaveTextContent('0 active')
    for (const item of [
      ...within(summary).getAllByRole('term'),
      ...within(summary).getAllByRole('definition'),
    ]) {
      expect(item).not.toHaveClass('truncate')
    }
    expect(screen.queryByTestId('nat-details')).not.toBeInTheDocument()
  })

  it('surfaces full diagnostics in square detailed presentations', () => {
    natState.status = makeStatus({
      state: NatState.Active,
      gatewayInfo: {
        internalIp: '192.168.1.2',
        gatewayIp: '192.168.1.1',
        externalIp: '203.0.113.5',
        controlUrl: null,
        controlHost: null,
        controlPort: null,
        manufacturer: null,
        modelName: null,
        supportedProtocols: [],
      },
      lastDiagnostic: {
        runAt: Date.now(),
        natType: NatType.Open,
        gatewayInfo: null,
        portReachability: {
          btListenPort: NatPortReachability.Unknown,
          dhtListenPort: NatPortReachability.Unknown,
        },
        protocolAvailability: { pcp: true, natpmp: true, upnp: true },
        healthScore: 'good',
        recommendations: [],
      },
    })
    render(<NatTile viewport={SQUARE_DETAILED} />)
    const details = screen.getByTestId('nat-details')
    for (const label of [
      'Health',
      'Type',
      'External IP',
      'Mappings',
      'Last check',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getByText('Good')).toBeInTheDocument()
    expect(screen.getByText('Open')).toBeInTheDocument()
    expect(screen.getByText('203.0.113.5')).toBeInTheDocument()
    expect(details.tagName).toBe('DL')
    expect(details).toHaveClass('grid-cols-2')
    expect(within(details).getAllByRole('term')).toHaveLength(5)
    expect(within(details).getAllByRole('definition')).toHaveLength(5)
    expect(screen.getByTestId('nat-metric-external-ip')).toHaveClass(
      'col-span-full'
    )
  })

  it('stacks diagnostic fields in one column in the narrow tall presentation', () => {
    render(<NatTile viewport={TALL_DETAILED} />)

    expect(screen.getByTestId('nat-details')).toHaveClass('grid-cols-1')
    expect(screen.getByTestId('nat-details')).toHaveAttribute(
      'data-orientation',
      'tall'
    )
    expect(screen.getByTestId('nat-metric-external-ip')).toHaveClass(
      'col-span-full'
    )
  })

  it.each([SUMMARY, TALL_DETAILED, SQUARE_DETAILED, FOCUS])(
    'replaces stale diagnostic fields with a quiet empty state when off in $contentLevel',
    (viewport) => {
      natState.status = makeStatus({
        enabled: false,
        lastDiagnostic: {
          runAt: Date.now(),
          natType: NatType.Open,
          gatewayInfo: null,
          portReachability: {
            btListenPort: NatPortReachability.Reachable,
            dhtListenPort: NatPortReachability.Reachable,
          },
          protocolAvailability: { pcp: true, natpmp: true, upnp: true },
          healthScore: 'good',
          recommendations: [],
        },
      })
      render(<NatTile viewport={viewport} />)

      expect(screen.getByText('Off')).toBeInTheDocument()
      expect(screen.getByTestId('nat-empty')).toHaveTextContent(
        'BT port mapping is off.'
      )
      expect(screen.queryByText('Good')).not.toBeInTheDocument()
      expect(screen.queryByTestId('nat-details')).not.toBeInTheDocument()
      expect(screen.queryByTestId('nat-summary')).not.toBeInTheDocument()
    }
  )

  it('adds protocol and port details only in the full-height presentation', () => {
    natState.status = makeStatus({
      activeMappings: [
        {
          purpose: 'bt-listen',
          protocol: 'TCP',
          method: NatProtocol.Upnp,
          internalPort: 6881,
          externalPort: 16881,
          ttl: 3600,
          expiresAt: Date.now() + 3600_000,
          createdAt: Date.now(),
          lastRenewedAt: Date.now(),
        },
      ],
    })
    const { rerender } = render(<NatTile viewport={SQUARE_DETAILED} />)
    expect(screen.queryByTestId('nat-mapping-list')).not.toBeInTheDocument()

    rerender(<NatTile viewport={FOCUS} />)
    const mappings = screen.getByRole('region', { name: 'Mapped ports' })
    expect(within(mappings).getByText('BitTorrent')).toBeInTheDocument()
    expect(within(mappings).getByText('TCP / UPnP')).toBeInTheDocument()
    expect(
      within(mappings).getByText('Internal 6881 to external 16881')
    ).toBeInTheDocument()
  })

  it.each([COMPACT, SUMMARY, TALL_DETAILED, SQUARE_DETAILED, FOCUS])(
    'offers the same controls in $contentLevel presentations',
    async (viewport) => {
      render(<NatTile viewport={viewport} />)
      expect(screen.queryByTestId('nat-actions')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'NAT controls' }))
      expect(
        await screen.findByRole('menuitem', { name: 'Network settings' })
      ).toHaveAttribute('href', '/settings/network')
      expect(
        screen.getByRole('menuitem', { name: 'Network guide' })
      ).toBeVisible()
      expect(
        screen.getByRole('menuitem', { name: 'Turn off NAT mapping' })
      ).toBeVisible()
      expect(
        screen.queryByRole('menuitem', { name: 'Retry' })
      ).not.toBeInTheDocument()
      expect(
        screen.getByText(/Helps other BT peers connect to you/)
      ).toBeVisible()
    }
  )

  it('localizes the shared menu and guide', async () => {
    await i18n.changeLanguage('zh-CN')
    render(<NatTile viewport={COMPACT} />)
    fireEvent.click(screen.getByRole('button', { name: 'NAT 控制' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '优化网络' }))
    expect(openExternalMock).toHaveBeenCalledWith(
      EXTERNAL_URLS.motrix.manual.natTroubleshooting.zh
    )
  })

  it('wraps long network values instead of hiding their content', () => {
    const ipv6 = '2001:db8:85a3:0000:0000:8a2e:0370:7334'
    natState.status = makeStatus({
      gatewayInfo: {
        internalIp: 'fd00::2',
        gatewayIp: 'fd00::1',
        externalIp: ipv6,
        controlUrl: null,
        controlHost: null,
        controlPort: null,
        manufacturer: null,
        modelName: null,
        supportedProtocols: [],
      },
    })

    render(<NatTile viewport={TALL_DETAILED} />)

    expect(screen.getByText(ipv6)).toHaveClass('break-all')
    expect(screen.getByText(ipv6)).not.toHaveClass('truncate')
    expect(screen.getByText(ipv6)).toHaveAttribute('title', ipv6)
  })

  it('disables NAT from the menu when running', async () => {
    render(<NatTile viewport={COMPACT} />)
    fireEvent.click(screen.getByRole('button', { name: 'NAT controls' }))
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Turn off NAT mapping' })
    )
    expect(mockInvoke).toHaveBeenCalledExactlyOnceWith(Commands.DisableNat)
  })

  it('enables NAT from the menu when disabled even if the last state was active', async () => {
    natState.status = makeStatus({ enabled: false })
    render(<NatTile viewport={COMPACT} />)
    expect(screen.getByText('Off')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'NAT controls' }))
    expect(
      screen.queryByRole('menuitem', { name: 'Turn off NAT mapping' })
    ).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Enable NAT' }))
    expect(mockInvoke).toHaveBeenCalledExactlyOnceWith(Commands.EnableNat)
  })

  it('waits for the status snapshot before offering an enable action', async () => {
    natState.status = null
    render(<NatTile viewport={COMPACT} />)
    fireEvent.click(screen.getByRole('button', { name: 'NAT controls' }))
    expect(
      await screen.findByRole('menuitem', { name: 'Network settings' })
    ).toBeVisible()
    expect(
      screen.queryByRole('menuitem', { name: 'Enable NAT' })
    ).not.toBeInTheDocument()
  })

  it.each([
    ['Retry', Commands.EnableNat],
    ['Turn off NAT mapping', Commands.DisableNat],
  ])(
    'offers %s after the retry budget is exhausted',
    async (action, command) => {
      natState.status = makeStatus({
        state: NatState.Failed,
        retryAttempt: 3,
        maxRetries: 3,
      })
      render(<NatTile viewport={COMPACT} />)
      expect(mockInvoke).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'NAT controls' }))
      expect(
        await screen.findByText('Automatic mapping unavailable')
      ).toBeVisible()
      expect(screen.getByText(/link downloads/)).toBeVisible()
      expect(screen.getByText('Automatic retries (3/3)')).toBeVisible()
      fireEvent.click(screen.getByRole('menuitem', { name: action }))
      expect(mockInvoke).toHaveBeenCalledExactlyOnceWith(command)
    }
  )

  it('offers the official troubleshooting guide in the terminal failed state', async () => {
    natState.status = makeStatus({
      state: NatState.Failed,
      retryAttempt: 3,
      maxRetries: 3,
    })
    render(<NatTile viewport={SQUARE_DETAILED} />)
    fireEvent.click(screen.getByRole('button', { name: 'NAT controls' }))
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Network guide' })
    )
    expect(openExternalMock).toHaveBeenCalledWith(
      EXTERNAL_URLS.motrix.manual.natTroubleshooting.en
    )
  })

  it('toasts when a command is rate limited', async () => {
    mockInvoke.mockResolvedValue({ ok: false, error: ErrorCode.IpcRateLimited })
    render(<NatTile viewport={SQUARE_DETAILED} />)
    fireEvent.click(screen.getByRole('button', { name: 'NAT controls' }))
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Turn off NAT mapping' })
    )
    await waitFor(() =>
      expect(toastAddMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Too frequent — try again shortly',
          type: 'error',
        })
      )
    )
  })
})
