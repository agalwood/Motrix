import type { XYPosition } from '@xyflow/react'
import type { ElkNode } from 'elkjs'
import ELK from 'elkjs/lib/elk.bundled.js'
import type { CallGraphModel } from './call-graph-model'

export interface CallGraphNodeLayout {
  structuralSignature: string
  positions: Readonly<Record<string, XYPosition>>
}

export interface ElkLayoutAdapter {
  layout(graph: ElkNode): Promise<ElkNode>
}

const GRAPH_ID = 'plugin-call-graph'
const NODE_WIDTH = 224
const NODE_HEIGHT = 88
const ELK_LAYOUT_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '180',
} as const

const productionElk: ElkLayoutAdapter = new ELK()

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function isFinitePosition(value: unknown): value is XYPosition {
  if (!value || typeof value !== 'object') return false
  const position = value as { x?: unknown; y?: unknown }
  return (
    typeof position.x === 'number' &&
    Number.isFinite(position.x) &&
    typeof position.y === 'number' &&
    Number.isFinite(position.y)
  )
}

function hasExactPositions(
  nodes: CallGraphModel['nodes'],
  positions: CallGraphNodeLayout['positions']
): boolean {
  const expectedIds = new Set(nodes.map((node) => node.id))
  const positionIds = Reflect.ownKeys(positions)
  if (positionIds.length !== expectedIds.size) return false
  if (
    positionIds.some((id) => typeof id !== 'string' || !expectedIds.has(id))
  ) {
    return false
  }
  return nodes.every((node) => isFinitePosition(positions[node.id]))
}

function mapElkPositions(
  nodes: CallGraphModel['nodes'],
  children: ReadonlyArray<ElkNode>
): Readonly<Record<string, XYPosition>> {
  const expectedIds = new Set(nodes.map((node) => node.id))
  const seenIds = new Set<string>()
  const entries: Array<[string, XYPosition]> = []

  for (const child of children) {
    if (!expectedIds.has(child.id)) {
      throw new Error(`Invalid ELK layout: unknown node "${child.id}"`)
    }
    if (seenIds.has(child.id)) {
      throw new Error(`Invalid ELK layout: duplicate node "${child.id}"`)
    }
    if (!isFinitePosition(child)) {
      throw new Error(
        `Invalid ELK layout: node "${child.id}" must have finite x and y`
      )
    }
    seenIds.add(child.id)
    entries.push([child.id, { x: child.x, y: child.y }])
  }

  const missingNode = nodes.find((node) => !seenIds.has(node.id))
  if (missingNode) {
    throw new Error(`Invalid ELK layout: missing node "${missingNode.id}"`)
  }
  return Object.fromEntries(entries)
}

function toElkGraph(
  model: Pick<CallGraphModel, 'nodes' | 'pairEdges'>
): ElkNode {
  const children = [...model.nodes]
    .sort((left, right) => compareStrings(left.id, right.id))
    .map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    }))
  const edges = [...model.pairEdges]
    .sort(
      (left, right) =>
        compareStrings(left.source, right.source) ||
        compareStrings(left.target, right.target)
    )
    .map((edge, index) => ({
      id: `pair-${index}`,
      sources: [edge.source],
      targets: [edge.target],
    }))

  return {
    id: GRAPH_ID,
    layoutOptions: ELK_LAYOUT_OPTIONS,
    children,
    edges,
  }
}

export async function layoutCallGraphNodes(
  model: Pick<CallGraphModel, 'nodes' | 'pairEdges' | 'signature'>,
  previousLayout: CallGraphNodeLayout | null = null,
  elk: ElkLayoutAdapter = productionElk
): Promise<CallGraphNodeLayout> {
  if (
    previousLayout?.structuralSignature === model.signature &&
    hasExactPositions(model.nodes, previousLayout.positions)
  ) {
    return previousLayout
  }

  const laidOut = await elk.layout(toElkGraph(model))
  const positions = mapElkPositions(model.nodes, laidOut.children ?? [])

  return {
    structuralSignature: model.signature,
    positions,
  }
}
