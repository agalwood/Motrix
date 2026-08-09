import type { PluginListDTO, PluginStatus } from '@shared/types/plugin'
import type {
  PluginCommandGraphDTO,
  PluginCommandGraphEdge,
} from '@shared/types/plugin-command-graph'

export type CallGraphNodeStatus = PluginStatus | 'missing'
export type CallGraphEmptyState = 'none' | 'global-empty' | 'filtered-empty'
export type CallGraphDensity = 'full' | 'reduced' | 'table-first'

export interface CallGraphNodeModel {
  id: string
  name: string
  installed: boolean
  status: CallGraphNodeStatus
  incomingCalls: number
  outgoingCalls: number
}

export interface CallGraphCommandBreakdown {
  commandId: string
  calls: number
  lastCalledAt: number
}

export interface CallGraphPairEdgeModel {
  source: string
  target: string
  totalCalls: number
  commandCount: number
  lastCalledAt: number
  commands: ReadonlyArray<CallGraphCommandBreakdown>
  strokeWidth: number
}

export interface CallGraphTableRow {
  sourcePluginId: string
  sourcePluginName: string
  targetPluginId: string
  targetPluginName: string
  commandId: string
  calls: number
  lastCalledAt: number
}

export interface CallGraphModel {
  commandEdges: ReadonlyArray<PluginCommandGraphEdge>
  nodes: ReadonlyArray<CallGraphNodeModel>
  pairEdges: ReadonlyArray<CallGraphPairEdgeModel>
  tableRows: ReadonlyArray<CallGraphTableRow>
  signature: string
  emptyState: CallGraphEmptyState
}

export interface CallGraphFilters {
  search?: string
}

interface PluginIdentity {
  id: string
  name: string
  installed: boolean
  status: CallGraphNodeStatus
}

interface PairAccumulator {
  source: string
  target: string
  totalCalls: number
  lastCalledAt: number
  commands: CallGraphCommandBreakdown[]
}

const FULL_GRAPH_NODE_LIMIT = 100
const FULL_GRAPH_PAIR_EDGE_LIMIT = 300
const TABLE_FIRST_PAIR_EDGE_LIMIT = 500
const BASE_STROKE_WIDTH = 1.5
const MAX_STROKE_WIDTH_INCREASE = 4

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function compareCommandEdges(
  left: PluginCommandGraphEdge,
  right: PluginCommandGraphEdge
): number {
  return (
    compareStrings(left.sourcePluginId, right.sourcePluginId) ||
    compareStrings(left.targetPluginId, right.targetPluginId) ||
    compareStrings(left.commandId, right.commandId)
  )
}

function comparePairEdges(
  left: Pick<CallGraphPairEdgeModel, 'source' | 'target'>,
  right: Pick<CallGraphPairEdgeModel, 'source' | 'target'>
): number {
  return (
    compareStrings(left.source, right.source) ||
    compareStrings(left.target, right.target)
  )
}

function strokeWidth(totalCalls: number): number {
  return (
    BASE_STROKE_WIDTH +
    Math.min(MAX_STROKE_WIDTH_INCREASE, Math.log2(totalCalls + 1))
  )
}

function toInstalledPluginIdentities(
  plugins: ReadonlyArray<Pick<PluginListDTO, 'id' | 'name' | 'status'>>
): PluginIdentity[] {
  return plugins.map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    installed: true,
    status: plugin.status,
  }))
}

