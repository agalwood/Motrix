import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { DEFAULT_SPEED_LIMIT_SETTINGS } from '@shared/schemas/speed-limit'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadsDialog } from './downloads-dialog'

const { toastAddMock } = vi.hoisted(() => ({ toastAddMock: vi.fn() }))

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn() },
}))

vi.mock('@renderer/components/ui/toast', () => ({
  toast: { add: toastAddMock, close: vi.fn() },
}))

// Base UI Switch needs ResizeObserver in jsdom.
// The turtle="auto" sub-section renders Switches, so polyfill it here.
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
    maxConcurrentDownloads: 5,
    maxConnectionPerServer: 16,
    split: 16,
    minSplitSize: 10485760,
    userAgent: 'Motrix/2.0',
    connectTimeout: 30,
    socketTimeout: 30,
    maxTries: 5,
    retryWait: 10,
    lowestSpeedLimit: 0,
    dnsMode: 'auto',
    fileAllocation: 'none',
    diskCache: 67108864,
    sessionSaveInterval: 15,
    magnetResolveTimeout: 120,
    listenPort: 6881,
    dhtListenPort: 6881,
    dhtEnabled: true,
    btMaxPeers: 128,
    btEnableLpd: true,
    seedRatio: 1,
    seedTime: 60,
    rpcPort: 16800,
    rpcSecret: 'x',
    sqlite3Persistence: true,
    sqlite3DbPath: '',
    sqlite3HistoryLimit: -1,
  },
  speedLimit: DEFAULT_SPEED_LIMIT_SETTINGS,
}

