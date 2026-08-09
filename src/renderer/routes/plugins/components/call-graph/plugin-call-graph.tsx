import { Button } from '@renderer/components/ui/button'
import {
  type AriaLabelConfig,
  Background,
  type ColorMode,
  Controls,
  type EdgeChange,
  type EdgeSelectionChange,
  MarkerType,
  MiniMap,
  type NodeChange,
  type NodeSelectionChange,
  Panel,
  ReactFlow,
  type ReactFlowInstance,
  useNodesState,
} from '@xyflow/react'
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  type CallGraphNodeLayout,
  layoutCallGraphNodes,
} from '../../lib/call-graph-layout'
import type {
  CallGraphDensity,
  CallGraphModel,
  CallGraphNodeModel,
  CallGraphPairEdgeModel,
} from '../../lib/call-graph-model'
import {
  PluginCallGraphEdge,
  type PluginCallGraphEdgeType,
} from './plugin-call-graph-edge'
import {
  PluginCallGraphLegend,
  type PluginCallGraphLegendStrings,
} from './plugin-call-graph-legend'
import {
  PluginCallGraphNode,
  type PluginCallGraphNodeStrings,
  type PluginCallGraphNodeType,
} from './plugin-call-graph-node'

const NODE_WIDTH = 224
const NODE_HEIGHT = 88
const FIT_VIEW_OPTIONS = { padding: 0.16 } as const

const nodeTypes = { pluginCallGraph: PluginCallGraphNode }
const edgeTypes = { pluginCallGraph: PluginCallGraphEdge }

export type PluginCallGraphSelection =
  | { type: 'node'; node: CallGraphNodeModel }
  | { type: 'edge'; edge: CallGraphPairEdgeModel }
  | null

export interface PluginCallGraphStrings {
  graphAriaLabel: string
  graphDescription: string
  layoutError: string
  retryLayout: string
  legend: PluginCallGraphLegendStrings
  node: PluginCallGraphNodeStrings
  ariaLabelConfig: AriaLabelConfig
  nodeAriaLabel: (node: CallGraphNodeModel) => string
  edgeAriaLabel: (edge: CallGraphPairEdgeModel) => string
  callsLabel: (count: number) => string
  commandsLabel: (count: number) => string
}

export interface PluginCallGraphProps {
  model: CallGraphModel
  density: CallGraphDensity
  strings: PluginCallGraphStrings
  colorMode?: ColorMode
  iconsByPluginId?: Readonly<Record<string, string | undefined>>
  onNodeSelect?: (node: CallGraphNodeModel) => void
  onEdgeSelect?: (edge: CallGraphPairEdgeModel) => void
  onSelectionChange?: (selection: PluginCallGraphSelection) => void
  selectionResetKey?: string | number
  showLegend?: boolean
  layoutNodes?: typeof layoutCallGraphNodes
}

interface InteractionTarget {
  type: 'node' | 'edge'
  id: string
}

interface NotifiedSelectionPayload extends InteractionTarget {
  fingerprint: string
}

interface LatestInput {
  model: CallGraphModel
  strings: PluginCallGraphStrings
  iconsByPluginId: PluginCallGraphProps['iconsByPluginId']
}

function pairEdgeId(edge: Pick<CallGraphPairEdgeModel, 'source' | 'target'>) {
  return JSON.stringify([edge.source, edge.target])
}

function comparePairEdgeId(
  left: Pick<CallGraphPairEdgeModel, 'source' | 'target'>,
  right: Pick<CallGraphPairEdgeModel, 'source' | 'target'>
): number {
  if (left.source < right.source) return -1
  if (left.source > right.source) return 1
  if (left.target < right.target) return -1
  if (left.target > right.target) return 1
  return 0
}

function nodeSelectionFingerprint(node: CallGraphNodeModel): string {
  return JSON.stringify([
    node.id,
    node.name,
    node.installed,
    node.status,
    node.incomingCalls,
    node.outgoingCalls,
  ])
}

function edgeSelectionFingerprint(edge: CallGraphPairEdgeModel): string {
  return JSON.stringify([
    edge.source,
    edge.target,
    edge.totalCalls,
    edge.commandCount,
    edge.lastCalledAt,
    edge.strokeWidth,
    edge.commands.map((command) => [
      command.commandId,
      command.calls,
      command.lastCalledAt,
    ]),
  ])
}

