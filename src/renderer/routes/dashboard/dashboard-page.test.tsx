import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { DashboardLayoutSettings } from '@shared/types/settings'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

if (typeof globalThis.ResizeObserver === 'undefined') {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  })
}

const mockInvoke = vi.fn()
const rejectUpdateSettings = { current: false }
const dashboardSettings = {
  current: undefined as DashboardLayoutSettings | undefined,
}
const engineState = { current: 'ready' }
const capturedTileViewports = vi.hoisted(() => new Map<string, unknown>())
const listeners = new Map<string, (...a: unknown[]) => void>()
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: (...a: unknown[]) => mockInvoke(...a),
    on: (ch: string, cb: (...a: unknown[]) => void) => listeners.set(ch, cb),
    off: (ch: string) => listeners.delete(ch),
    platform: 'darwin',
  },
}))

vi.mock('./tiles/speed-tile', async () => {
  const actual =
    await vi.importActual<typeof import('./tiles/speed-tile')>(
      './tiles/speed-tile'
    )
  const ActualSpeedTile = actual.SpeedTile
  return {
    ...actual,
    SpeedTile: (props: Parameters<typeof actual.SpeedTile>[0]) => {
      capturedTileViewports.set(`speed-${props.kind}`, props.viewport)
      return <ActualSpeedTile {...props} />
    },
  }
})

vi.mock('./tiles/nat-tile', async () => {
  const actual =
    await vi.importActual<typeof import('./tiles/nat-tile')>('./tiles/nat-tile')
  const ActualNatTile = actual.NatTile
  return {
    ...actual,
    NatTile: (props: Parameters<typeof actual.NatTile>[0]) => {
      capturedTileViewports.set('nat', props.viewport)
      return <ActualNatTile {...props} />
    },
  }
})

vi.mock('@renderer/hooks/use-task-list', () => ({
  useTaskList: () => ({ tasks: [] }),
}))

vi.mock('react-router', async () => {
  const actual = (await vi.importActual('react-router')) as object
  return {
    ...actual,
    Link: ({ to, ...props }: ComponentProps<'a'> & { to: string }) => (
      <a href={to} {...props} />
    ),
    useNavigate: () => vi.fn(),
  }
})

import { DashboardPage } from './dashboard-page'
import { applyDashboardPreset } from './layout/dashboard-presets'

async function selectTileSize(tileId: string, size: string) {
  const user = userEvent.setup({ pointerEventsCheck: 0 })
  const [width, height] = size.split('x')
  await user.click(
    within(screen.getByTestId(`dashboard-tile-${tileId}`)).getByRole('button', {
      name: /Tile size|卡片尺寸/i,
    })
  )
  await user.click(
    await screen.findByRole('menuitemradio', {
      name: new RegExp(`${width}\\s*[×x]\\s*${height}`),
    })
  )
}

