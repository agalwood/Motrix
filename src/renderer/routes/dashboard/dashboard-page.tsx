// src/renderer/routes/dashboard/dashboard-page.tsx
import { PanelShell } from '@renderer/components/desktop-kit/panel/panel-shell'
import { requestEngineDiagnostics } from '@renderer/features/engine-diagnostics/controller'
import { useGlobalSpeedHistory } from '@renderer/hooks/use-global-speed-history'
import { useGlobalStats } from '@renderer/hooks/use-global-stats'
import { useSpeedLimitState } from '@renderer/hooks/use-speed-limit-state'
import { useTransferStats } from '@renderer/hooks/use-transfer-stats'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  DEFAULT_DASHBOARD_LAYOUT,
  dashboardLayoutSettingsSchema,
} from '@shared/schemas/dashboard-layout'
import type {
  DashboardLayoutSettings,
  DashboardTileLayout,
} from '@shared/types/settings'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DashboardGrid } from './components/dashboard-grid'
import { TileErrorBoundary } from './components/tile-error-boundary'
import { useEngineDisplayStatus } from './hooks/use-engine-display-status'
import type { DashboardTileViewport } from './layout/dashboard-registry'
import { ActiveTile } from './tiles/active-tile'
import { ActivityTile } from './tiles/activity-tile'
import { EngineTile } from './tiles/engine-tile'
import { NatTile } from './tiles/nat-tile'
import { SpeedLimitTile } from './tiles/speed-limit-tile'
import { SpeedTile } from './tiles/speed-tile'
import { TasksTile } from './tiles/tasks-tile'
import { TransferTile } from './tiles/transfer-tile'

// Module-level cache of the last-loaded layout. The dashboard route unmounts on
// every navigation (react-router <Outlet/>); without this, each remount paints
// DEFAULT_DASHBOARD_LAYOUT first and then async-corrects to the saved layout,
// which DashboardGrid's FLIP animation turns into visible tile-sliding. Seeding
// the initial state from the cache makes the first paint already correct.
let cachedLayout: DashboardLayoutSettings | null = null

export function DashboardPage() {
  const { t } = useTranslation()
  const history = useGlobalSpeedHistory()
  const { stats } = useGlobalStats()
  const transfer = useTransferStats()
  const engineStatus = useEngineDisplayStatus()
  const speedLimit = useSpeedLimitState()
  const [layout, setLayout] = useState<DashboardLayoutSettings>(
    () => cachedLayout ?? DEFAULT_DASHBOARD_LAYOUT
  )
  const [dashboardActions, setDashboardActions] = useState<ReactNode>(null)

  const engineOnline =
    engineStatus.state !== 'disconnected' && engineStatus.state !== 'failed'

  useEffect(() => {
    let cancelled = false
    transport
      .invoke(Queries.GetSettings)
      .then((settings) => {
        if (cancelled) return
        const result = dashboardLayoutSettingsSchema.safeParse(
          (settings as { dashboard?: unknown } | null)?.dashboard ?? {}
        )
        const next = result.success ? result.data : DEFAULT_DASHBOARD_LAYOUT
        cachedLayout = next
        setLayout(next)
      })
      .catch(() => {
        if (!cancelled) setLayout(DEFAULT_DASHBOARD_LAYOUT)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const saveLayout = useCallback(
    async (nextLayout: DashboardLayoutSettings) => {
      await transport.invoke(Commands.UpdateSettings, { dashboard: nextLayout })
      cachedLayout = nextLayout
      setLayout(nextLayout)
    },
    []
  )

  const renderTile = useCallback(
    (
      tile: DashboardTileLayout,
      viewport: DashboardTileViewport,
      context: { interactive: boolean }
    ) => {
      switch (tile.id) {
        case 'engine':
          return (
            <TileErrorBoundary tile="Engine" className="h-full min-h-0">
              <EngineTile
                status={engineStatus}
                viewport={viewport}
                onManage={requestEngineDiagnostics}
              />
            </TileErrorBoundary>
          )
        case 'speedUp':
          return (
            <TileErrorBoundary tile="Up" className="h-full min-h-0">
              <SpeedTile kind="up" history={history} viewport={viewport} />
            </TileErrorBoundary>
          )
        case 'speedDown':
          return (
            <TileErrorBoundary tile="Down" className="h-full min-h-0">
              <SpeedTile kind="down" history={history} viewport={viewport} />
            </TileErrorBoundary>
          )
        case 'active':
          return (
            <TileErrorBoundary tile="Active" className="h-full min-h-0">
              <ActiveTile
                activeCount={stats?.activeTasks ?? 0}
                engineOnline={engineOnline}
                viewport={viewport}
              />
            </TileErrorBoundary>
          )
        case 'tasks':
          return (
            <TileErrorBoundary tile="Tasks" className="h-full min-h-0">
              <TasksTile engineOnline={engineOnline} viewport={viewport} />
            </TileErrorBoundary>
          )
        case 'transfer':
          return (
            <TileErrorBoundary tile="Transfer" className="h-full min-h-0">
              <TransferTile state={transfer} viewport={viewport} />
            </TileErrorBoundary>
          )
        case 'speedLimit':
          return (
            <TileErrorBoundary tile="SpeedLimit" className="h-full min-h-0">
              <SpeedLimitTile
                state={speedLimit}
                viewport={viewport}
                onSelectTurtle={(turtle) =>
                  transport.invoke(Commands.UpdateSettings, {
                    speedLimit: { turtle },
                  })
                }
              />
            </TileErrorBoundary>
          )
        case 'nat':
          return (
            <TileErrorBoundary tile="Nat" className="h-full min-h-0">
              <NatTile viewport={viewport} />
            </TileErrorBoundary>
          )
        case 'activity':
          return (
            <TileErrorBoundary tile="Activity" className="h-full min-h-0">
              <ActivityTile
                viewport={viewport}
                interactive={context.interactive}
              />
            </TileErrorBoundary>
          )
      }
    },
    [
      engineOnline,
      engineStatus,
      history,
      speedLimit,
      stats?.activeTasks,
      transfer,
    ]
  )

  return (
    <PanelShell
      title={t('panel.dashboard.title')}
      actions={dashboardActions}
      headerClassName="px-2"
      contentClassName="pl-2.5 pr-2 pt-4 pb-10"
    >
      <DashboardGrid
        layout={layout}
        renderTile={renderTile}
        onApply={saveLayout}
        onActionsChange={setDashboardActions}
      />
    </PanelShell>
  )
}
