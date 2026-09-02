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
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
    version: '1.37.0',
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
  binary: { name: 'aria2c', available: true, version: '1.37.0' },
  rpc: { port: 16800, available: false, expectedListener: false },
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

describe('EngineDiagnosticsDialogHost', () => {
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

  it('explains verified ownership before offering force recovery', async () => {
    render(<EngineDiagnosticsDialogHost />)
    act(() => requestEngineDiagnostics())

    expect(await screen.findByText('Engine diagnostics')).toBeVisible()
    expect(
      await screen.findByText(/matches Motrix’s bundled binary/i)
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Force stop & recover' })
    ).toBeVisible()
    expect(
      screen.getByText('Async DNS, BitTorrent, SQLite3-Persistence')
    ).toBeVisible()
    const recommendation = screen.getByText('Recommended recovery')
    const binaryCheck = screen.getByText('Bundled aria2')
    expect(
      recommendation.compareDocumentPosition(binaryCheck) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(screen.getByRole('dialog')).toHaveClass(
      'h-[min(84vh,760px)]',
      'grid-rows-[auto_minmax(0,1fr)_auto]',
      'overflow-hidden'
    )
    expect(screen.getByTestId('engine-diagnostics-scroll')).toHaveClass(
      'min-h-0',
      'overflow-y-auto'
    )
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

    await user.click(await screen.findByText('Technical details'))

    expect(screen.getByText('RPC port 16800 is already in use')).toBeVisible()
    expect(screen.getByTestId('engine-diagnostics-scroll')).toContainElement(
      screen.getByText('RPC port 16800 is already in use').closest('details')
    )
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
