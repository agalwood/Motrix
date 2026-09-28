import '@test-utils/dom-animations'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  EngineFailureReason,
  EngineProcessOwnership,
  EngineRecoveryRecommendation,
  EngineState,
} from '@shared/types/engine'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestEngineDiagnostics } from './controller'

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

const invoke = vi.fn()
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: (...args: unknown[]) => invoke(...args),
  },
}))

const REPORT = {
  state: EngineState.Failed,
  featureReport: {
    version: '1.37.0-motrix.14',
    features: ['Async DNS', 'BitTorrent', 'SQLite3-Persistence'],
    hasBtSeedUnverified: false,
    hasBtSaveMetadata: false,
    hasMoveStorage: false,
    hasSqlitePersistence: true,
  },
  failure: {
    reason: EngineFailureReason.PortInUse,
    occurredAt: 1,
    technicalMessage: 'RPC port 16800 is already in use',
  },
  managedPid: null,
  generatedAt: 1,
  binary: { name: 'aria2c', available: true, version: '1.37.0-motrix.14' },
  rpc: {
    port: 16800,
    available: false,
    expectedListener: false,
    connection: { transport: 'websocket', connected: false },
  },
  process: {
    pid: 4321,
    name: 'aria2c',
    executableName: 'aria2c',
    ownership: EngineProcessOwnership.VerifiedOrphan,
    safeToTerminate: true,
  },
  defaultRpc: {
    port: 16800,
    isCurrent: true,
    available: false,
    process: null,
    canRestore: false,
    requiresTermination: false,
  },
  suggestedRpcPort: null,
  canRetry: false,
  canForceTerminate: true,
  canSwitchPort: false,
  recommendation: EngineRecoveryRecommendation.ForceTerminate,
}

const { EngineDiagnosticsDialogHost } = await import(
  './engine-diagnostics-dialog'
)

function holdClosingAnimation() {
  const animation = Promise.withResolvers<void>()
  const observed = vi.fn()
  vi.spyOn(Element.prototype, 'getAnimations').mockImplementation(function (
    this: Element
  ) {
    if (this.matches('[data-slot="dialog-content"][data-closed]')) {
      observed()
      return [{ finished: animation.promise }] as unknown as Animation[]
    }
    return []
  })
  return { finish: animation.resolve, observed }
}

