import type { PluginListDTO } from '@shared/types/plugin'
import type { PluginCommandGraphDTO } from '@shared/types/plugin-command-graph'
import { describe, expect, it } from 'vitest'
import {
  buildCallGraphModel,
  filterCommandEdges,
  getCallGraphDensity,
  structuralSignature,
} from './call-graph-model'

function graph(edges: PluginCommandGraphDTO['edges']): PluginCommandGraphDTO {
  return {
    edges,
    cutoff: 1,
    generatedAt: 2,
    truncated: false,
  }
}

function plugin(
  id: string,
  name: string,
  status: PluginListDTO['status'] = 'active'
): PluginListDTO {
  return {
    id,
    name,
    version: '1.0.0',
    description: '',
    status,
    enabled: status !== 'disabled',
    permissions: [],
    optionalPermissions: [],
    errorCount: 0,
  }
}

const UNSORTED_EDGES: PluginCommandGraphDTO['edges'] = [
  {
    sourcePluginId: 'plugin.beta',
    targetPluginId: 'plugin.alpha',
    commandId: 'archive.write',
    calls: 2,
    lastCalledAt: 50,
  },
  {
    sourcePluginId: 'plugin.alpha',
    targetPluginId: 'plugin.beta',
    commandId: 'video.fetch',
    calls: 8,
    lastCalledAt: 40,
  },
  {
    sourcePluginId: 'plugin.alpha',
    targetPluginId: 'plugin.beta',
    commandId: 'audio.fetch',
    calls: 3,
    lastCalledAt: 60,
  },
]

describe('buildCallGraphModel', () => {
  it('joins metadata, keeps historical nodes, and computes node totals', () => {
    const model = buildCallGraphModel(graph(UNSORTED_EDGES), [
      plugin('plugin.alpha', 'Alpha tools', 'disabled'),
    ])

    expect(model.nodes).toEqual([
      {
        id: 'plugin.alpha',
        name: 'Alpha tools',
        installed: true,
        status: 'disabled',
        incomingCalls: 2,
        outgoingCalls: 11,
      },
      {
        id: 'plugin.beta',
        name: 'plugin.beta',
        installed: false,
        status: 'missing',
        incomingCalls: 11,
        outgoingCalls: 2,
      },
    ])
  })

  it('groups parallel commands and sorts pair breakdowns by call count', () => {
    const model = buildCallGraphModel(graph(UNSORTED_EDGES), [
      plugin('plugin.alpha', 'Alpha tools'),
      plugin('plugin.beta', 'Beta tools'),
    ])

    expect(model.pairEdges).toEqual([
      {
        source: 'plugin.alpha',
        target: 'plugin.beta',
        totalCalls: 11,
        commandCount: 2,
        lastCalledAt: 60,
        commands: [
          { commandId: 'video.fetch', calls: 8, lastCalledAt: 40 },
          { commandId: 'audio.fetch', calls: 3, lastCalledAt: 60 },
        ],
        strokeWidth: 1.5 + Math.log2(12),
      },
      {
        source: 'plugin.beta',
        target: 'plugin.alpha',
        totalCalls: 2,
        commandCount: 1,
        lastCalledAt: 50,
        commands: [{ commandId: 'archive.write', calls: 2, lastCalledAt: 50 }],
        strokeWidth: 1.5 + Math.log2(3),
      },
    ])
  })

  it('creates one stable table row per normalized command edge', () => {
    const input = graph(UNSORTED_EDGES)
    const before = structuredClone(input)
    const metadata = [
      plugin('plugin.beta', 'Beta tools'),
      plugin('plugin.alpha', 'Alpha tools'),
    ]
    const model = buildCallGraphModel(input, metadata)

    expect(model.tableRows).toEqual([
      {
        sourcePluginId: 'plugin.alpha',
        sourcePluginName: 'Alpha tools',
        targetPluginId: 'plugin.beta',
        targetPluginName: 'Beta tools',
        commandId: 'video.fetch',
        calls: 8,
        lastCalledAt: 40,
      },
      {
        sourcePluginId: 'plugin.alpha',
        sourcePluginName: 'Alpha tools',
        targetPluginId: 'plugin.beta',
        targetPluginName: 'Beta tools',
        commandId: 'audio.fetch',
        calls: 3,
        lastCalledAt: 60,
      },
      {
        sourcePluginId: 'plugin.beta',
        sourcePluginName: 'Beta tools',
        targetPluginId: 'plugin.alpha',
        targetPluginName: 'Alpha tools',
        commandId: 'archive.write',
        calls: 2,
        lastCalledAt: 50,
      },
    ])
    expect(input).toEqual(before)

    const reversed = buildCallGraphModel(
      graph([...UNSORTED_EDGES].reverse()),
      [...metadata].reverse()
    )
    expect(reversed).toEqual(model)
  })

  it('keeps its structural signature stable across count-only updates', () => {
    const first = buildCallGraphModel(graph(UNSORTED_EDGES), [])
    const updated = buildCallGraphModel(
      graph(
        UNSORTED_EDGES.map((edge) => ({
          ...edge,
          calls: edge.calls + 100,
          lastCalledAt: edge.lastCalledAt + 1_000,
        }))
      ),
      []
    )

    expect(updated.signature).toBe(first.signature)
  })

  it('uses collision-safe structural tuple serialization', () => {
    const nodeIds = ['a', 'a|b', 'b|c', 'c'].map((id) => ({ id }))
    const first = structuralSignature(nodeIds, [{ source: 'a|b', target: 'c' }])
    const second = structuralSignature(nodeIds, [
      { source: 'a', target: 'b|c' },
    ])

    expect(first).not.toBe(second)
  })

  it('bounds the logarithmic edge width', () => {
    const small = buildCallGraphModel(
      graph([
        {
          sourcePluginId: 'a',
          targetPluginId: 'b',
          commandId: 'small',
          calls: 1,
          lastCalledAt: 1,
        },
      ]),
      []
    )
    const large = buildCallGraphModel(
      graph([
        {
          sourcePluginId: 'a',
          targetPluginId: 'b',
          commandId: 'large',
          calls: 2 ** 20,
          lastCalledAt: 1,
        },
      ]),
      []
    )

    expect(small.pairEdges[0]?.strokeWidth).toBe(2.5)
    expect(large.pairEdges[0]?.strokeWidth).toBe(5.5)
  })
})

