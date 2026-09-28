import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { subscribeEngineDiagnostics } from '@renderer/features/engine-diagnostics/controller'
import { useOperatorSession } from '@renderer/lib/operator-auth'
import { transport } from '@renderer/lib/transport'
import { dashboardTileViewport } from '@renderer/routes/dashboard/layout/dashboard-registry'
import { EngineTile } from '@renderer/routes/dashboard/tiles/engine-tile'
import { EngineBadge } from '@renderer/routes/downloads/engine-badge'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { useEngineDisplayStatus } from './use-engine-display-status'

const health = vi.hoisted(() => ({ realtimeConnected: true, status: 'ready' }))
vi.mock('./use-task-list', () => ({ useTaskList: () => health }))
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    platform: 'web',
    on: vi.fn(),
    off: vi.fn(),
    invoke: vi.fn(async (channel) =>
      channel === Queries.GetSettings
        ? { engine: { rpcPort: 16800, listenPort: 51413 } }
        : {
            state: 'ready',
            featureReport: { version: '1.37.0' },
            failure: null,
          }
    ),
  },
}))

function Surfaces() {
  const status = useEngineDisplayStatus()
  return (
    <>
      <EngineTile
        status={status}
        viewport={dashboardTileViewport('engine', { w: 2, h: 1 })}
      />
      <EngineBadge />
    </>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(transport.invoke).mockImplementation(async (channel) =>
    channel === Queries.GetSettings
      ? { engine: { rpcPort: 16800, listenPort: 51413 } }
      : { state: 'ready', featureReport: { version: '1.37.0' }, failure: null }
  )
  health.realtimeConnected = true
  health.status = 'ready'
  useOperatorSession.setState({
    state: 'authenticated',
    status: { authed: true, mode: 'cookie', canLogout: true },
  })
})

it('shows the same periodic-update state on both surfaces and restores engine readiness', async () => {
  const { rerender } = render(<Surfaces />)
  await waitFor(() => expect(screen.getByText('Engine ready')).toBeVisible())
  health.realtimeConnected = false
  rerender(<Surfaces />)
  expect(screen.getAllByText('Periodic updates')).toHaveLength(2)
  expect(screen.queryByText('Engine offline')).not.toBeInTheDocument()
  health.realtimeConnected = true
  rerender(<Surfaces />)
  await waitFor(() => expect(screen.getByText('Engine ready')).toBeVisible())
  expect(screen.queryByText('Periodic updates')).not.toBeInTheDocument()
})

it('distinguishes server unavailability and a confirmed origin mismatch from engine failure', async () => {
  const { rerender } = render(<Surfaces />)
  await waitFor(() => expect(screen.getByText('Engine ready')).toBeVisible())
  health.realtimeConnected = false
  health.status = 'error'
  rerender(<Surfaces />)
  expect(screen.getAllByText('Server unreachable')).toHaveLength(2)
  health.status = 'ready'
  await act(async () =>
    useOperatorSession.setState({
      status: {
        authed: true,
        mode: 'cookie',
        canLogout: true,
        eventOriginMatches: false,
      },
    })
  )
  expect(screen.getAllByText('Access address mismatch')).toHaveLength(2)
  expect(screen.queryByText('Engine offline')).not.toBeInTheDocument()
})

it('keeps the diagnostics action available while the badge reports connection health', async () => {
  const requested = vi.fn()
  const unsubscribe = subscribeEngineDiagnostics(requested)
  try {
    const user = userEvent.setup()
    const { rerender } = render(<EngineBadge />)
    await screen.findByRole('button', { name: 'Engine ready' })
    health.realtimeConnected = false
    rerender(<EngineBadge />)

    const badge = screen.getByRole('button', { name: 'Periodic updates' })
    expect(badge).toHaveAttribute('aria-haspopup', 'dialog')
    expect(badge).toHaveAttribute(
      'title',
      'Engine diagnostics: Engine ready, Periodic updates'
    )
    expect(screen.getByRole('status')).toHaveTextContent('Periodic updates')
    await user.click(badge)
    expect(requested).toHaveBeenCalledOnce()
  } finally {
    unsubscribe()
  }
})

