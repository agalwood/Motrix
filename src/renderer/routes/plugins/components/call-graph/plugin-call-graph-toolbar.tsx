import { Button } from '@renderer/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import type { PluginCommandGraphEdge } from '@shared/types/plugin-command-graph'
import { RefreshCwIcon, Table2Icon, WorkflowIcon } from 'lucide-react'
import type {
  CallGraphDensity,
  CallGraphNodeModel,
} from '../../lib/call-graph-model'
import {
  PluginCallGraphOmniSearch,
  type PluginCallGraphOmniSearchStrings,
} from './plugin-call-graph-omni-search'

export type PluginCallGraphMode = 'graph' | 'table'

export interface PluginCallGraphModeAssociationIds {
  triggerId: string
  panelId: string
}

export interface PluginCallGraphModeIds {
  graph: PluginCallGraphModeAssociationIds
  table: PluginCallGraphModeAssociationIds
}

export interface PluginCallGraphToolbarStrings {
  toolbarLabel: string
  modeLabel: string
  graphMode: string
  tableMode: string
  omniSearch: PluginCallGraphOmniSearchStrings
  refresh: string
  refreshing: string
  refreshTooltip: string
  renderGraphTooltip: string
}

export interface PluginCallGraphToolbarProps {
  mode: PluginCallGraphMode
  onModeChange: (mode: PluginCallGraphMode) => void
  query: string
  onQueryChange: (query: string) => void
  nodes: ReadonlyArray<CallGraphNodeModel>
  commandEdges: ReadonlyArray<PluginCommandGraphEdge>
  density: CallGraphDensity
  isRefreshing: boolean
  onRefresh: () => void
  modeIds: PluginCallGraphModeIds
  strings: PluginCallGraphToolbarStrings
}

export function PluginCallGraphToolbar({
  mode,
  onModeChange,
  query,
  onQueryChange,
  nodes,
  commandEdges,
  density,
  isRefreshing,
  onRefresh,
  modeIds,
  strings,
}: PluginCallGraphToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label={strings.toolbarLabel}
      data-testid="plugin-call-graph-toolbar-primary"
      className="grid shrink-0 grid-cols-1 items-center gap-2 @[40rem]/call-graph:grid-cols-[minmax(0,1fr)_auto]"
    >
      <div className="min-w-0">
        <PluginCallGraphOmniSearch
          query={query}
          onQueryChange={(nextQuery) => onQueryChange(nextQuery)}
          nodes={nodes}
          commandEdges={commandEdges}
          strings={strings.omniSearch}
        />
      </div>

      <div
        data-testid="plugin-call-graph-toolbar-actions"
        className="flex items-center justify-self-end gap-2 whitespace-nowrap"
      >
        <Tabs
          value={mode}
          onValueChange={(value) => {
            if (value === 'graph' || value === 'table') onModeChange(value)
          }}
        >
          <TabsList
            aria-label={strings.modeLabel}
            className="rounded-md p-0.5 group-data-[orientation=horizontal]/tabs:h-9"
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <span>
                    <TabsTrigger
                      value="graph"
                      id={modeIds.graph.triggerId}
                      aria-controls={modeIds.graph.panelId}
                      aria-label={strings.graphMode}
                      className="size-8 flex-none p-0"
                    >
                      <WorkflowIcon aria-hidden="true" />
                    </TabsTrigger>
                  </span>
                }
              />
              <TooltipContent>
                {density === 'table-first' && mode === 'table'
                  ? strings.renderGraphTooltip
                  : strings.graphMode}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span>
                    <TabsTrigger
                      value="table"
                      id={modeIds.table.triggerId}
                      aria-controls={modeIds.table.panelId}
                      aria-label={strings.tableMode}
                      className="size-8 flex-none p-0"
                    >
                      <Table2Icon aria-hidden="true" />
                    </TabsTrigger>
                  </span>
                }
              />
              <TooltipContent>{strings.tableMode}</TooltipContent>
            </Tooltip>
          </TabsList>
        </Tabs>

        <Tooltip>
          <TooltipTrigger
            render={
              <span>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={
                    isRefreshing ? strings.refreshing : strings.refresh
                  }
                  aria-busy={isRefreshing}
                  disabled={isRefreshing}
                  onClick={onRefresh}
                >
                  <RefreshCwIcon
                    aria-hidden="true"
                    className={
                      isRefreshing
                        ? 'animate-spin motion-reduce:animate-none'
                        : undefined
                    }
                  />
                </Button>
              </span>
            }
          />
          <TooltipContent>
            {isRefreshing ? strings.refreshing : strings.refreshTooltip}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