function createFlowNodes(
  input: LatestInput,
  layout: CallGraphNodeLayout
): PluginCallGraphNodeType[] {
  return input.model.nodes.map((model) => {
    const position = layout.positions[model.id]
    if (!position) {
      throw new Error(`Missing layout position for plugin node "${model.id}"`)
    }

    return {
      id: model.id,
      type: 'pluginCallGraph',
      position,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      initialWidth: NODE_WIDTH,
      initialHeight: NODE_HEIGHT,
      draggable: true,
      selectable: true,
      connectable: false,
      deletable: false,
      focusable: true,
      ariaRole: 'button',
      className: 'group outline-none',
      ariaLabel: input.strings.nodeAriaLabel(model),
      data: {
        model,
        icon: input.iconsByPluginId?.[model.id],
        strings: input.strings.node,
      },
    }
  })
}

function reconcileNodeData(
  nodes: PluginCallGraphNodeType[],
  input: LatestInput
): PluginCallGraphNodeType[] {
  const modelsById = new Map(input.model.nodes.map((node) => [node.id, node]))

  return nodes.map((node) => {
    const model = modelsById.get(node.id)
    if (!model) return node
    return {
      ...node,
      ariaLabel: input.strings.nodeAriaLabel(model),
      data: {
        ...node.data,
        model,
        icon: input.iconsByPluginId?.[model.id],
        strings: input.strings.node,
      },
    }
  })
}

function clearSelection(
  selectionRef: MutableRefObject<InteractionTarget | null>,
  notifiedPayloadRef: MutableRefObject<NotifiedSelectionPayload | null>,
  setSelection: Dispatch<SetStateAction<InteractionTarget | null>>,
  callback?: (selection: PluginCallGraphSelection) => void
) {
  const hadSelection = selectionRef.current !== null
  selectionRef.current = null
  notifiedPayloadRef.current = null
  setSelection(null)
  if (hadSelection) callback?.(null)
}

