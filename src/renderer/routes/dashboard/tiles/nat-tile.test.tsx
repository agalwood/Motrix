import '@testing-library/jest-dom/vitest'
import { i18n } from '@renderer/lib/i18n'
import { ErrorCode } from '@shared/errors'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { Commands } from '@shared/protocol/commands'
import {
  NatPortReachability,
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

  it('shows the Active state label', () => {
    natState.status = makeStatus({ state: NatState.Active })
    const { container } = render(<NatTile viewport={COMPACT} />)
    const stateLabel = screen.getByText('Active')
    expect(stateLabel).toBeInTheDocument()
    expect(stateLabel.parentElement).toHaveClass(
      'h-8',
      'text-[22px]',
      'leading-none'
    )
    expect(stateLabel).toHaveClass('leading-[26px]')
    expect(screen.getByTestId('nat-hero')).toContainElement(
      container.querySelector('[data-slot="status-dot"]')
    )
    expect(
      container.querySelector('[data-slot="status-dot"]')
    ).not.toHaveAttribute('data-pulse')
  })

  it('pulses only while NAT is transitioning', () => {
    natState.status = makeStatus({ state: NatState.Discovering })
    const { container, rerender } = render(<NatTile viewport={COMPACT} />)

    const dot = container.querySelector('[data-slot="status-dot"]')
    expect(dot).toHaveAttribute('data-bucket', 'settingUp')
    expect(dot).toHaveAttribute('data-pulse', 'true')
    expect(dot).toHaveClass('bg-blue-500')

    natState.status = makeStatus({
      state: NatState.Failed,
      retryAttempt: 3,
      maxRetries: 3,
    })
    rerender(<NatTile viewport={COMPACT} />)

    expect(dot).toHaveAttribute('data-bucket', 'failed')
    expect(dot).not.toHaveAttribute('data-pulse')
    expect(dot).toHaveClass('bg-red-500')
  })

  it('localizes the state label to Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    natState.status = makeStatus({ state: NatState.Active })
    render(<NatTile viewport={COMPACT} />)
    expect(screen.getByText('已激活')).toBeInTheDocument()
  })

  it('shows the retry counter while retrying', () => {
    natState.status = makeStatus({
      state: NatState.Failed,
      retryAttempt: 2,
      maxRetries: 3,
    })
    render(<NatTile viewport={COMPACT} />)
    expect(screen.getByText('Retrying 2/3')).toBeInTheDocument()
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
    const controls = screen.getByRole('group', { name: 'NAT controls' })
    expect(screen.getByTestId('nat-hero')).toContainElement(controls)
    expect(summary).not.toContainElement(controls)
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
      'col-span-2'
    )
  })

  it('keeps the featured metric and two-column hierarchy when tall', () => {
    render(<NatTile viewport={TALL_DETAILED} />)

    expect(screen.getByTestId('nat-details')).toHaveClass('grid-cols-2')
    expect(screen.getByTestId('nat-details')).toHaveAttribute(
      'data-orientation',
      'tall'
    )
    expect(screen.getByTestId('nat-metric-external-ip')).toHaveClass(
      'col-span-2'
    )
  })

  it('keeps only the toggle in compact and uses concise focus action text', () => {
    const { rerender } = render(<NatTile viewport={COMPACT} />)

    expect(screen.queryByTestId('nat-actions')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Disable NAT' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Run diagnostic' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'NAT settings' })
    ).not.toBeInTheDocument()

    rerender(<NatTile viewport={FOCUS} />)

    expect(screen.getByTestId('nat-actions').children).toHaveLength(3)
    expect(
      screen.getByRole('group', { name: 'NAT controls' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'NAT settings' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Disable NAT' })
    ).toHaveTextContent(/^Disable$/)
    expect(
      screen.getByRole('button', { name: 'Force remap' })
    ).toHaveTextContent(/^Remap$/)
    expect(
      screen.getByRole('button', { name: 'Run diagnostic' })
    ).toHaveTextContent(/^Diagnose$/)
  })

  it('localizes concise focus action text without shortening accessible names', async () => {
    await i18n.changeLanguage('zh-CN')
    render(<NatTile viewport={FOCUS} />)

    expect(screen.getByRole('button', { name: '禁用 NAT' })).toHaveTextContent(
      /^禁用$/
    )
    expect(
      screen.getByRole('button', { name: '强制重映射' })
    ).toHaveTextContent(/^重映射$/)
    expect(screen.getByRole('button', { name: '运行诊断' })).toHaveTextContent(
      /^诊断$/
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

  it('runs a diagnostic when the diagnose action is clicked', () => {
    render(<NatTile viewport={SQUARE_DETAILED} />)
    fireEvent.click(screen.getByRole('button', { name: 'Run diagnostic' }))
    expect(mockInvoke).toHaveBeenCalledWith(Commands.RunNatDiagnostic)
  })

  it('forces a remap when the remap action is clicked', () => {
    render(<NatTile viewport={SQUARE_DETAILED} />)
    fireEvent.click(screen.getByRole('button', { name: 'Force remap' }))
    expect(mockInvoke).toHaveBeenCalledWith(Commands.ForceRemapNat)
  })

  it('disables NAT via the toggle when running', () => {
    natState.status = makeStatus({ state: NatState.Active })
    render(<NatTile viewport={COMPACT} />)
    fireEvent.click(screen.getByRole('button', { name: 'Disable NAT' }))
    expect(mockInvoke).toHaveBeenCalledWith(Commands.DisableNat)
  })

  it('enables NAT via the toggle when stopped', () => {
    natState.status = makeStatus({ state: NatState.Stopped })
    render(<NatTile viewport={COMPACT} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enable NAT' }))
    expect(mockInvoke).toHaveBeenCalledWith(Commands.EnableNat)
  })

  it('offers the official troubleshooting guide in the terminal failed state', () => {
    natState.status = makeStatus({
      state: NatState.Failed,
      retryAttempt: 3,
      maxRetries: 3,
    })
    render(<NatTile viewport={SQUARE_DETAILED} />)

    fireEvent.click(
      screen.getByRole('button', { name: 'NAT troubleshooting guide' })
    )
    expect(openExternalMock).toHaveBeenCalledWith(
      EXTERNAL_URLS.motrix.manual.natTroubleshooting.en
    )
  })

  it('toasts when a command is rate limited', async () => {
    mockInvoke.mockResolvedValue({ ok: false, error: ErrorCode.IpcRateLimited })
    render(<NatTile viewport={SQUARE_DETAILED} />)
    fireEvent.click(screen.getByRole('button', { name: 'Run diagnostic' }))
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
