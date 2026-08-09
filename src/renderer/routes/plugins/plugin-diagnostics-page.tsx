import '@xyflow/react/dist/style.css'
import { PanelShell } from '@renderer/components/desktop-kit/panel/panel-shell'
import { Button } from '@renderer/components/ui/button'
import type { AriaLabelConfig, ColorMode } from '@xyflow/react'
import { useTheme } from 'next-themes'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  PluginCallGraph,
  type PluginCallGraphSelection,
  type PluginCallGraphStrings,
} from './components/call-graph/plugin-call-graph'
import { PluginCallGraphErrorBoundary } from './components/call-graph/plugin-call-graph-error-boundary'
import {
  PluginCallGraphInspector,
  type PluginCallGraphInspectorStrings,
} from './components/call-graph/plugin-call-graph-inspector'
import {
  PluginCallGraphTable,
  type PluginCallGraphTableStrings,
} from './components/call-graph/plugin-call-graph-table'
import {
  type PluginCallGraphMode,
  type PluginCallGraphModeIds,
  PluginCallGraphToolbar,
  type PluginCallGraphToolbarStrings,
} from './components/call-graph/plugin-call-graph-toolbar'
import { usePluginGraph } from './hooks/use-plugin-graph'
import { usePluginMetadata } from './hooks/use-plugin-metadata'
import {
  buildCallGraphModel,
  filterCommandEdges,
  getCallGraphDensity,
} from './lib/call-graph-model'

const KEY_ROOT = 'plugins.diagnostics.callGraph'
const MODE_IDS: PluginCallGraphModeIds = {
  graph: {
    triggerId: 'plugin-call-graph-mode-trigger',
    panelId: 'plugin-call-graph-mode-panel',
  },
  table: {
    triggerId: 'plugin-call-table-mode-trigger',
    panelId: 'plugin-call-table-mode-panel',
  },
}

interface PendingStateProps {
  message: string
}

function PendingState({ message }: PendingStateProps) {
  return (
    <div
      role="status"
      className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground"
    >
      {message}
    </div>
  )
}

interface ErrorStateProps {
  title: string
  description: string
  retryLabel: string
  onRetry: () => void
  compact?: boolean
}

function ErrorState({
  title,
  description,
  retryLabel,
  onRetry,
  compact = false,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={
        compact
          ? 'flex shrink-0 items-center justify-between gap-3 rounded-md border border-destructive/40 bg-muted/20 px-3 py-2'
          : 'flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-md border border-destructive/40 bg-muted/20 p-6 text-center'
      }
    >
      <div className={compact ? 'min-w-0' : 'space-y-1'}>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="shrink-0"
        onClick={onRetry}
      >
        {retryLabel}
      </Button>
    </div>
  )
}

interface EmptyStateProps {
  title?: string
  description: string
}

function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
      {title && <h2 className="text-sm font-semibold">{title}</h2>}
      <p className="max-w-xl text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