export function PluginCallGraph({
  model,
  density,
  strings,
  colorMode = 'system',
  iconsByPluginId,
  onNodeSelect,
  onEdgeSelect,
  onSelectionChange,
  selectionResetKey,
  showLegend = true,
  layoutNodes = layoutCallGraphNodes,
}: PluginCallGraphProps) {
  const descriptionId = useId()
  const [nodes, setNodes, applyNodeChanges] =
    useNodesState<PluginCallGraphNodeType>([])
  const [renderedModel, setRenderedModel] = useState<CallGraphModel | null>(
    null
  )
  const [selection, setSelection] = useState<InteractionTarget | null>(null)
  const [hovered, setHovered] = useState<InteractionTarget | null>(null)
  const [layoutFailed, setLayoutFailed] = useState(false)
  const [layoutAttempt, setLayoutAttempt] = useState(0)
  const selectionRef = useRef<InteractionTarget | null>(null)
  const notifiedPayloadRef = useRef<NotifiedSelectionPayload | null>(null)
  const selectionResetKeyRef = useRef(selectionResetKey)
  const latestInputRef = useRef<LatestInput>({
    model,
    strings,
    iconsByPluginId,
  })
  const layoutCacheRef = useRef<CallGraphNodeLayout | null>(null)
  const appliedSignatureRef = useRef<string | null>(null)
  const layoutGenerationRef = useRef(0)
  const flowRef = useRef<ReactFlowInstance<
    PluginCallGraphNodeType,
    PluginCallGraphEdgeType
  > | null>(null)
  const pendingFitRef = useRef(false)
  const shouldResetSelection = !Object.is(
    selectionResetKeyRef.current,
    selectionResetKey
  )

  latestInputRef.current = { model, strings, iconsByPluginId }

  useLayoutEffect(() => {
    if (!shouldResetSelection) return
    selectionResetKeyRef.current = selectionResetKey
    clearSelection(
      selectionRef,
      notifiedPayloadRef,
      setSelection,
      onSelectionChange
    )
  }, [onSelectionChange, selectionResetKey, shouldResetSelection])

  const commitNodeSelection = useCallback(
    (node: CallGraphNodeModel) => {
      const next = { type: 'node' as const, id: node.id }
      const fingerprint = nodeSelectionFingerprint(node)
      const sameTarget =
        selectionRef.current?.type === next.type &&
        selectionRef.current.id === next.id
      if (
        sameTarget &&
        notifiedPayloadRef.current?.type === next.type &&
        notifiedPayloadRef.current.id === next.id &&
        notifiedPayloadRef.current.fingerprint === fingerprint
      ) {
        return
      }
      if (!sameTarget) {
        selectionRef.current = next
        setSelection(next)
      }
      notifiedPayloadRef.current = { ...next, fingerprint }
      onNodeSelect?.(node)
      onSelectionChange?.({ type: 'node', node })
    },
    [onNodeSelect, onSelectionChange]
  )

  const commitEdgeSelection = useCallback(
    (edge: CallGraphPairEdgeModel) => {
      const next = { type: 'edge' as const, id: pairEdgeId(edge) }
      const fingerprint = edgeSelectionFingerprint(edge)
      const sameTarget =
        selectionRef.current?.type === next.type &&
        selectionRef.current.id === next.id
      if (
        sameTarget &&
        notifiedPayloadRef.current?.type === next.type &&
        notifiedPayloadRef.current.id === next.id &&
        notifiedPayloadRef.current.fingerprint === fingerprint
      ) {
        return
      }
      if (!sameTarget) {
        selectionRef.current = next
        setSelection(next)
      }
      notifiedPayloadRef.current = { ...next, fingerprint }
      onEdgeSelect?.(edge)
      onSelectionChange?.({ type: 'edge', edge })
    },
    [onEdgeSelect, onSelectionChange]
  )

  const commitCurrentSelection = useCallback(
    (target: InteractionTarget): boolean => {
      const currentModel = latestInputRef.current.model
      if (target.type === 'node') {
        const node = currentModel.nodes.find(
          (candidate) => candidate.id === target.id
        )
        if (!node) return false
        commitNodeSelection(node)
        return true
      }

      const edge = currentModel.pairEdges.find(
        (candidate) => pairEdgeId(candidate) === target.id
      )
      if (!edge) return false
      commitEdgeSelection(edge)
      return true
    },
    [commitEdgeSelection, commitNodeSelection]
  )

  const handleNodesChange = useCallback(
    (changes: NodeChange<PluginCallGraphNodeType>[]) => {
      applyNodeChanges(changes)
      const selectedChange = changes.find(
        (change): change is NodeSelectionChange =>
          change.type === 'select' && change.selected
      )
      if (selectedChange) {
        commitCurrentSelection({ type: 'node', id: selectedChange.id })
        return
      }

      const current = selectionRef.current
      if (
        current?.type === 'node' &&
        changes.some(
          (change) =>
            change.type === 'select' &&
            !change.selected &&
            change.id === current.id
        )
      ) {
        clearSelection(
          selectionRef,
          notifiedPayloadRef,
          setSelection,
          onSelectionChange
        )
      }
    },
    [applyNodeChanges, commitCurrentSelection, onSelectionChange]
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<PluginCallGraphEdgeType>[]) => {
      const selectedChange = changes.find(
        (change): change is EdgeSelectionChange =>
          change.type === 'select' && change.selected
      )
      if (selectedChange) {
        commitCurrentSelection({ type: 'edge', id: selectedChange.id })
        return
      }

      const current = selectionRef.current
      if (
        current?.type === 'edge' &&
        changes.some(
          (change) =>
            change.type === 'select' &&
            !change.selected &&
            change.id === current.id
        )
      ) {
        clearSelection(
          selectionRef,
          notifiedPayloadRef,
          setSelection,
          onSelectionChange
        )
      }
    },
    [commitCurrentSelection, onSelectionChange]
  )

  const fitCurrentGraph = useCallback(() => {
    if (!flowRef.current || !pendingFitRef.current) return
    pendingFitRef.current = false
    void flowRef.current.fitView(FIT_VIEW_OPTIONS)
  }, [])

  const handleInit = useCallback(
    (
      instance: ReactFlowInstance<
        PluginCallGraphNodeType,
        PluginCallGraphEdgeType
      >
    ) => {
      flowRef.current = instance
      fitCurrentGraph()
    },
    [fitCurrentGraph]
  )

  useEffect(() => {
    if (appliedSignatureRef.current !== model.signature) return
    const input = { model, strings, iconsByPluginId }
    setNodes((current) => reconcileNodeData(current, input))
    setRenderedModel(model)
  }, [model, setNodes, strings, iconsByPluginId])

  const layoutRequest = useMemo(
    () => ({ signature: model.signature, attempt: layoutAttempt, layoutNodes }),
    [model.signature, layoutAttempt, layoutNodes]
  )
  useEffect(() => {
    const signature = layoutRequest.signature
    const generation = layoutGenerationRef.current + 1
    layoutGenerationRef.current = generation
    const requestModel = latestInputRef.current.model
    const previousLayout = layoutCacheRef.current
    setLayoutFailed(false)

    void layoutRequest
      .layoutNodes(requestModel, previousLayout)
      .then((layout) => {
        if (
          layoutGenerationRef.current !== generation ||
          latestInputRef.current.model.signature !== signature
        ) {
          return
        }
        const input = latestInputRef.current
        const nextNodes = createFlowNodes(input, layout)
        layoutCacheRef.current = layout
        appliedSignatureRef.current = signature
        setNodes(nextNodes)
        setRenderedModel(input.model)
        setLayoutFailed(false)
        pendingFitRef.current = true
        queueMicrotask(fitCurrentGraph)
      })
      .catch(() => {
        if (
          layoutGenerationRef.current !== generation ||
          latestInputRef.current.model.signature !== signature
        ) {
          return
        }
        setLayoutFailed(true)
      })
  }, [fitCurrentGraph, layoutRequest, setNodes])

  useEffect(
    () => () => {
      layoutGenerationRef.current += 1
    },
    []
  )

  useEffect(() => {
    if (
      shouldResetSelection ||
      !selection ||
      latestInputRef.current.model !== model
    ) {
      return
    }
    if (commitCurrentSelection(selection)) return
    clearSelection(
      selectionRef,
      notifiedPayloadRef,
      setSelection,
      onSelectionChange
    )
  }, [
    commitCurrentSelection,
    model,
    onSelectionChange,
    selection,
    shouldResetSelection,
  ])

  useEffect(() => {
    if (!hovered) return
    const stillPresent =
      hovered.type === 'node'
        ? model.nodes.some((node) => node.id === hovered.id)
        : model.pairEdges.some((edge) => pairEdgeId(edge) === hovered.id)
    if (!stillPresent) setHovered(null)
  }, [hovered, model])

  const activeInteraction = hovered ?? selection
  const decorated = useMemo(() => {
    if (!renderedModel) {
      return {
        nodes: [] as PluginCallGraphNodeType[],
        edges: [] as PluginCallGraphEdgeType[],
      }
    }

    const connectedNodeIds = new Set<string>()
    const connectedEdgeIds = new Set<string>()
    if (activeInteraction?.type === 'node') {
      connectedNodeIds.add(activeInteraction.id)
      for (const edge of renderedModel.pairEdges) {
        if (
          edge.source !== activeInteraction.id &&
          edge.target !== activeInteraction.id
        ) {
          continue
        }
        connectedNodeIds.add(edge.source)
        connectedNodeIds.add(edge.target)
        connectedEdgeIds.add(pairEdgeId(edge))
      }
    } else if (activeInteraction?.type === 'edge') {
      const edge = renderedModel.pairEdges.find(
        (candidate) => pairEdgeId(candidate) === activeInteraction.id
      )
      if (edge) {
        connectedNodeIds.add(edge.source)
        connectedNodeIds.add(edge.target)
        connectedEdgeIds.add(activeInteraction.id)
      }
    }

    const decoratedNodes = nodes.map((node) => {
      const selected = selection?.type === 'node' && selection.id === node.id
      return {
        ...node,
        selected,
        domAttributes: {
          ...node.domAttributes,
          'aria-pressed': selected,
        },
        data: {
          ...node.data,
          connected: Boolean(
            activeInteraction && connectedNodeIds.has(node.id)
          ),
          dimmed: Boolean(activeInteraction && !connectedNodeIds.has(node.id)),
        },
      }
    })
    const compactLabelEdge = [...renderedModel.pairEdges].sort(
      (left, right) =>
        right.totalCalls - left.totalCalls ||
        right.commandCount - left.commandCount ||
        comparePairEdgeId(left, right)
    )[0]
    const compactLabelEdgeId = compactLabelEdge
      ? pairEdgeId(compactLabelEdge)
      : null
    const decoratedEdges = renderedModel.pairEdges.map(
      (modelEdge): PluginCallGraphEdgeType => {
        const id = pairEdgeId(modelEdge)
        return {
          id,
          type: 'pluginCallGraph',
          source: modelEdge.source,
          target: modelEdge.target,
          animated: false,
          selectable: true,
          deletable: false,
          reconnectable: false,
          focusable: true,
          selected: selection?.type === 'edge' && selection.id === id,
          ariaRole: 'button',
          domAttributes: {
            'aria-pressed': selection?.type === 'edge' && selection.id === id,
          },
          markerEnd: { type: MarkerType.ArrowClosed },
          ariaLabel: strings.edgeAriaLabel(modelEdge),
          data: {
            model: modelEdge,
            callsLabel: strings.callsLabel(modelEdge.totalCalls),
            commandsLabel: strings.commandsLabel(modelEdge.commandCount),
            density,
            compactAtLowZoom: id === compactLabelEdgeId,
            highlighted: Boolean(activeInteraction && connectedEdgeIds.has(id)),
            dimmed: Boolean(activeInteraction && !connectedEdgeIds.has(id)),
          },
        }
      }
    )

    return { nodes: decoratedNodes, edges: decoratedEdges }
  }, [activeInteraction, density, nodes, renderedModel, selection, strings])
  const legendVisible =
    showLegend &&
    renderedModel?.signature === model.signature &&
    renderedModel.pairEdges.length > 0 &&
    !layoutFailed

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-background">
      <p id={descriptionId} className="sr-only">
        {strings.graphDescription}
      </p>
      <ReactFlow<PluginCallGraphNodeType, PluginCallGraphEdgeType>
        nodes={decorated.nodes}
        edges={decorated.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onInit={handleInit}
        onNodeClick={(_event, node) =>
          commitCurrentSelection({ type: 'node', id: node.id })
        }
        onEdgeClick={(_event, edge) =>
          commitCurrentSelection({ type: 'edge', id: edge.id })
        }
        onNodeMouseEnter={(_event, node) =>
          setHovered({ type: 'node', id: node.id })
        }
        onNodeMouseLeave={(_event, node) =>
          setHovered((current) =>
            current?.type === 'node' && current.id === node.id ? null : current
          )
        }
        onEdgeMouseEnter={(_event, edge) =>
          setHovered({ type: 'edge', id: edge.id })
        }
        onEdgeMouseLeave={(_event, edge) =>
          setHovered((current) =>
            current?.type === 'edge' && current.id === edge.id ? null : current
          )
        }
        onPaneClick={() =>
          clearSelection(
            selectionRef,
            notifiedPayloadRef,
            setSelection,
            onSelectionChange
          )
        }
        nodesConnectable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        elementsSelectable
        nodesFocusable
        edgesFocusable
        nodesDraggable
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        onlyRenderVisibleElements
        colorMode={colorMode}
        aria-label={strings.graphAriaLabel}
        aria-describedby={descriptionId}
        ariaLabelConfig={strings.ariaLabelConfig}
      >
        <Background gap={20} size={1} />
        <Controls
          aria-label={strings.ariaLabelConfig['controls.ariaLabel']}
          showInteractive={false}
        />
        {legendVisible && (
          <Panel position="bottom-center" className="pointer-events-none">
            <PluginCallGraphLegend strings={strings.legend} />
          </Panel>
        )}
        {density === 'full' && (
          <MiniMap
            ariaLabel={strings.ariaLabelConfig['minimap.ariaLabel']}
            className="hidden @[48rem]/call-graph:block"
            pannable
            zoomable
          />
        )}
      </ReactFlow>

      {layoutFailed && (
        <div
          role="alert"
          className="absolute inset-x-4 top-4 z-10 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-background/95 p-3 text-sm shadow-sm"
        >
          <span>{strings.layoutError}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setLayoutAttempt((attempt) => attempt + 1)}
          >
            {strings.retryLayout}
          </Button>
        </div>
      )}
    </div>
  )
}
