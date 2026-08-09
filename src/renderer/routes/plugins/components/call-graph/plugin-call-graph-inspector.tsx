import { Button } from '@renderer/components/ui/button'
import { useNavigate } from 'react-router'
import type {
  CallGraphModel,
  CallGraphNodeStatus,
} from '../../lib/call-graph-model'
import type { PluginCallGraphSelection } from './plugin-call-graph'

export interface PluginCallGraphInspectorStrings {
  inspectorLabel: string
  scopeTitle: string
  neutralScope: string
  pluginId: string
  status: string
  statuses: Record<CallGraphNodeStatus, string>
  incomingCalls: string
  outgoingCalls: string
  connections: string
  noConnections: string
  openPlugin: string
  edgeTitle: string
  caller: string
  callee: string
  totalCalls: string
  lastCall: string
  commands: string
  callsLabel: (count: number) => string
  formatLastCall: (timestamp: number) => string
}

export interface PluginCallGraphInspectorProps {
  model: CallGraphModel
  selection: PluginCallGraphSelection
  strings: PluginCallGraphInspectorStrings
}

interface PluginConnection {
  id: string
  name: string
  calls: number
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function getPluginConnections(
  model: CallGraphModel,
  pluginId: string
): PluginConnection[] {
  const callsByPluginId = new Map<string, number>()

  for (const edge of model.pairEdges) {
    let connectedPluginId: string | null = null
    if (edge.source === pluginId && edge.target !== pluginId) {
      connectedPluginId = edge.target
    } else if (edge.target === pluginId && edge.source !== pluginId) {
      connectedPluginId = edge.source
    }
    if (!connectedPluginId) continue

    callsByPluginId.set(
      connectedPluginId,
      (callsByPluginId.get(connectedPluginId) ?? 0) + edge.totalCalls
    )
  }

  const nodesById = new Map(model.nodes.map((node) => [node.id, node]))
  return [...callsByPluginId.entries()]
    .map(([id, calls]) => ({
      id,
      name: nodesById.get(id)?.name ?? id,
      calls,
    }))
    .sort(
      (left, right) =>
        right.calls - left.calls || compareStrings(left.id, right.id)
    )
}

function Identifier({ value }: { value: string }) {
  return (
    <code className="text-xs text-foreground">
      <bdi dir="ltr">{value}</bdi>
    </code>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">{value}</dd>
    </div>
  )
}

function resolveSelection(
  model: CallGraphModel,
  selection: PluginCallGraphSelection
): PluginCallGraphSelection {
  if (selection?.type === 'node') {
    const node = model.nodes.find(
      (candidate) => candidate.id === selection.node.id
    )
    return node ? { type: 'node', node } : null
  }
  if (selection?.type === 'edge') {
    const edge = model.pairEdges.find(
      (candidate) =>
        candidate.source === selection.edge.source &&
        candidate.target === selection.edge.target
    )
    return edge ? { type: 'edge', edge } : null
  }
  return null
}

export function PluginCallGraphInspector({
  model,
  selection,
  strings,
}: PluginCallGraphInspectorProps) {
  const navigate = useNavigate()
  const currentSelection = resolveSelection(model, selection)
  const connections =
    currentSelection?.type === 'node'
      ? getPluginConnections(model, currentSelection.node.id)
      : []

  return (
    <aside
      aria-label={strings.inspectorLabel}
      className="min-h-0 overflow-auto rounded-md border border-border bg-card p-4"
    >
      {!currentSelection && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">{strings.scopeTitle}</h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {strings.neutralScope}
          </p>
        </div>
      )}

      {currentSelection?.type === 'node' && (
        <div className="space-y-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">
              {currentSelection.node.name}
            </h2>
          </div>

          <dl className="space-y-2">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-xs text-muted-foreground">
                {strings.pluginId}
              </dt>
              <dd>
                <Identifier value={currentSelection.node.id} />
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-xs text-muted-foreground">
                {strings.status}
              </dt>
              <dd className="text-sm">
                {strings.statuses[currentSelection.node.status]}
              </dd>
            </div>
            <Metric
              label={strings.incomingCalls}
              value={currentSelection.node.incomingCalls}
            />
            <Metric
              label={strings.outgoingCalls}
              value={currentSelection.node.outgoingCalls}
            />
          </dl>

          <div className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              {strings.connections}
            </h3>
            {connections.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {strings.noConnections}
              </p>
            ) : (
              <ul aria-label={strings.connections} className="space-y-2">
                {connections.map((connection) => (
                  <li
                    key={connection.id}
                    className="flex items-start justify-between gap-3 text-xs"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium">
                        {connection.name}
                      </span>
                      <Identifier value={connection.id} />
                    </span>
                    <span className="shrink-0 text-right tabular-nums text-muted-foreground">
                      {strings.callsLabel(connection.calls)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {currentSelection.node.installed && (
            <Button
              type="button"
              size="sm"
              onClick={() =>
                navigate(
                  `/plugins/${encodeURIComponent(currentSelection.node.id)}`
                )
              }
            >
              {strings.openPlugin}
            </Button>
          )}
        </div>
      )}

      {currentSelection?.type === 'edge' && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold">{strings.edgeTitle}</h2>
          <dl className="space-y-2">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-xs text-muted-foreground">
                {strings.caller}
              </dt>
              <dd>
                <Identifier value={currentSelection.edge.source} />
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-xs text-muted-foreground">
                {strings.callee}
              </dt>
              <dd>
                <Identifier value={currentSelection.edge.target} />
              </dd>
            </div>
            <Metric
              label={strings.totalCalls}
              value={currentSelection.edge.totalCalls}
            />
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-xs text-muted-foreground">
                {strings.lastCall}
              </dt>
              <dd className="text-right text-xs">
                <time
                  dateTime={new Date(
                    currentSelection.edge.lastCalledAt
                  ).toISOString()}
                >
                  {strings.formatLastCall(currentSelection.edge.lastCalledAt)}
                </time>
              </dd>
            </div>
          </dl>

          <div className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              {strings.commands}
            </h3>
            <ul aria-label={strings.commands} className="space-y-2">
              {currentSelection.edge.commands.map((command) => (
                <li
                  key={command.commandId}
                  className="flex items-start justify-between gap-3 text-xs"
                >
                  <Identifier value={command.commandId} />
                  <span className="shrink-0 text-right tabular-nums text-muted-foreground">
                    {strings.callsLabel(command.calls)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </aside>
  )
}
