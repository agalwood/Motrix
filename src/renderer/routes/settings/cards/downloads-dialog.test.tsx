import '@testing-library/jest-dom/vitest'
import { i18n } from '@renderer/lib/i18n'
import { transport } from '@renderer/lib/transport'
import { ENGINE_PERFORMANCE_PROFILES } from '@shared/constants/engine-performance-profiles'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { MAX_CONNECTIONS_PER_SERVER } from '@shared/schemas/engine-settings'
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
    performanceProfile: 'auto',
    maxConcurrentDownloads: 5,
    maxConnectionPerServer: MAX_CONNECTIONS_PER_SERVER,
    split: 16,
    minSplitSize: 4 * 1024 * 1024,
    userAgent: 'Motrix/2.0',
    connectTimeout: 30,
    socketTimeout: 30,
    maxTries: 5,
    retryWait: 10,
    lowestSpeedLimit: 0,
    fileAllocation: 'none',
    remoteTime: false,
    diskCache: 32 * 1024 * 1024,
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
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
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
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      engine: { maxConcurrentDownloads: 10 },
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('exposes the Motrix aria2 connection limit in the performance settings', async () => {
    render(
      <DownloadsDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.downloads.title"
        descKey="settings.cards.downloads.desc"
      />
    )

    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('combobox', { name: /performance profile/i })
    )
    await user.click(await screen.findByRole('option', { name: /^custom$/i }))

    const input = screen.getByLabelText(/max connections per server/i)
    expect(input).toHaveValue(MAX_CONNECTIONS_PER_SERVER)
    expect(input).toHaveAttribute('max', String(MAX_CONNECTIONS_PER_SERVER))
    expect(
      screen.getAllByRole('button', {
        name: String(MAX_CONNECTIONS_PER_SERVER),
      }).length
    ).toBeGreaterThan(0)
  })

  it('links the high-speed profile to all performance parameters', async () => {
    render(
      <DownloadsDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.downloads.title"
        descKey="settings.cards.downloads.desc"
      />
    )

    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('combobox', { name: /performance profile/i })
    )
    await user.click(
      await screen.findByRole('option', { name: /^high speed$/i })
    )
    expect(screen.getAllByText('32')).toHaveLength(2)
    expect(screen.getByText(/per server/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      engine: {
        performanceProfile: 'high',
        maxConnectionPerServer:
          ENGINE_PERFORMANCE_PROFILES.high.maxConnectionPerServer,
        split: ENGINE_PERFORMANCE_PROFILES.high.split,
        diskCache: ENGINE_PERFORMANCE_PROFILES.high.diskCache,
      },
    })
  })

  it('places custom performance parameters before concurrent downloads', async () => {
    render(
      <DownloadsDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.downloads.title"
        descKey="settings.cards.downloads.desc"
      />
    )

    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('combobox', { name: /performance profile/i })
    )
    await user.click(await screen.findByRole('option', { name: /^custom$/i }))

    const customParameters = screen.getByText(/custom performance parameters/i)
    const concurrentDownloads = screen.getByText(/max concurrent downloads/i)
    expect(
      customParameters.compareDocumentPosition(concurrentDownloads) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('saves split, file allocation, and disk cache as explicit user values', async () => {
    render(
      <DownloadsDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.downloads.title"
        descKey="settings.cards.downloads.desc"
      />
    )
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('combobox', { name: /performance profile/i })
    )
    await user.click(await screen.findByRole('option', { name: /^custom$/i }))

    expect(screen.getByLabelText(/split connections per file/i)).toHaveValue(16)

    fireEvent.change(screen.getByLabelText(/split connections per file/i), {
      target: { value: '32' },
    })
    fireEvent.change(screen.getByLabelText(/disk cache/i), {
      target: { value: '64' },
    })
    await user.click(screen.getByRole('combobox', { name: /file allocation/i }))
    await user.click(await screen.findByRole('option', { name: /^prealloc$/i }))
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      engine: {
        performanceProfile: 'custom',
        split: 32,
        fileAllocation: 'prealloc',
        diskCache: 64 * 1024 * 1024,
      },
    })
    expect(screen.queryByText(/restart to apply changes/i)).toBeNull()
  })

  it('selects the file modification time source and submits the aria2 setting', async () => {
    render(
      <DownloadsDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.downloads.title"
        descKey="settings.cards.downloads.desc"
      />
    )

    const user = userEvent.setup()
    const modifiedTime = await screen.findByRole('combobox', {
      name: /file modification time/i,
    })
    expect(modifiedTime).toHaveTextContent(/^local$/i)
    expect(modifiedTime).toHaveClass('min-w-30', 'max-w-64')
    expect(modifiedTime).not.toHaveClass('w-30')

    await user.click(modifiedTime)
    await user.click(await screen.findByRole('option', { name: /^server$/i }))
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      engine: { remoteTime: true },
    })
  })

  it('allows the localized file modification value to size intrinsically', async () => {
    await i18n.changeLanguage('zh-CN')
    render(
      <DownloadsDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.downloads.title"
        descKey="settings.cards.downloads.desc"
      />
    )

    const modifiedTime = await screen.findByRole('combobox', {
      name: '文件修改时间',
    })
    expect(modifiedTime).toHaveTextContent('本地修改时间')
    expect(modifiedTime).toHaveClass('min-w-30', 'max-w-64')
    expect(modifiedTime).not.toHaveClass('w-30')
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

  it('places compact speed limits between performance and reliability', async () => {
    render(
      <DownloadsDialog
        open
        onClose={vi.fn()}
        labelKey="settings.cards.downloads.title"
        descKey="settings.cards.downloads.desc"
      />
    )

    const standard = await screen.findByRole('button', { name: /^standard$/i })
    const performance = screen.getByRole('heading', { name: 'Performance' })
    const speedLimits = screen.getByRole('heading', { name: 'Speed limits' })
    const reliability = screen.getByRole('heading', {
      name: 'Network reliability',
    })
    const follows = (first: Element, second: Element) =>
      Boolean(
        first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING
      )

    expect(follows(performance, speedLimits)).toBe(true)
    expect(follows(speedLimits, reliability)).toBe(true)

    const modeGroup = screen.getByRole('group', { name: 'Current mode' })
    expect(modeGroup).toHaveClass(
      'gap-0',
      'rounded-lg',
      'bg-tab-background',
      'p-[3px]'
    )
    expect(standard).toHaveAttribute('data-slot', 'toggle-group-item')
    expect(standard).toHaveAttribute('aria-pressed', 'true')
    expect(standard).toHaveClass('h-7', 'text-xs', 'shadow-none')
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
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      speedLimit: { base: { download: 1024 * 1024 } },
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('groups compact reset actions with their speed limit inputs', async () => {
    vi.mocked(transport.invoke).mockImplementation(async (channel) => {
      if (channel === Queries.GetSettings) {
        return {
          ...FIXTURE,
          speedLimit: {
            ...DEFAULT_SPEED_LIMIT_SETTINGS,
            base: {
              ...DEFAULT_SPEED_LIMIT_SETTINGS.base,
              download: 1024 * 1024,
            },
          },
        }
      }
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

    const user = userEvent.setup()
    const baseDown = (await screen.findByLabelText(
      /standard download limit/i
    )) as HTMLInputElement
    const altDown = screen.getByLabelText(
      /low-speed download limit/i
    ) as HTMLInputElement
    const setUnlimited = screen.getByRole('button', {
      name: /set unlimited/i,
    })
    const useStandard = screen
      .getAllByRole('button', { name: /use standard limit/i })
      .find((button) =>
        button.closest('[data-slot="button-group"]')?.contains(altDown)
      )

    const standardGroup = setUnlimited.closest('[data-slot="button-group"]')
    expect(standardGroup).toContainElement(baseDown)
    expect(standardGroup).toHaveClass('w-40')
    expect(useStandard).toBeDefined()

    await user.click(setUnlimited)
    await user.click(useStandard as HTMLElement)

    expect(baseDown).toHaveValue('')
    expect(baseDown).toHaveAttribute('placeholder', 'Unlimited')
    expect(altDown).toHaveValue('')
    expect(altDown).toHaveAttribute('placeholder', 'Standard limit')

    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(transport.invoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
      speedLimit: {
        base: { download: 0 },
        alt: { download: 0 },
      },
    })
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
    await user.click(screen.getByRole('button', { name: /save/i }))
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

    await user.click(screen.getByRole('button', { name: /save/i }))
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
