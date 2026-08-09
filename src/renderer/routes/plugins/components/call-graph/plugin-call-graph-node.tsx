import { PluginAvatar } from '@renderer/routes/plugins/components/plugin-avatar'
import { PluginStatusDot } from '@renderer/routes/plugins/components/plugin-status-dot'
import type { PluginStatus } from '@shared/types/plugin'
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import { ArrowDownLeft, ArrowUpRight, PackageX } from 'lucide-react'
import type {
  CallGraphNodeModel,
  CallGraphNodeStatus,
} from '../../lib/call-graph-model'

export interface PluginCallGraphNodeStrings {
  statuses: Record<CallGraphNodeStatus, string>
  incoming: string
  outgoing: string
}

export interface PluginCallGraphNodeData extends Record<string, unknown> {
  model: CallGraphNodeModel
  icon?: string
  strings: PluginCallGraphNodeStrings
  connected?: boolean
  dimmed?: boolean
}

export type PluginCallGraphNodeType = Node<
  PluginCallGraphNodeData,
  'pluginCallGraph'
>

function isPluginStatus(status: CallGraphNodeStatus): status is PluginStatus {
  return status !== 'missing'
}

export function PluginCallGraphNode({
  data,
  selected,
}: NodeProps<PluginCallGraphNodeType>) {
  const { model, strings } = data

  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        isConnectableStart={false}
        isConnectableEnd={false}
        className="!size-2 !border-border !bg-muted-foreground/60"
      />
      <div
        data-testid="plugin-call-graph-node"
        data-selected={selected ? 'true' : 'false'}
        data-connected={data.connected ? 'true' : 'false'}
        data-dimmed={data.dimmed ? 'true' : 'false'}
        className={`relative flex h-[88px] w-[224px] items-center gap-3 rounded-lg border bg-card px-3 py-2 text-left text-card-foreground shadow-sm transition-[border-color,box-shadow,opacity] motion-reduce:transition-none group-focus-visible:ring-2 group-focus-visible:ring-ring/50 ${
          selected
            ? 'border-primary ring-2 ring-primary/30'
            : data.connected
              ? 'border-primary/70 ring-1 ring-primary/20'
              : 'border-border'
        } ${data.dimmed ? 'opacity-35' : 'opacity-100'}`}
      >
        <PluginAvatar
          plugin={{ id: model.id, name: model.name, icon: data.icon }}
          size={40}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{model.name}</span>
            {isPluginStatus(model.status) ? (
              <PluginStatusDot
                status={model.status}
                enabled={model.status !== 'disabled'}
              />
            ) : (
              <PackageX
                data-missing-status-icon="true"
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            )}
          </div>
          <code className="block truncate text-[10px] text-muted-foreground">
            {model.id}
          </code>
          <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1 truncate">
              <span className="truncate">{strings.statuses[model.status]}</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-2 tabular-nums">
              <span className="inline-flex items-center gap-0.5">
                <span className="sr-only">
                  {strings.incoming}: {model.incomingCalls}
                </span>
                <ArrowDownLeft aria-hidden="true" className="size-3" />
                <span aria-hidden="true">{model.incomingCalls}</span>
              </span>
              <span className="inline-flex items-center gap-0.5">
                <span className="sr-only">
                  {strings.outgoing}: {model.outgoingCalls}
                </span>
                <ArrowUpRight aria-hidden="true" className="size-3" />
                <span aria-hidden="true">{model.outgoingCalls}</span>
              </span>
            </span>
          </div>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        isConnectableStart={false}
        isConnectableEnd={false}
        className="!size-2 !border-border !bg-muted-foreground/60"
      />
    </>
  )
}
