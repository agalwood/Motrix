import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { useOperatorSession } from '@renderer/lib/operator-auth'
import { dashboardTileViewport } from '@renderer/routes/dashboard/layout/dashboard-registry'
import { EngineTile } from '@renderer/routes/dashboard/tiles/engine-tile'
import { EngineBadge } from '@renderer/routes/downloads/engine-badge'
import { Queries } from '@shared/protocol/queries'
import { act, render, screen, waitFor } from '@testing-library/react'
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