describe('DashboardPage', () => {
  beforeEach(() => {
    listeners.clear()
    rejectUpdateSettings.current = false
    dashboardSettings.current = undefined
    engineState.current = 'ready'
    capturedTileViewports.clear()
    mockInvoke.mockClear()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === Queries.GetSpeedHistory) return Promise.resolve([])
      if (channel === Queries.GetTransferStats)
        return Promise.resolve({
          today: {
            downloadBytes: '0',
            uploadBytes: '0',
            totalBytes: '0',
            startedAt: 0,
            endsAt: 86_400_000,
            coverageStartedAt: 0,
          },
          allTime: {
            downloadBytes: '0',
            uploadBytes: '0',
            totalBytes: '0',
            startedAt: 0,
            coverageStartedAt: 0,
          },
          updatedAt: null,
          accuracy: 'estimated',
        })
      if (channel === Queries.GetStats)
        return Promise.resolve({
          totalDownloadSpeed: 0,
          totalUploadSpeed: 0,
          activeTasks: 0,
          waitingTasks: 0,
          stoppedTasks: 0,
        })
      if (channel === Queries.GetEngineStatus)
        return Promise.resolve({
          state: engineState.current,
          featureReport: null,
        })
      if (channel === Queries.GetNatStatus) return Promise.resolve(null)
      if (channel === Queries.GetSettings)
        return Promise.resolve({
          engine: { rpcPort: 16800, listenPort: 51413 },
          dashboard: dashboardSettings.current,
        })
      if (channel === Commands.UpdateSettings && rejectUpdateSettings.current)
        return Promise.reject(new Error('write failed'))
      return Promise.resolve(null)
    })
  })

  it('renders the dashboard panel title', async () => {
    await act(async () => {
      render(<DashboardPage />)
    })
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
  })

  it('renders speed, active, and transfer tiles', async () => {
    await act(async () => {
      render(<DashboardPage />)
    })
    // SpeedTile labels
    expect(screen.getAllByText(/UPLOAD|上传/i).length).toBeGreaterThanOrEqual(1)
    // "DOWNLOAD" (tile label) vs "Downloading" (active sub-label) — use exact label
    expect(screen.getByText('DOWNLOAD')).toBeInTheDocument()
    // ActiveTile label: "ACTIVE TASKS" or "活跃任务"
    expect(screen.getAllByText(/ACTIVE|活跃/i).length).toBeGreaterThanOrEqual(1)
    // TransferTile label: "TRANSFER" or "传输"
    expect(screen.getAllByText(/TRANSFER|传输/i).length).toBeGreaterThanOrEqual(
      1
    )
  })

  it('does not add a Transfer pause caption when the engine is stopped', async () => {
    engineState.current = 'stopped'

    await act(async () => {
      render(<DashboardPage />)
    })

    expect(screen.queryByText('Updates paused')).toBeNull()
    expect(screen.getAllByText(/TRANSFER|传输/i).length).toBeGreaterThanOrEqual(
      1
    )
  })

  it('declares container query and fold class on the grid root', async () => {
    let container: HTMLElement | undefined
    await act(async () => {
      const result = render(<DashboardPage />)
      container = result.container
    })
    // Container Query L1 requires the query container to be an ancestor of the
    // queried element. The dashboard grid switches to Surge-style 4x3
    // placement once there is enough width.
    const containerEl = container?.querySelector(
      '.\\@container'
    ) as HTMLElement | null
    expect(containerEl).not.toBeNull()
    const grid = screen.getByTestId('dashboard-grid')
    expect(grid).not.toBeNull()
    expect(grid?.className).toContain('grid-cols-1')
    expect(grid?.className).toContain('@[560px]:grid-cols-4')
  })

  it('renders configure controls in the panel header actions', async () => {
    let container: HTMLElement | undefined
    await act(async () => {
      const result = render(<DashboardPage />)
      container = result.container
    })

    const header = container?.querySelector('header') as HTMLElement | null
    expect(header).not.toBeNull()
    expect(
      within(header as HTMLElement).getByRole('button', {
        name: /Configure|配置/i,
      })
    ).toBeInTheDocument()

    const grid = screen.getByTestId('dashboard-grid')
    expect(
      within(grid).queryByRole('button', { name: /Configure|配置/i })
    ).toBeNull()
  })

  it('maps persisted numeric spans to complete tile viewports', async () => {
    dashboardSettings.current = {
      version: 1,
      columns: 4,
      tiles: [
        { id: 'engine', enabled: false, x: 0, y: 0, w: 1, h: 1 },
        { id: 'speedLimit', enabled: false, x: 1, y: 0, w: 1, h: 1 },
        { id: 'speedUp', enabled: true, x: 1, y: 0, w: 3, h: 1 },
        { id: 'speedDown', enabled: false, x: 3, y: 0, w: 1, h: 1 },
        { id: 'active', enabled: false, x: 0, y: 1, w: 2, h: 1 },
        { id: 'tasks', enabled: false, x: 2, y: 1, w: 2, h: 2 },
        { id: 'transfer', enabled: false, x: 0, y: 2, w: 2, h: 1 },
        { id: 'nat', enabled: true, x: 0, y: 0, w: 1, h: 2 },
      ],
    }

    await act(async () => {
      render(<DashboardPage />)
    })

    await waitFor(() => {
      expect(capturedTileViewports.get('nat')).toEqual({
        span: { w: 1, h: 2 },
        orientation: 'tall',
        contentLevel: 'detailed',
      })
      expect(capturedTileViewports.get('speed-up')).toEqual({
        span: { w: 3, h: 1 },
        orientation: 'wide',
        contentLevel: 'detailed',
      })
    })

    expect(
      screen
        .getByTestId('dashboard-tile-nat')
        .style.getPropertyValue('--dashboard-grid-row')
    ).toBe('1 / span 2')
    expect(
      screen
        .getByTestId('dashboard-tile-speedUp')
        .style.getPropertyValue('--dashboard-grid-column')
    ).toBe('2 / span 3')
  })

  it('saves dashboard layout changes from configure mode', async () => {
    await act(async () => {
      render(<DashboardPage />)
    })

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
    await selectTileSize('engine', '1x1')
    fireEvent.click(screen.getByRole('button', { name: /Apply|应用/i }))

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        Commands.UpdateSettings,
        expect.objectContaining({
          dashboard: expect.objectContaining({
            tiles: expect.arrayContaining([
              expect.objectContaining({ id: 'engine', w: 1, h: 1 }),
            ]),
          }),
        })
      )
    })
  })

  it('persists and adopts the exact full preset result', async () => {
    const compact = applyDashboardPreset('compact')
    const user = userEvent.setup({ pointerEventsCheck: 0 })

    await act(async () => {
      render(<DashboardPage />)
    })
    await screen.findByTestId('dashboard-tile-engine')

    await user.click(screen.getByRole('button', { name: /Configure|配置/i }))
    await user.click(screen.getByRole('button', { name: /Presets|预设/i }))
    await user.click(
      await screen.findByRole('menuitem', { name: /Compact|紧凑/i })
    )

    expect(mockInvoke).not.toHaveBeenCalledWith(
      Commands.UpdateSettings,
      expect.anything()
    )

    await user.click(screen.getByRole('button', { name: /Apply|应用/i }))

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(Commands.UpdateSettings, {
        dashboard: compact,
      })
      expect(
        screen.getByRole('button', { name: /Configure|配置/i })
      ).toBeInTheDocument()
    })

    const renderedTiles = within(screen.getByTestId('dashboard-grid'))
      .getAllByTestId(/^dashboard-tile-/)
      .map((tile) => tile.dataset.dashboardTileId)
    const enabledTiles = compact.tiles.filter((tile) => tile.enabled)
    expect(renderedTiles).toEqual(enabledTiles.map((tile) => tile.id))

    for (const tile of enabledTiles) {
      const frame = screen.getByTestId(`dashboard-tile-${tile.id}`)
      expect(frame.style.getPropertyValue('--dashboard-grid-column')).toBe(
        `${tile.x + 1} / span ${tile.w}`
      )
      expect(frame.style.getPropertyValue('--dashboard-grid-row')).toBe(
        `${tile.y + 1} / span ${tile.h}`
      )
    }
  })

  it('keeps configure mode open when dashboard layout save fails', async () => {
    rejectUpdateSettings.current = true
    await act(async () => {
      render(<DashboardPage />)
    })

    fireEvent.click(screen.getByRole('button', { name: /Configure|配置/i }))
    await selectTileSize('engine', '1x1')
    fireEvent.click(screen.getByRole('button', { name: /Apply|应用/i }))

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        /Could not save layout|布局保存失败/i
      )
    })
    expect(
      screen.getByRole('button', { name: /Apply|应用/i })
    ).toBeInTheDocument()
    expect(screen.getByTestId('dashboard-tile-engine')).toHaveAttribute(
      'data-enabled',
      'true'
    )
  })
})