describe('EngineDiagnosticsDialogHost', () => {
  afterEach(() => vi.restoreAllMocks())

  beforeEach(() => {
    invoke.mockReset()
    invoke.mockImplementation((channel: string) => {
      if (channel === Queries.GetEngineDiagnostics) {
        return Promise.resolve(REPORT)
      }
      if (channel === Commands.RecoverEngine) {
        return Promise.resolve({
          ok: true,
          previousRpcPort: 16800,
          rpcPort: 16800,
          status: { ...REPORT, state: EngineState.Ready },
        })
      }
      return Promise.resolve(null)
    })
  })

  it('keeps the full engine build visible and normal checks collapsed', async () => {
    const user = userEvent.setup()
    render(<EngineDiagnosticsDialogHost />)
    act(() => requestEngineDiagnostics())

    expect(await screen.findByText('Engine diagnostics')).toBeVisible()
    expect(
      await screen.findByRole('heading', {
        name: 'The engine’s control port is occupied',
      })
    ).toBeVisible()
    expect(
      await screen.findByTestId('engine-version-summary')
    ).toHaveTextContent('aria2 Motrix 1.37.0-motrix.14')
    expect(
      screen.getByRole('button', { name: 'Force stop & recover' })
    ).toBeVisible()
    expect(
      screen.queryByText('Async DNS, BitTorrent, SQLite3-Persistence')
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Diagnostic details/ })
    ).toHaveAttribute('aria-expanded', 'false')

    await user.click(screen.getByRole('button', { name: /Diagnostic details/ }))
    expect(
      screen.getByText('Async DNS, BitTorrent, SQLite3-Persistence')
    ).toBeVisible()
    expect(
      screen.getByText(/Verified Motrix leftover; safe to stop/)
    ).toBeVisible()
    expect(screen.getByRole('dialog')).not.toHaveClass('h-[min(84vh,760px)]')
    expect(
      screen.queryByRole('button', {
        name: 'Restore Motrix default port 16800',
      })
    ).not.toBeInTheDocument()
  })

  it('keeps expanded technical details inside the scroll region', async () => {
    const user = userEvent.setup()
    render(<EngineDiagnosticsDialogHost />)
    act(() => requestEngineDiagnostics())
    await user.click(
      await screen.findByRole('button', { name: /Diagnostic details/ })
    )
    expect(screen.getByText('RPC port 16800 is already in use')).toBeVisible()
    expect(screen.getByTestId('engine-diagnostics-scroll')).toContainElement(
      screen.getByText('RPC port 16800 is already in use')
    )
  })

  it.each([false, true])(
    'preserves closing content until the exit animation finishes (expanded: %s)',
    async (expanded) => {
      const user = userEvent.setup()
      render(<EngineDiagnosticsDialogHost />)
      act(() => requestEngineDiagnostics())
      await screen.findByTestId('engine-version-summary')
      if (expanded) {
        await user.click(
          screen.getByRole('button', { name: /Diagnostic details/ })
        )
      }
      const dialog = screen.getByRole('dialog')
      const content = dialog.textContent
      const animation = holdClosingAnimation()

      await user.click(screen.getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(animation.observed).toHaveBeenCalled())
      expect(dialog).toBeInTheDocument()
      expect(dialog.textContent).toBe(content)
      expect(
        screen.queryByText('Running engine checks…')
      ).not.toBeInTheDocument()

      await act(async () => animation.finish())
      await waitFor(() => expect(dialog).not.toBeInTheDocument())
      const nextReport = Promise.withResolvers<typeof REPORT>()
      invoke.mockReturnValueOnce(nextReport.promise)
      act(() => requestEngineDiagnostics())
      expect(await screen.findByText('Running engine checks…')).toBeVisible()
      await act(async () => nextReport.resolve(REPORT))
      expect(
        screen.getByRole('button', { name: /Diagnostic details/ })
      ).toHaveAttribute('aria-expanded', 'false')
    }
  )

  it('ignores late requests while closing and keeps a rapid reopen intact', async () => {
    const user = userEvent.setup()
    render(<EngineDiagnosticsDialogHost />)
    act(() => requestEngineDiagnostics())
    await screen.findByTestId('engine-version-summary')
    const refresh = Promise.withResolvers<typeof REPORT>()
    invoke.mockReturnValueOnce(refresh.promise)
    await user.click(screen.getByRole('button', { name: 'Run again' }))
    const dialog = screen.getByRole('dialog')
    const content = dialog.textContent
    const animation = holdClosingAnimation()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(animation.observed).toHaveBeenCalled())

    await act(async () =>
      refresh.resolve({
        ...REPORT,
        binary: { ...REPORT.binary, version: 'late-result' },
      })
    )
    expect(dialog.textContent).toBe(content)

    invoke.mockResolvedValueOnce({
      ...REPORT,
      binary: { ...REPORT.binary, version: '1.37.0-motrix.15' },
    })
    act(() => requestEngineDiagnostics())
    await waitFor(() =>
      expect(screen.getByTestId('engine-version-summary')).toHaveTextContent(
        '1.37.0-motrix.15'
      )
    )
    await act(async () => animation.finish())
    expect(screen.getByTestId('engine-version-summary')).toHaveTextContent(
      '1.37.0-motrix.15'
    )
    expect(screen.getByRole('dialog')).toBeVisible()
  })

  it('copies the complete report while details are collapsed', async () => {
    const user = userEvent.setup()
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue()
    render(<EngineDiagnosticsDialogHost />)
    act(() => requestEngineDiagnostics())
    await screen.findByTestId('engine-version-summary')
    const copy = screen.getByRole('button', { name: 'Copy diagnostics' })
    await waitFor(() => expect(copy).toBeEnabled())
    await user.click(copy)
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible()
    const copied = JSON.parse(writeText.mock.calls[0][0])
    expect(copied.binary.version).toBe('1.37.0-motrix.14')
    expect(copied.featureReport.features).toContain('SQLite3-Persistence')
    expect(copied.process.pid).toBe(4321)
    expect(copied.rpc.connection).toEqual({
      transport: 'websocket',
      connected: false,
    })
    expect(copied.defaultRpc.port).toBe(16800)
    expect(copied.failure.technicalMessage).toBe(
      'RPC port 16800 is already in use'
    )
    expect(
      screen.getByRole('button', { name: /Diagnostic details/ })
    ).toHaveAttribute('aria-expanded', 'false')
    writeText.mockRestore()
  })

  it('does not show copied feedback when the clipboard fails', async () => {
    const user = userEvent.setup()
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValue(new Error('Denied'))
    const { toast } = await import('@renderer/components/ui/toast')
    const addToast = vi.spyOn(toast, 'add')
    render(<EngineDiagnosticsDialogHost />)
    act(() => requestEngineDiagnostics())
    await screen.findByTestId('engine-version-summary')
    const copy = screen.getByRole('button', { name: 'Copy diagnostics' })
    await waitFor(() => expect(copy).toBeEnabled())
    await user.click(copy)
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith({
        title: 'Could not copy diagnostics. Please try again.',
        type: 'error',
      })
    )
    expect(
      screen.queryByRole('button', { name: 'Copied' })
    ).not.toBeInTheDocument()
    writeText.mockRestore()
    addToast.mockRestore()
  })

  it('does not substitute a cached or pinned version when the binary probe fails', async () => {
    invoke.mockResolvedValue({
      ...REPORT,
      binary: { name: 'aria2c', available: false, version: null },
    })
    render(<EngineDiagnosticsDialogHost />)
    act(() => requestEngineDiagnostics())
    expect(
      await screen.findByTestId('engine-version-summary')
    ).toHaveTextContent('aria2c Version unavailable')
    expect(screen.getByTestId('engine-version-summary')).not.toHaveTextContent(
      '1.37.0'
    )
  })

  it.each([
    EngineState.Starting,
    EngineState.Restarting,
    EngineState.Stopped,
    EngineState.Ready,
  ])('uses the current %s state instead of a stale failure', async (state) => {
    invoke.mockResolvedValue({
      ...REPORT,
      state,
      rpc: {
        ...REPORT.rpc,
        connection: {
          transport: 'websocket',
          connected: state === EngineState.Ready,
        },
      },
      canForceTerminate: false,
      canRetry: false,
      recommendation: EngineRecoveryRecommendation.None,
    })
    render(<EngineDiagnosticsDialogHost />)
    act(() => requestEngineDiagnostics())
    await screen.findByTestId('engine-version-summary')
    expect(
      screen.queryByText('The engine’s control port is occupied')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(
        'Download controls are unavailable. Task status may be out of date.'
      )
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Force stop & recover' })
    ).not.toBeInTheDocument()
  })

  it.each([
    [true, 'WebSocket (Connected)'],
    [false, 'WebSocket (Not connected)'],
  ])(
    'shows the actual transport when connected is %s',
    async (connected, label) => {
      const user = userEvent.setup()
      invoke.mockResolvedValue({
        ...REPORT,
        state: EngineState.Ready,
        failure: null,
        rpc: {
          ...REPORT.rpc,
          expectedListener: true,
          connection: { transport: 'websocket', connected },
        },
        recommendation: EngineRecoveryRecommendation.None,
        canForceTerminate: false,
      })
      render(<EngineDiagnosticsDialogHost />)
      act(() => requestEngineDiagnostics())
      expect(await screen.findByText(label)).toBeVisible()
      await user.click(
        screen.getByRole('button', { name: /Diagnostic details/ })
      )
      expect(screen.getAllByText(label)).toHaveLength(2)
      if (!connected) {
        expect(
          screen.queryByText('The download engine is running normally')
        ).not.toBeInTheDocument()
        expect(
          screen.getByText('The engine’s control connection is unavailable')
        ).toBeVisible()
      }
    }
  )

  it('does not guess a transport for reports from an older backend', async () => {
    invoke.mockResolvedValue({
      ...REPORT,
      state: EngineState.Ready,
      rpc: { ...REPORT.rpc, connection: undefined },
    })
    render(<EngineDiagnosticsDialogHost />)
    act(() => requestEngineDiagnostics())
    expect(await screen.findByText('Connected')).toBeVisible()
    expect(screen.queryByText(/WebSocket/)).not.toBeInTheDocument()
  })

  it('keeps an initial load failure actionable without an empty diagnostics screen', async () => {
    invoke.mockRejectedValue(new Error('Offline'))
    render(<EngineDiagnosticsDialogHost />)
    act(() => requestEngineDiagnostics())
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not run engine diagnostics.'
    )
    expect(
      screen.getByRole('button', { name: 'Copy diagnostics' })
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Run again' })).toBeEnabled()
  })

  it('marks the retained report stale and disables recovery after a refresh failure', async () => {
    const user = userEvent.setup()
    render(<EngineDiagnosticsDialogHost />)
    act(() => requestEngineDiagnostics())
    await screen.findByTestId('engine-version-summary')
    invoke.mockRejectedValueOnce(new Error('Offline'))
    await user.click(screen.getByRole('button', { name: 'Run again' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The last successful report is shown below.'
    )
    expect(
      screen.getByRole('button', { name: 'Force stop & recover' })
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Run again' })).toBeEnabled()
  })

  it('revalidates and submits the displayed pid after confirmation', async () => {
    const user = userEvent.setup()
    render(<EngineDiagnosticsDialogHost />)
    act(() => requestEngineDiagnostics())

    await user.click(
      await screen.findByRole('button', { name: 'Force stop & recover' })
    )
    expect(
      await screen.findByText('Force stop the leftover aria2 process?')
    ).toBeVisible()
    expect(screen.getByText(/matches Motrix’s bundled binary/i)).toBeVisible()
    const actions = screen.getAllByRole('button', {
      name: 'Force stop & recover',
    })
    await user.click(actions.at(-1) as HTMLButtonElement)

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(Commands.RecoverEngine, {
        action: 'force_terminate',
        expectedPid: 4321,
      })
    })
  })

  it('restores a free Motrix default port from a fallback port', async () => {
    const user = userEvent.setup()
    invoke.mockImplementation((channel: string) => {
      if (channel === Queries.GetEngineDiagnostics) {
        return Promise.resolve({
          ...REPORT,
          rpc: { port: 16801, available: false, expectedListener: true },
          defaultRpc: {
            port: 16800,
            isCurrent: false,
            available: true,
            process: null,
            canRestore: true,
            requiresTermination: false,
          },
        })
      }
      if (channel === Commands.RecoverEngine) {
        return Promise.resolve({
          ok: true,
          previousRpcPort: 16801,
          rpcPort: 16800,
          status: { ...REPORT, state: EngineState.Ready },
        })
      }
      return Promise.resolve(null)
    })
    render(<EngineDiagnosticsDialogHost />)
    act(() => requestEngineDiagnostics())

    const restoreButton = await screen.findByRole('button', {
      name: 'Restore Motrix default port 16800',
    })
    expect(screen.getByTestId('engine-check-rpc')).toContainElement(
      restoreButton
    )
    expect(
      screen.queryByText('Using non-default RPC port 16801')
    ).not.toBeInTheDocument()
    await user.click(restoreButton)

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(Commands.RecoverEngine, {
        action: 'restore_default_port',
      })
    })
  })

  it('confirms the verified default-port pid before stopping it', async () => {
    const user = userEvent.setup()
    const defaultProcess = {
      pid: 8765,
      name: 'aria2c',
      executableName: 'aria2c',
      ownership: EngineProcessOwnership.VerifiedOrphan,
      safeToTerminate: true,
    }
    invoke.mockImplementation((channel: string) => {
      if (channel === Queries.GetEngineDiagnostics) {
        return Promise.resolve({
          ...REPORT,
          rpc: { port: 16801, available: false, expectedListener: true },
          defaultRpc: {
            port: 16800,
            isCurrent: false,
            available: false,
            process: defaultProcess,
            canRestore: true,
            requiresTermination: true,
          },
        })
      }
      if (channel === Commands.RecoverEngine) {
        return Promise.resolve({
          ok: true,
          previousRpcPort: 16801,
          rpcPort: 16800,
          status: { ...REPORT, state: EngineState.Ready },
        })
      }
      return Promise.resolve(null)
    })
    render(<EngineDiagnosticsDialogHost />)
    act(() => requestEngineDiagnostics())

    await user.click(
      await screen.findByRole('button', {
        name: 'Restore Motrix default port 16800',
      })
    )
    expect(
      await screen.findByText(
        'Stop the leftover process and restore port 16800?'
      )
    ).toBeVisible()
    await user.click(
      screen.getByRole('button', { name: 'Stop and restore port 16800' })
    )

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(Commands.RecoverEngine, {
        action: 'restore_default_port',
        expectedPid: 8765,
      })
    })
  })

  it('keeps restore disabled for an unverified default-port process', async () => {
    const user = userEvent.setup()
    invoke.mockImplementation((channel: string) => {
      if (channel === Queries.GetEngineDiagnostics) {
        return Promise.resolve({
          ...REPORT,
          rpc: { port: 16801, available: false, expectedListener: true },
          defaultRpc: {
            port: 16800,
            isCurrent: false,
            available: false,
            process: {
              pid: 9000,
              name: 'aria2c',
              executableName: 'aria2c',
              ownership: EngineProcessOwnership.ExternalAria2,
              safeToTerminate: false,
            },
            canRestore: false,
            requiresTermination: false,
          },
        })
      }
      return Promise.resolve(null)
    })
    render(<EngineDiagnosticsDialogHost />)
    act(() => requestEngineDiagnostics())

    const restoreButton = await screen.findByRole('button', {
      name: 'Restore Motrix default port 16800',
    })
    expect(restoreButton).toBeDisabled()
    expect(screen.getByTestId('engine-check-rpc')).toContainElement(
      restoreButton
    )

    await user.hover(restoreButton.parentElement as HTMLElement)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      /cannot verify ownership/i
    )
  })
})