describe('<DownloadsDialog>', () => {
  beforeEach(() => {
    vi.mocked(transport.invoke).mockReset()
    toastAddMock.mockReset()
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetSettings) return FIXTURE
      return { saved: true, requiresRestart: false, changedRestartKeys: [] }
    })
  })

  it('hydrates and submits dirty fields without restart confirm for non-RESTART change', async () => {
    const onClose = vi.fn()
    render(
      <DownloadsDialog
        open
        onClose={onClose}
        labelKey="settings.cards.downloads.title"
        descKey="settings.cards.downloads.desc"
      />
    )
    // Multiple inputs hydrate to "5" (maxConcurrentDownloads + maxTries),
    // so disambiguate by the unique min/max bounds of maxConcurrentDownloads.
    await waitFor(() => {
      const inputs = screen
        .getAllByDisplayValue('5')
        .filter((el) => el.getAttribute('min') === '1')
      expect(inputs.length).toBe(1)
    })
    const concurrent = screen
      .getAllByDisplayValue('5')
      .find((el) => el.getAttribute('min') === '1') as HTMLInputElement
    fireEvent.change(concurrent, { target: { value: '10' } })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /apply/i }))
    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      engine: { maxConcurrentDownloads: 10 },
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('renders the speed modes with user-facing names', async () => {
    render(
      <DownloadsDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.downloads.title"
        descKey="settings.cards.downloads.desc"
      />
    )
    await waitFor(() => {
      const inputs = screen
        .getAllByDisplayValue('5')
        .filter((el) => el.getAttribute('min') === '1')
      expect(inputs.length).toBe(1)
    })
    expect(
      screen.getByRole('button', { name: /^standard$/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /^low speed$/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /^automatic$/i })
    ).toBeInTheDocument()
  })

  it('changing dns resolution submits an engine dnsMode patch', async () => {
    const onClose = vi.fn()
    render(
      <DownloadsDialog
        open
        onClose={onClose}
        labelKey="settings.cards.downloads.title"
        descKey="settings.cards.downloads.desc"
      />
    )
    await waitFor(() => {
      const inputs = screen
        .getAllByDisplayValue('5')
        .filter((el) => el.getAttribute('min') === '1')
      expect(inputs.length).toBe(1)
    })
    const user = userEvent.setup()
    await user.click(screen.getByRole('combobox', { name: /dns resolution/i }))
    await user.click(
      await screen.findByRole('option', { name: /system resolver/i })
    )
    await user.click(screen.getByRole('button', { name: /apply/i }))
    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      engine: { dnsMode: 'system' },
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('changing the base download limit submits a base patch', async () => {
    const onClose = vi.fn()
    render(
      <DownloadsDialog
        open
        onClose={onClose}
        labelKey="settings.cards.downloads.title"
        descKey="settings.cards.downloads.desc"
      />
    )
    await waitFor(() => {
      const inputs = screen
        .getAllByDisplayValue('5')
        .filter((el) => el.getAttribute('min') === '1')
      expect(inputs.length).toBe(1)
    })
    const user = userEvent.setup()
    const baseDown = screen.getByLabelText(
      /standard download limit/i
    ) as HTMLInputElement
    // 1024 KB/s → bytes/sec: 1024 * 1024 = 1_048_576.
    fireEvent.change(baseDown, { target: { value: '1024' } })
    await user.click(screen.getByRole('button', { name: /apply/i }))
    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      speedLimit: { base: { download: 1024 * 1024 } },
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('switching the turtle state to auto submits a turtle patch', async () => {
    const onClose = vi.fn()
    render(
      <DownloadsDialog
        open
        onClose={onClose}
        labelKey="settings.cards.downloads.title"
        descKey="settings.cards.downloads.desc"
      />
    )
    await waitFor(() => {
      const inputs = screen
        .getAllByDisplayValue('5')
        .filter((el) => el.getAttribute('min') === '1')
      expect(inputs.length).toBe(1)
    })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^automatic$/i }))
    await user.click(screen.getByRole('button', { name: /apply/i }))
    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      speedLimit: { turtle: 'auto' },
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('explains an automatic mode with no rules and localizes weekdays', async () => {
    render(
      <DownloadsDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.downloads.title"
        descKey="settings.cards.downloads.desc"
      />
    )
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /^automatic$/i })
      ).toBeInTheDocument()
    })

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^automatic$/i }))
    expect(
      screen.getByText(/no automatic rules are enabled/i)
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole('switch', {
        name: /use low-speed limits on a schedule/i,
      })
    )
    expect(screen.getByRole('button', { name: 'Sunday' })).toHaveTextContent(
      'Sun'
    )
    await user.click(screen.getByRole('button', { name: 'Sunday' }))
    expect(screen.getByRole('button', { name: 'Sunday' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.getByRole('button', { name: 'Monday' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByText(/24-hour format \(HH:mm\)/i)).toBeInTheDocument()

    const startTime = screen.getByLabelText(/^start$/i)
    const endTime = screen.getByLabelText(/^end$/i)
    expect(startTime).toHaveAttribute('type', 'text')
    expect(startTime).toHaveAttribute('inputmode', 'numeric')
    expect(startTime).toHaveAttribute('placeholder', 'HH:mm')
    expect(startTime).toHaveValue('23:00')
    expect(endTime).toHaveValue('07:00')

    fireEvent.change(startTime, { target: { value: '2130' } })
    expect(startTime).toHaveValue('21:30')
    expect(
      screen.getByText(/use low-speed limits from 21:30 to 07:00/i)
    ).toBeInTheDocument()
  })

  it('shows reserved bandwidth while storing Motrix usage percent', async () => {
    const onClose = vi.fn()
    render(
      <DownloadsDialog
        open
        onClose={onClose}
        labelKey="settings.cards.downloads.title"
        descKey="settings.cards.downloads.desc"
      />
    )
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /^automatic$/i })
      ).toBeInTheDocument()
    })

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^automatic$/i }))
    await user.click(
      screen.getByRole('switch', {
        name: /avoid using the entire connection/i,
      })
    )
    expect(
      screen.getByText(
        /reserve 20% of bandwidth for other apps after connection bandwidth is entered/i
      )
    ).toBeInTheDocument()

    const reserved = screen.getByLabelText(
      /reserve for other apps/i
    ) as HTMLInputElement
    expect(reserved).toHaveValue(20)
    fireEvent.change(reserved, { target: { value: '30' } })

    await user.click(screen.getByRole('button', { name: /apply/i }))
    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      speedLimit: {
        turtle: 'auto',
        auto: {
          adaptive: {
            enabled: true,
            headroomPercent: 70,
          },
        },
      },
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('reports when recent speed estimation has no data', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetSettings) return FIXTURE
      if (channel === Queries.GetSpeedHistory) return []
      return { saved: true, requiresRestart: false, changedRestartKeys: [] }
    })
    render(
      <DownloadsDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.downloads.title"
        descKey="settings.cards.downloads.desc"
      />
    )
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /^automatic$/i })
      ).toBeInTheDocument()
    })

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^automatic$/i }))
    await user.click(
      screen.getByRole('switch', {
        name: /avoid using the entire connection/i,
      })
    )
    await user.click(
      screen.getByRole('button', { name: /estimate from recent speeds/i })
    )

    await waitFor(() => {
      expect(toastAddMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringMatching(/no speed history is available/i),
          type: 'info',
        })
      )
    })
  })
})