export function PluginDiagnosticsPage() {
  const { t, i18n } = useTranslation()
  const { resolvedTheme } = useTheme()
  const graph = usePluginGraph()
  const metadata = usePluginMetadata()
  const [mode, setMode] = useState<PluginCallGraphMode>('graph')
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<PluginCallGraphSelection>(null)
  const userSelectedModeRef = useRef(false)
  const autoTableAppliedRef = useRef(false)

  const baseModel = useMemo(() => {
    if (!graph.data || metadata.status !== 'success' || !metadata.data) {
      return null
    }
    return buildCallGraphModel(graph.data, metadata.data)
  }, [graph.data, metadata.data, metadata.status])
  const filteredModel = useMemo(
    () => (baseModel ? filterCommandEdges(baseModel, { search: query }) : null),
    [baseModel, query]
  )
  const density = filteredModel
    ? getCallGraphDensity(
        filteredModel.nodes.length,
        filteredModel.pairEdges.length
      )
    : 'full'
  const shouldAutoTable =
    density === 'table-first' &&
    !userSelectedModeRef.current &&
    !autoTableAppliedRef.current
  const activeMode: PluginCallGraphMode = shouldAutoTable ? 'table' : mode

  useEffect(() => {
    if (!shouldAutoTable) return
    autoTableAppliedRef.current = true
    setMode('table')
  }, [shouldAutoTable])

  const selectMode = (nextMode: PluginCallGraphMode) => {
    userSelectedModeRef.current = true
    setSelection(null)
    setMode(nextMode)
  }
  const changeQuery = (nextQuery: string) => {
    setQuery(nextQuery)
    setSelection(null)
  }
  const graphColorMode: ColorMode =
    resolvedTheme === 'dark' || resolvedTheme === 'light'
      ? resolvedTheme
      : 'system'

  const locale = i18n.resolvedLanguage || i18n.language
  const localizedStrings = useMemo(() => {
    const formatLastCall = (timestamp: number) =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(timestamp)
    const callsLabel = (count: number) =>
      t(`${KEY_ROOT}.counts.calls`, { count })
    const statuses: PluginCallGraphInspectorStrings['statuses'] = {
      active: t(`${KEY_ROOT}.statuses.active`),
      inactive: t(`${KEY_ROOT}.statuses.inactive`),
      disabled: t(`${KEY_ROOT}.statuses.disabled`),
      error: t(`${KEY_ROOT}.statuses.error`),
      missing: t(`${KEY_ROOT}.statuses.missing`),
    }
    const toolbar: PluginCallGraphToolbarStrings = {
      toolbarLabel: t(`${KEY_ROOT}.toolbarLabel`),
      modeLabel: t(`${KEY_ROOT}.modeLabel`),
      graphMode: t(`${KEY_ROOT}.modes.graph`),
      tableMode: t(`${KEY_ROOT}.modes.table`),
      omniSearch: {
        searchLabel: t(`${KEY_ROOT}.filters.searchLabel`),
        searchPlaceholder: t(`${KEY_ROOT}.filters.searchPlaceholder`),
        clearSearch: t(`${KEY_ROOT}.filters.clearSearch`),
        pluginsGroup: t(`${KEY_ROOT}.filters.pluginsGroup`),
        commandsGroup: t(`${KEY_ROOT}.filters.commandsGroup`),
        noSuggestions: t(`${KEY_ROOT}.filters.noSuggestions`),
      },
      refresh: t(`${KEY_ROOT}.refresh`),
      refreshing: t(`${KEY_ROOT}.refreshing`),
      refreshTooltip: t(`${KEY_ROOT}.refreshTooltip`),
      renderGraphTooltip: t(`${KEY_ROOT}.renderGraphTooltip`),
    }
    const inspector: PluginCallGraphInspectorStrings = {
      inspectorLabel: t(`${KEY_ROOT}.inspector.label`),
      scopeTitle: t(`${KEY_ROOT}.inspector.scopeTitle`),
      neutralScope: t(`${KEY_ROOT}.inspector.neutralScope`),
      pluginId: t(`${KEY_ROOT}.inspector.pluginId`),
      status: t(`${KEY_ROOT}.inspector.status`),
      statuses,
      incomingCalls: t(`${KEY_ROOT}.inspector.incomingCalls`),
      outgoingCalls: t(`${KEY_ROOT}.inspector.outgoingCalls`),
      connections: t(`${KEY_ROOT}.inspector.connections`),
      noConnections: t(`${KEY_ROOT}.inspector.noConnections`),
      openPlugin: t(`${KEY_ROOT}.inspector.openPlugin`),
      edgeTitle: t(`${KEY_ROOT}.inspector.edgeTitle`),
      caller: t(`${KEY_ROOT}.columns.caller`),
      callee: t(`${KEY_ROOT}.columns.callee`),
      totalCalls: t(`${KEY_ROOT}.inspector.totalCalls`),
      lastCall: t(`${KEY_ROOT}.columns.lastCall`),
      commands: t(`${KEY_ROOT}.inspector.commands`),
      callsLabel,
      formatLastCall,
    }
    const table: PluginCallGraphTableStrings = {
      tableRegionLabel: t(`${KEY_ROOT}.tableRegionLabel`),
      tableLabel: t(`${KEY_ROOT}.tableLabel`),
      caller: t(`${KEY_ROOT}.columns.caller`),
      command: t(`${KEY_ROOT}.columns.command`),
      callee: t(`${KEY_ROOT}.columns.callee`),
      calls: t(`${KEY_ROOT}.columns.calls`),
      lastCall: t(`${KEY_ROOT}.columns.lastCall`),
      filteredEmpty: t(`${KEY_ROOT}.filteredEmpty`),
      formatLastCall,
    }
    return { toolbar, inspector, table, statuses, callsLabel }
  }, [locale, t])

  const graphStrings = useMemo<PluginCallGraphStrings | null>(() => {
    if (!filteredModel) return null
    const localizedDirections: Record<string, string> = {
      left: t(`${KEY_ROOT}.aria.directions.left`),
      right: t(`${KEY_ROOT}.aria.directions.right`),
      up: t(`${KEY_ROOT}.aria.directions.up`),
      down: t(`${KEY_ROOT}.aria.directions.down`),
    }
    const ariaLabelConfig: AriaLabelConfig = {
      'node.a11yDescription.default': t(`${KEY_ROOT}.aria.nodeDescription`),
      'node.a11yDescription.keyboardDisabled': t(
        `${KEY_ROOT}.aria.nodeKeyboardInstruction`
      ),
      'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }) =>
        t(`${KEY_ROOT}.aria.nodeMoved`, {
          direction: localizedDirections[direction] ?? direction,
          x,
          y,
        }),
      'edge.a11yDescription.default': t(`${KEY_ROOT}.aria.edgeDescription`),
      'controls.ariaLabel': t(`${KEY_ROOT}.aria.controls`),
      'controls.zoomIn.ariaLabel': t(`${KEY_ROOT}.aria.zoomIn`),
      'controls.zoomOut.ariaLabel': t(`${KEY_ROOT}.aria.zoomOut`),
      'controls.fitView.ariaLabel': t(`${KEY_ROOT}.aria.fitView`),
      'controls.interactive.ariaLabel': t(`${KEY_ROOT}.aria.interactive`),
      'minimap.ariaLabel': t(`${KEY_ROOT}.aria.minimap`),
      'handle.ariaLabel': t(`${KEY_ROOT}.aria.handle`),
    }
    return {
      graphAriaLabel: t(`${KEY_ROOT}.aria.graphLabel`),
      graphDescription: t(`${KEY_ROOT}.aria.graphDescription`, {
        nodeCount: filteredModel.nodes.length,
        pairCount: filteredModel.pairEdges.length,
      }),
      layoutError: t(`${KEY_ROOT}.errors.layout`),
      retryLayout: t(`${KEY_ROOT}.errors.layoutRetry`),
      legend: {
        label: t(`${KEY_ROOT}.legend.label`),
        fewerCalls: t(`${KEY_ROOT}.legend.fewerCalls`),
        moreCalls: t(`${KEY_ROOT}.legend.moreCalls`),
      },
      node: {
        statuses: localizedStrings.statuses,
        incoming: localizedStrings.inspector.incomingCalls,
        outgoing: localizedStrings.inspector.outgoingCalls,
      },
      ariaLabelConfig,
      nodeAriaLabel: (node) =>
        t(`${KEY_ROOT}.aria.nodeLabel`, {
          name: node.name,
          id: node.id,
          status: localizedStrings.statuses[node.status],
          incoming: node.incomingCalls,
          outgoing: node.outgoingCalls,
        }),
      edgeAriaLabel: (edge) =>
        t(`${KEY_ROOT}.aria.edgeLabel`, {
          source: edge.source,
          target: edge.target,
          calls: edge.totalCalls,
          commands: edge.commandCount,
        }),
      callsLabel: localizedStrings.callsLabel,
      commandsLabel: (count) => t(`${KEY_ROOT}.counts.commands`, { count }),
    }
  }, [filteredModel, localizedStrings, t])

  const graphError = {
    title: t(`${KEY_ROOT}.errors.graphTitle`),
    description: t(`${KEY_ROOT}.errors.graphDescription`),
    retryLabel: t(`${KEY_ROOT}.errors.graphRetry`),
  }
  const metadataError = {
    title: t(`${KEY_ROOT}.errors.metadataTitle`),
    description: t(`${KEY_ROOT}.errors.metadataDescription`),
    retryLabel: t(`${KEY_ROOT}.errors.metadataRetry`),
  }

  let content: ReactNode
  if (!graph.data && graph.status === 'error') {
    content = (
      <ErrorState
        {...graphError}
        onRetry={() => {
          void graph.refresh()
        }}
      />
    )
  } else if (!graph.data) {
    content = <PendingState message={t(`${KEY_ROOT}.loading.graph`)} />
  } else if (metadata.status === 'error') {
    content = (
      <ErrorState
        {...metadataError}
        onRetry={() => {
          void metadata.refresh()
        }}
      />
    )
  } else if (metadata.status !== 'success' || !metadata.data) {
    content = <PendingState message={t(`${KEY_ROOT}.loading.metadata`)} />
  } else if (baseModel && filteredModel && graphStrings) {
    const globallyEmpty = baseModel.emptyState === 'global-empty'
    const filteredEmpty = filteredModel.emptyState === 'filtered-empty'

    content = (
      <>
        {graph.status === 'error' && (
          <ErrorState
            {...graphError}
            compact
            onRetry={() => {
              void graph.refresh()
            }}
          />
        )}

        {graph.data.truncated && (
          <div
            role="status"
            className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
          >
            {t(`${KEY_ROOT}.truncated`)}
          </div>
        )}

        <PluginCallGraphToolbar
          mode={activeMode}
          onModeChange={selectMode}
          query={query}
          onQueryChange={changeQuery}
          nodes={baseModel.nodes}
          commandEdges={baseModel.commandEdges}
          density={density}
          isRefreshing={graph.isRefreshing}
          onRefresh={() => {
            void graph.refresh()
          }}
          modeIds={MODE_IDS}
          strings={localizedStrings.toolbar}
        />

        <div
          id={MODE_IDS.graph.panelId}
          role="tabpanel"
          aria-labelledby={MODE_IDS.graph.triggerId}
          hidden={activeMode !== 'graph'}
          className={
            activeMode === 'graph'
              ? 'flex min-h-0 flex-1 overflow-hidden'
              : 'hidden'
          }
        >
          {activeMode === 'graph' &&
            (globallyEmpty ? (
              <EmptyState
                title={t(`${KEY_ROOT}.globalEmpty.title`)}
                description={t(`${KEY_ROOT}.globalEmpty.description`)}
              />
            ) : filteredEmpty ? (
              <EmptyState description={t(`${KEY_ROOT}.filteredEmpty`)} />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden @[48rem]/call-graph:flex-row">
                <div className="flex min-h-0 flex-1 overflow-hidden">
                  <PluginCallGraphErrorBoundary
                    strings={{
                      title: t(`${KEY_ROOT}.errors.canvasTitle`),
                      description: t(`${KEY_ROOT}.errors.canvasDescription`),
                      retry: t(`${KEY_ROOT}.errors.canvasRetry`),
                      switchToTable: t(`${KEY_ROOT}.errors.canvasTable`),
                    }}
                    onSwitchToTable={() => selectMode('table')}
                  >
                    <PluginCallGraph
                      model={filteredModel}
                      density={density}
                      strings={graphStrings}
                      colorMode={graphColorMode}
                      selectionResetKey={query}
                      showLegend={
                        !graph.isRefreshing && graph.status !== 'error'
                      }
                      onSelectionChange={setSelection}
                    />
                  </PluginCallGraphErrorBoundary>
                </div>
                <div className="flex min-h-0 shrink-[1] basis-40 @[48rem]/call-graph:w-72 @[48rem]/call-graph:shrink-0 @[48rem]/call-graph:basis-auto [&>aside]:flex-1">
                  <PluginCallGraphInspector
                    model={filteredModel}
                    selection={selection}
                    strings={localizedStrings.inspector}
                  />
                </div>
              </div>
            ))}
        </div>

        <div
          id={MODE_IDS.table.panelId}
          role="tabpanel"
          aria-labelledby={MODE_IDS.table.triggerId}
          hidden={activeMode !== 'table'}
          className={
            activeMode === 'table'
              ? 'flex min-h-0 flex-1 overflow-hidden'
              : 'hidden'
          }
        >
          {activeMode === 'table' &&
            (globallyEmpty ? (
              <EmptyState
                title={t(`${KEY_ROOT}.globalEmpty.title`)}
                description={t(`${KEY_ROOT}.globalEmpty.description`)}
              />
            ) : (
              <PluginCallGraphTable
                rows={filteredModel.tableRows}
                strings={localizedStrings.table}
              />
            ))}
        </div>
      </>
    )
  } else {
    content = <PendingState message={t(`${KEY_ROOT}.loading.metadata`)} />
  }

  return (
    <PanelShell
      title={t('plugins.diagnostics.title')}
      contentClassName="overflow-hidden px-6 pb-6"
    >
      <p className="shrink-0 pb-3 text-sm text-muted-foreground">
        {t('plugins.diagnostics.intro')}
      </p>
      <div
        data-testid="plugin-call-graph-container"
        className="@container/call-graph flex min-h-0 flex-1 flex-col gap-3"
      >
        {content}
      </div>
    </PanelShell>
  )
}