function buildModelFromCommandEdges(
  commandEdges: ReadonlyArray<PluginCommandGraphEdge>,
  pluginIdentities: ReadonlyArray<PluginIdentity>
): CallGraphModel {
  const sortedCommandEdges = commandEdges
    .map((edge) => ({ ...edge }))
    .sort(compareCommandEdges)
  const metadataById = new Map(
    pluginIdentities.map((plugin) => [plugin.id, plugin] as const)
  )
  const nodesById = new Map<string, CallGraphNodeModel>()

  const getNode = (id: string): CallGraphNodeModel => {
    const current = nodesById.get(id)
    if (current) return current
    const metadata = metadataById.get(id)
    const node: CallGraphNodeModel = {
      id,
      name: metadata?.name ?? id,
      installed: metadata?.installed ?? false,
      status: metadata?.status ?? 'missing',
      incomingCalls: 0,
      outgoingCalls: 0,
    }
    nodesById.set(id, node)
    return node
  }

  const pairsBySource = new Map<string, Map<string, PairAccumulator>>()
  for (const edge of sortedCommandEdges) {
    getNode(edge.sourcePluginId).outgoingCalls += edge.calls
    getNode(edge.targetPluginId).incomingCalls += edge.calls

    let targets = pairsBySource.get(edge.sourcePluginId)
    if (!targets) {
      targets = new Map()
      pairsBySource.set(edge.sourcePluginId, targets)
    }
    let pair = targets.get(edge.targetPluginId)
    if (!pair) {
      pair = {
        source: edge.sourcePluginId,
        target: edge.targetPluginId,
        totalCalls: 0,
        lastCalledAt: edge.lastCalledAt,
        commands: [],
      }
      targets.set(edge.targetPluginId, pair)
    }
    pair.totalCalls += edge.calls
    pair.lastCalledAt = Math.max(pair.lastCalledAt, edge.lastCalledAt)
    pair.commands.push({
      commandId: edge.commandId,
      calls: edge.calls,
      lastCalledAt: edge.lastCalledAt,
    })
  }

  const nodes = [...nodesById.values()].sort((left, right) =>
    compareStrings(left.id, right.id)
  )
  const pairEdges = [...pairsBySource.values()]
    .flatMap((targets) => [...targets.values()])
    .map((pair): CallGraphPairEdgeModel => {
      const commands = pair.commands.sort(
        (left, right) =>
          right.calls - left.calls ||
          compareStrings(left.commandId, right.commandId)
      )
      return {
        source: pair.source,
        target: pair.target,
        totalCalls: pair.totalCalls,
        commandCount: commands.length,
        lastCalledAt: pair.lastCalledAt,
        commands,
        strokeWidth: strokeWidth(pair.totalCalls),
      }
    })
    .sort(comparePairEdges)
  const tableRows = sortedCommandEdges
    .map(
      (edge): CallGraphTableRow => ({
        sourcePluginId: edge.sourcePluginId,
        sourcePluginName: nodesById.get(edge.sourcePluginId)?.name ?? '',
        targetPluginId: edge.targetPluginId,
        targetPluginName: nodesById.get(edge.targetPluginId)?.name ?? '',
        commandId: edge.commandId,
        calls: edge.calls,
        lastCalledAt: edge.lastCalledAt,
      })
    )
    .sort(
      (left, right) =>
        right.calls - left.calls ||
        compareStrings(left.sourcePluginId, right.sourcePluginId) ||
        compareStrings(left.targetPluginId, right.targetPluginId) ||
        compareStrings(left.commandId, right.commandId)
    )

  return {
    commandEdges: sortedCommandEdges,
    nodes,
    pairEdges,
    tableRows,
    signature: structuralSignature(nodes, pairEdges),
    emptyState: commandEdges.length === 0 ? 'global-empty' : 'none',
  }
}

export function structuralSignature(
  nodes: ReadonlyArray<Pick<CallGraphNodeModel, 'id'>>,
  pairEdges: ReadonlyArray<Pick<CallGraphPairEdgeModel, 'source' | 'target'>>
): string {
  const nodeIds = [...new Set(nodes.map((node) => node.id))].sort(
    compareStrings
  )
  const targetsBySource = new Map<string, Set<string>>()
  for (const edge of pairEdges) {
    let targets = targetsBySource.get(edge.source)
    if (!targets) {
      targets = new Set()
      targetsBySource.set(edge.source, targets)
    }
    targets.add(edge.target)
  }
  const pairs = [...targetsBySource.entries()]
    .flatMap(([source, targets]) =>
      [...targets].map((target) => [source, target] as const)
    )
    .sort(
      (left, right) =>
        compareStrings(left[0], right[0]) || compareStrings(left[1], right[1])
    )

  return JSON.stringify({ nodeIds, pairs })
}

export function buildCallGraphModel(
  graph: Readonly<Pick<PluginCommandGraphDTO, 'edges'>>,
  plugins: ReadonlyArray<Pick<PluginListDTO, 'id' | 'name' | 'status'>>
): CallGraphModel {
  return buildModelFromCommandEdges(
    graph.edges,
    toInstalledPluginIdentities(plugins)
  )
}

export function filterCommandEdges(
  model: CallGraphModel,
  filters: CallGraphFilters
): CallGraphModel {
  const search = filters.search?.trim().toLowerCase() ?? ''
  const namesById = new Map(
    model.nodes.map((node) => [node.id, node.name.toLowerCase()] as const)
  )

  const filteredCommandEdges = model.commandEdges.filter((edge) => {
    if (!search) return true

    return [
      edge.sourcePluginId,
      edge.targetPluginId,
      edge.commandId,
      namesById.get(edge.sourcePluginId) ?? edge.sourcePluginId,
      namesById.get(edge.targetPluginId) ?? edge.targetPluginId,
    ].some((value) => value.toLowerCase().includes(search))
  })
  const rebuilt = buildModelFromCommandEdges(filteredCommandEdges, model.nodes)

  if (
    filteredCommandEdges.length === 0 &&
    model.emptyState !== 'global-empty'
  ) {
    return { ...rebuilt, emptyState: 'filtered-empty' }
  }
  return rebuilt
}

export function getCallGraphDensity(
  nodeCount: number,
  pairEdgeCount: number
): CallGraphDensity {
  if (pairEdgeCount > TABLE_FIRST_PAIR_EDGE_LIMIT) return 'table-first'
  if (
    nodeCount > FULL_GRAPH_NODE_LIMIT ||
    pairEdgeCount > FULL_GRAPH_PAIR_EDGE_LIMIT
  ) {
    return 'reduced'
  }
  return 'full'
}