describe('filterCommandEdges', () => {
  const base = buildCallGraphModel(
    graph([
      {
        sourcePluginId: 'plugin.alpha',
        targetPluginId: 'plugin.beta',
        commandId: 'video.fetch',
        calls: 7,
        lastCalledAt: 70,
      },
      {
        sourcePluginId: 'plugin.alpha',
        targetPluginId: 'plugin.beta',
        commandId: 'audio.fetch',
        calls: 3,
        lastCalledAt: 30,
      },
      {
        sourcePluginId: 'plugin.gamma',
        targetPluginId: 'plugin.alpha',
        commandId: 'archive.write',
        calls: 4,
        lastCalledAt: 40,
      },
      {
        sourcePluginId: 'plugin.beta',
        targetPluginId: 'plugin.gamma',
        commandId: 'metadata.read',
        calls: 2,
        lastCalledAt: 20,
      },
    ]),
    [
      plugin('plugin.alpha', 'Alpha tools'),
      plugin('plugin.beta', 'Beta tools'),
      plugin('plugin.gamma', 'Gamma tools'),
    ]
  )

  it.each([
    ['localized plugin name', 'BETA TOOLS', 3],
    ['plugin id', 'PLUGIN.GAMMA', 2],
    ['command id', 'VIDEO.FETCH', 1],
  ])('matches %s case-insensitively', (_kind, search, edgeCount) => {
    expect(filterCommandEdges(base, { search }).commandEdges).toHaveLength(
      edgeCount
    )
  })

  it('filters commands before rebuilding a parallel pair', () => {
    const filtered = filterCommandEdges(base, { search: 'VIDEO' })

    expect(filtered.pairEdges).toHaveLength(1)
    expect(filtered.pairEdges[0]).toMatchObject({
      source: 'plugin.alpha',
      target: 'plugin.beta',
      totalCalls: 7,
      commandCount: 1,
      lastCalledAt: 70,
      commands: [{ commandId: 'video.fetch', calls: 7, lastCalledAt: 70 }],
    })
    expect(filtered.tableRows.map((row) => row.commandId)).toEqual([
      'video.fetch',
    ])
  })

  it('keeps every relationship for a blank query', () => {
    expect(filterCommandEdges(base, { search: '' }).commandEdges).toHaveLength(
      base.commandEdges.length
    )
  })

  it('matches every edge incident to a plugin name', () => {
    expect(
      filterCommandEdges(base, { search: 'Alpha tools' }).commandEdges.map(
        (edge) => edge.commandId
      )
    ).toEqual(['audio.fetch', 'video.fetch', 'archive.write'])
  })

  it('matches every edge incident to a plugin id', () => {
    expect(
      filterCommandEdges(base, { search: 'plugin.alpha' }).commandEdges
    ).toHaveLength(3)
  })

  it('matches an individual command id', () => {
    expect(
      filterCommandEdges(base, { search: 'metadata.read' }).commandEdges.map(
        (edge) => edge.commandId
      )
    ).toEqual(['metadata.read'])
  })

  it('distinguishes a filtered-empty result from global no activity', () => {
    expect(
      filterCommandEdges(base, { search: 'does-not-exist' }).emptyState
    ).toBe('filtered-empty')

    const empty = buildCallGraphModel(graph([]), [])
    expect(empty.emptyState).toBe('global-empty')
    expect(filterCommandEdges(empty, { search: 'anything' }).emptyState).toBe(
      'global-empty'
    )
  })
})

describe('getCallGraphDensity', () => {
  it.each([
    [100, 300, 'full'],
    [101, 300, 'reduced'],
    [100, 301, 'reduced'],
    [100, 500, 'reduced'],
    [100, 501, 'table-first'],
    [101, 501, 'table-first'],
  ] as const)(
    'classifies %i nodes and %i pair edges as %s',
    (nodeCount, pairEdgeCount, expected) => {
      expect(getCallGraphDensity(nodeCount, pairEdgeCount)).toBe(expected)
    }
  )
})