it('shows a confirmed engine failure without waiting for unrelated settings', async () => {
  let finishSettings!: (value: unknown) => void
  let engineState = 'ready'
  vi.mocked(transport.invoke).mockImplementation(async (channel) => {
    if (channel === Queries.GetSettings)
      return new Promise((resolve) => {
        finishSettings = resolve
      })
    return { state: engineState, featureReport: null, failure: null }
  })
  const { result } = renderHook(() => useEngineDisplayStatus())
  await waitFor(() => expect(result.current.state).toBe('ready'))
  engineState = 'failed'
  const onEngine = vi
    .mocked(transport.on)
    .mock.calls.findLast(
      ([channel]) => channel === Events.EngineStateChanged
    )?.[1]
  await act(async () => onEngine?.('failed'))
  expect(result.current.state).toBe('failed')
  await act(async () =>
    finishSettings({ engine: { rpcPort: 16800, listenPort: 51413 } })
  )
  expect(result.current.state).toBe('failed')
  expect(result.current.rpcPort).toBe(16800)
})

function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function engineListener() {
  return vi
    .mocked(transport.on)
    .mock.calls.findLast(
      ([channel]) => channel === Events.EngineStateChanged
    )?.[1]
}

it('applies an engine event immediately and rejects an older ready response', async () => {
  const older = deferred()
  const fresh = deferred()
  vi.mocked(transport.invoke).mockImplementation((channel) => {
    if (channel === Queries.GetSettings)
      return Promise.resolve({ engine: { rpcPort: 16800, listenPort: 51413 } })
    return older.promise
  })
  const { result } = renderHook(() => useEngineDisplayStatus())
  act(() => engineListener()?.('failed'))
  expect(result.current.state).toBe('failed')
  vi.mocked(transport.invoke).mockReturnValue(fresh.promise)
  await act(async () => older.resolve({ state: 'ready', failure: null }))
  expect(result.current.state).toBe('failed')
  await act(async () =>
    fresh.resolve({ state: 'failed', failure: { reason: 'rpc_unavailable' } })
  )
  expect(result.current.failureReason).toBe('rpc_unavailable')
})

it('keeps successful engine reads usable and bounded across connection flapping', async () => {
  const pending = deferred()
  vi.mocked(transport.invoke).mockReturnValue(pending.promise)
  const { result, rerender } = renderHook(() => useEngineDisplayStatus())
  for (let i = 0; i < 6; i++) {
    health.realtimeConnected = !health.realtimeConnected
    rerender()
  }
  expect(transport.invoke).toHaveBeenCalledTimes(2)
  vi.mocked(transport.invoke).mockImplementation(async (channel) =>
    channel === Queries.GetSettings
      ? { engine: { rpcPort: 16800, listenPort: 51413 } }
      : { state: 'ready', featureReport: { version: 'new' }, failure: null }
  )
  await act(async () =>
    pending.resolve({
      state: 'ready',
      failure: null,
      engine: { rpcPort: 16800, listenPort: 51413 },
    })
  )
  expect(transport.invoke).toHaveBeenCalledTimes(4)
  expect(result.current.state).toBe('ready')
  expect(result.current.version).toBe('new')
})

it('ignores late engine and settings responses from a logged-out session', async () => {
  const pending = deferred()
  vi.mocked(transport.invoke).mockReturnValue(pending.promise)
  const { result } = renderHook(() => useEngineDisplayStatus())
  act(() =>
    useOperatorSession.setState((s) => ({
      state: 'locked',
      epoch: s.epoch + 1,
    }))
  )
  await act(async () =>
    pending.resolve({
      state: 'ready',
      engine: { rpcPort: 9999, listenPort: 9999 },
    })
  )
  expect(result.current.state).toBe('starting')
  expect(result.current.rpcPort).toBe(0)
})
