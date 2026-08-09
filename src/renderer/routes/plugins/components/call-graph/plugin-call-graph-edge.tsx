import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  useViewport,
} from '@xyflow/react'
import type {
  CallGraphDensity,
  CallGraphPairEdgeModel,
} from '../../lib/call-graph-model'

export interface PluginCallGraphEdgeData extends Record<string, unknown> {
  model: CallGraphPairEdgeModel
  callsLabel: string
  commandsLabel: string
  density: CallGraphDensity
  compactAtLowZoom?: boolean
  highlighted?: boolean
  dimmed?: boolean
}

export type PluginCallGraphEdgeType = Edge<
  PluginCallGraphEdgeData,
  'pluginCallGraph'
>

const FEEDBACK_EDGE_CLEARANCE = 80
const MIN_READABLE_LABEL_ZOOM = 0.7

export function PluginCallGraphEdge({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  selected,
  style,
  data,
}: EdgeProps<PluginCallGraphEdgeType>) {
  const { zoom } = useViewport()
  if (!data) return null

  const centerY =
    sourceX > targetX
      ? Math.max(sourceY, targetY) + FEEDBACK_EDGE_CLEARANCE
      : undefined
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    ...(centerY === undefined ? {} : { centerY }),
  })
  const lowZoom = zoom < MIN_READABLE_LABEL_ZOOM
  const compactLowZoom =
    lowZoom && !selected && data.density === 'full' && data.compactAtLowZoom
  const showLabel =
    selected || (data.density === 'full' && (!lowZoom || data.compactAtLowZoom))
  const preserveScreenScale = lowZoom && (selected || compactLowZoom)
  const label = compactLowZoom
    ? data.callsLabel
    : data.model.commandCount > 1
      ? `${data.callsLabel} · ${data.commandsLabel}`
      : data.callsLabel

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        data-selected={selected ? 'true' : 'false'}
        data-highlighted={data.highlighted ? 'true' : 'false'}
        data-dimmed={data.dimmed ? 'true' : 'false'}
        className={
          selected || data.highlighted
            ? 'stroke-primary'
            : 'stroke-muted-foreground'
        }
        style={{
          ...style,
          strokeWidth: data.model.strokeWidth,
          opacity: data.dimmed ? 0.2 : 1,
        }}
      />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute"
            style={{
              transform: `translate(${labelX}px, ${labelY}px)`,
              opacity: data.dimmed ? 0.25 : 1,
            }}
          >
            <div
              data-testid="edge-label"
              className={`rounded border border-border bg-background/95 px-1.5 py-0.5 text-[10px] text-foreground shadow-xs ${
                preserveScreenScale
                  ? 'max-w-[88px] whitespace-normal text-center leading-tight'
                  : 'whitespace-nowrap'
              }`}
              style={{
                transform: `translate(-50%, -50%) scale(${preserveScreenScale ? 1 / zoom : 1})`,
                transformOrigin: 'center',
              }}
            >
              {label}
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
