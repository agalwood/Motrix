import type { ElkNode } from 'elkjs'
import { describe, expect, it, vi } from 'vitest'
import {
  type CallGraphNodeLayout,
  layoutCallGraphNodes,
} from './call-graph-layout'
import { buildCallGraphModel, type CallGraphModel } from './call-graph-model'

function model(calls = 3): CallGraphModel {
  return buildCallGraphModel(
    {
      edges: [
        {
          sourcePluginId: 'plugin.alpha',
          targetPluginId: 'plugin.beta',
          commandId: 'video.fetch',
          calls,
          lastCalledAt: 100 + calls,
        },
      ],
    },
    []
  )
}

function validLayout(input: ElkNode): ElkNode {
  return {
    ...input,
    children: input.children?.map((child, index) => ({
      ...child,
      x: 10 + index * 300,
      y: 20,
    })),
  }
}

describe('layoutCallGraphNodes', () => {
  it('sends deterministic layered RIGHT input without ports or sections', async () => {
    const layout = vi.fn(
      async (input: ElkNode): Promise<ElkNode> => ({
        ...input,
        children: input.children?.map((child, index) => ({
          ...child,
          x: 20 + index * 300,
          y: 30 + index * 100,
        })),
      })
    )
    const graphModel = model()

    await layoutCallGraphNodes(graphModel, null, { layout })

    expect(layout).toHaveBeenCalledOnce()
    const input = layout.mock.calls[0]?.[0]
    expect(input).toMatchObject({
      id: 'plugin-call-graph',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
      },
      children: [
        { id: 'plugin.alpha', width: 224, height: 88 },
        { id: 'plugin.beta', width: 224, height: 88 },
      ],
      edges: [
        {
          id: 'pair-0',
          sources: ['plugin.alpha'],
          targets: ['plugin.beta'],
        },
      ],
    })
    expect(input?.children?.every((node) => !('ports' in node))).toBe(true)
    expect(input?.edges?.every((edge) => !('sections' in edge))).toBe(true)
  })

  it('reserves a readable label corridor between adjacent layers', async () => {
    const layout = vi.fn(async (input: ElkNode) => validLayout(input))

    await layoutCallGraphNodes(model(), null, { layout })

    expect(layout.mock.calls[0]?.[0].layoutOptions).toMatchObject({
      'elk.layered.spacing.nodeNodeBetweenLayers': '180',
    })
  })

  it('maps ELK coordinates to React Flow positions', async () => {
    const layout = vi.fn(
      async (input: ElkNode): Promise<ElkNode> => ({
        ...input,
        children: input.children?.map((child) => ({
          ...child,
          x: child.id === 'plugin.alpha' ? 12 : 412,
          y: child.id === 'plugin.alpha' ? 34 : 134,
        })),
      })
    )

    const result = await layoutCallGraphNodes(model(), null, { layout })

    expect(result.positions).toEqual({
      'plugin.alpha': { x: 12, y: 34 },
      'plugin.beta': { x: 412, y: 134 },
    })
  })

  it('does not mutate the view model input', async () => {
    const graphModel = model()
    const before = structuredClone(graphModel)
    const layout = vi.fn(
      async (input: ElkNode): Promise<ElkNode> => ({
        ...input,
        children: input.children?.map((child) => ({
          ...child,
          x: 1,
          y: 2,
        })),
      })
    )

    await layoutCallGraphNodes(graphModel, null, { layout })

    expect(graphModel).toEqual(before)
  })

  it('propagates an ELK layout rejection', async () => {
    const failure = new Error('ELK failed')
    const layout = vi.fn().mockRejectedValue(failure)

    await expect(layoutCallGraphNodes(model(), null, { layout })).rejects.toBe(
      failure
    )
  })

  it('reuses prior positions when only counts changed', async () => {
    const firstModel = model(3)
    const updatedModel = model(99)
    const previous: CallGraphNodeLayout = {
      structuralSignature: firstModel.signature,
      positions: {
        'plugin.alpha': { x: 10, y: 20 },
        'plugin.beta': { x: 310, y: 20 },
      },
    }
    const layout = vi.fn()

    const result = await layoutCallGraphNodes(updatedModel, previous, {
      layout,
    })

    expect(updatedModel.signature).toBe(firstModel.signature)
    expect(result).toBe(previous)
    expect(layout).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a missing node',
      {
        'plugin.alpha': { x: 10, y: 20 },
      },
    ],
    [
      'a NaN coordinate',
      {
        'plugin.alpha': { x: Number.NaN, y: 20 },
        'plugin.beta': { x: 310, y: 20 },
      },
    ],
    [
      'an infinite coordinate',
      {
        'plugin.alpha': { x: 10, y: 20 },
        'plugin.beta': { x: 310, y: Number.POSITIVE_INFINITY },
      },
    ],
    [
      'an unknown extra node',
      {
        'plugin.alpha': { x: 10, y: 20 },
        'plugin.beta': { x: 310, y: 20 },
        'plugin.unknown': { x: 610, y: 20 },
      },
    ],
  ])('recomputes a signature match with %s', async (_case, positions) => {
    const graphModel = model()
    const previous: CallGraphNodeLayout = {
      structuralSignature: graphModel.signature,
      positions,
    }
    const layout = vi.fn(async (input: ElkNode) => validLayout(input))

    const result = await layoutCallGraphNodes(graphModel, previous, { layout })

    expect(layout).toHaveBeenCalledOnce()
    expect(result).not.toBe(previous)
    expect(result.positions).toEqual({
      'plugin.alpha': { x: 10, y: 20 },
      'plugin.beta': { x: 310, y: 20 },
    })
  })

  it.each([
    [
      'a missing child',
      [{ id: 'plugin.alpha', x: 10, y: 20 }],
      /Invalid ELK layout: missing node "plugin.beta"/,
    ],
    [
      'a duplicate child',
      [
        { id: 'plugin.alpha', x: 10, y: 20 },
        { id: 'plugin.alpha', x: 30, y: 40 },
        { id: 'plugin.beta', x: 310, y: 20 },
      ],
      /Invalid ELK layout: duplicate node "plugin.alpha"/,
    ],
    [
      'an unknown child',
      [
        { id: 'plugin.alpha', x: 10, y: 20 },
        { id: 'plugin.beta', x: 310, y: 20 },
        { id: 'plugin.unknown', x: 610, y: 20 },
      ],
      /Invalid ELK layout: unknown node "plugin.unknown"/,
    ],
    [
      'a missing x coordinate',
      [
        { id: 'plugin.alpha', y: 20 },
        { id: 'plugin.beta', x: 310, y: 20 },
      ],
      /Invalid ELK layout: node "plugin.alpha" must have finite x and y/,
    ],
    [
      'a missing y coordinate',
      [
        { id: 'plugin.alpha', x: 10 },
        { id: 'plugin.beta', x: 310, y: 20 },
      ],
      /Invalid ELK layout: node "plugin.alpha" must have finite x and y/,
    ],
    [
      'a NaN coordinate',
      [
        { id: 'plugin.alpha', x: Number.NaN, y: 20 },
        { id: 'plugin.beta', x: 310, y: 20 },
      ],
      /Invalid ELK layout: node "plugin.alpha" must have finite x and y/,
    ],
    [
      'an infinite coordinate',
      [
        { id: 'plugin.alpha', x: 10, y: Number.NEGATIVE_INFINITY },
        { id: 'plugin.beta', x: 310, y: 20 },
      ],
      /Invalid ELK layout: node "plugin.alpha" must have finite x and y/,
    ],
  ] as const)(
    'rejects ELK output with %s',
    async (_case, children, expectedError) => {
      const layout = vi.fn(
        async (input: ElkNode): Promise<ElkNode> => ({
          ...input,
          children: children.map((child) => ({ ...child })),
        })
      )

      await expect(
        layoutCallGraphNodes(model(), null, { layout })
      ).rejects.toThrow(expectedError)
    }
  )

  it('accepts empty ELK children for an empty model', async () => {
    const emptyModel = buildCallGraphModel({ edges: [] }, [])
    const layout = vi.fn(
      async (input: ElkNode): Promise<ElkNode> => ({
        ...input,
        children: [],
      })
    )

    const result = await layoutCallGraphNodes(emptyModel, null, { layout })

    expect(result.positions).toEqual({})
  })
})
