import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildCallGraphModel,
  type CallGraphModel,
} from '../../lib/call-graph-model'
import type { PluginCallGraphSelection } from './plugin-call-graph'
import {
  PluginCallGraphInspector,
  type PluginCallGraphInspectorStrings,
} from './plugin-call-graph-inspector'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return { ...actual, useNavigate: () => navigate }
})

const formatLastCall = vi.fn(
  (timestamp: number) => `localized timestamp ${timestamp}`
)

const strings: PluginCallGraphInspectorStrings = {
  inspectorLabel: 'Call graph selection details',
  scopeTitle: 'Successful calls',
  neutralScope: 'Select a plugin or connection from the last 24 hours.',
  pluginId: 'Plugin ID',
  status: 'Status',
  statuses: {
    active: 'Running',
    inactive: 'Ready but idle',
    disabled: 'Disabled',
    error: 'Needs attention',
    missing: 'Not installed',
  },
  incomingCalls: 'Incoming calls',
  outgoingCalls: 'Outgoing calls',
  connections: 'Connected plugins',
  noConnections: 'No connected plugins',
  openPlugin: 'Open plugin',
  edgeTitle: 'Connection details',
  caller: 'Caller',
  callee: 'Callee',
  totalCalls: 'Total calls',
  lastCall: 'Last call',
  commands: 'Commands',
  callsLabel: (count) => `${count} successful calls`,
  formatLastCall,
}

const graph = buildCallGraphModel(
  {
    edges: [
      {
        sourcePluginId: 'plugin.alpha',
        targetPluginId: 'plugin.beta',
        commandId: 'plugin.beta.run',
        calls: 2,
        lastCalledAt: 100,
      },
      {
        sourcePluginId: 'plugin.gamma',
        targetPluginId: 'plugin.alpha',
        commandId: 'plugin.alpha.receive',
        calls: 5,
        lastCalledAt: 200,
      },
      {
        sourcePluginId: 'plugin.alpha',
        targetPluginId: 'plugin.gamma',
        commandId: 'plugin.gamma.send',
        calls: 3,
        lastCalledAt: 300,
      },
      {
        sourcePluginId: 'plugin.beta',
        targetPluginId: 'plugin.gamma',
        commandId: 'command.low',
        calls: 3,
        lastCalledAt: 400,
      },
      {
        sourcePluginId: 'plugin.beta',
        targetPluginId: 'plugin.gamma',
        commandId: 'command.beta',
        calls: 8,
        lastCalledAt: 500,
      },
      {
        sourcePluginId: 'plugin.beta',
        targetPluginId: 'plugin.gamma',
        commandId: 'command.alpha',
        calls: 8,
        lastCalledAt: 450,
      },
    ],
  },
  [
    { id: 'plugin.alpha', name: 'Alpha Tools', status: 'active' },
    { id: 'plugin.beta', name: 'Beta Tools', status: 'disabled' },
    { id: 'plugin.gamma', name: 'Gamma Tools', status: 'inactive' },
  ]
)

function renderInspectorWith(
  model: CallGraphModel,
  selection: PluginCallGraphSelection
) {
  return render(
    <PluginCallGraphInspector
      model={model}
      selection={selection}
      strings={strings}
    />
  )
}

function renderInspector(selection: PluginCallGraphSelection) {
  return renderInspectorWith(graph, selection)
}

describe('PluginCallGraphInspector', () => {
  beforeEach(() => {
    navigate.mockReset()
    formatLastCall.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('explains the successful-call 24-hour scope without a selection', () => {
    renderInspector(null)

    expect(
      screen.getByRole('complementary', { name: strings.inspectorLabel })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: strings.scopeTitle })
    ).toBeInTheDocument()
    expect(screen.getByText(strings.neutralScope)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: strings.openPlugin })
    ).not.toBeInTheDocument()
  })

  it('shows fresh node totals and connections ordered by call count', () => {
    const node = graph.nodes.find(
      (candidate) => candidate.id === 'plugin.alpha'
    )
    expect(node).toBeDefined()
    renderInspector({ type: 'node', node: node! })

    expect(
      screen.getByRole('heading', { name: 'Alpha Tools' })
    ).toBeInTheDocument()
    expect(screen.getByText('plugin.alpha')).toBeInTheDocument()
    expect(screen.getByText(strings.statuses.active)).toBeInTheDocument()
    expect(
      screen.getByText(strings.incomingCalls).nextElementSibling
    ).toHaveTextContent('5')
    expect(
      screen.getByText(strings.outgoingCalls).nextElementSibling
    ).toHaveTextContent('5')

    const connections = screen.getByRole('list', {
      name: strings.connections,
    })
    const items = within(connections).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Gamma Tools')
    expect(items[0]).toHaveTextContent(strings.callsLabel(8))
    expect(items[1]).toHaveTextContent('Beta Tools')
    expect(items[1]).toHaveTextContent(strings.callsLabel(2))
  })

  it('resolves every node field and action from the current model', async () => {
    const user = userEvent.setup()
    const oldGraph = buildCallGraphModel(
      {
        edges: [
          {
            sourcePluginId: 'plugin.alpha',
            targetPluginId: 'plugin.beta',
            commandId: 'plugin.beta.run',
            calls: 1,
            lastCalledAt: 100,
          },
        ],
      },
      [{ id: 'plugin.beta', name: 'Old Beta', status: 'inactive' }]
    )
    const currentGraph = buildCallGraphModel(
      {
        edges: [
          {
            sourcePluginId: 'plugin.alpha',
            targetPluginId: 'plugin.beta',
            commandId: 'plugin.beta.run',
            calls: 9,
            lastCalledAt: 400,
          },
          {
            sourcePluginId: 'plugin.gamma',
            targetPluginId: 'plugin.alpha',
            commandId: 'plugin.alpha.receive',
            calls: 4,
            lastCalledAt: 500,
          },
        ],
      },
      [
        { id: 'plugin.alpha', name: 'Updated Alpha', status: 'error' },
        { id: 'plugin.beta', name: 'Current Beta', status: 'inactive' },
        { id: 'plugin.gamma', name: 'Current Gamma', status: 'active' },
      ]
    )
    const oldNode = oldGraph.nodes.find(
      (candidate) => candidate.id === 'plugin.alpha'
    )
    expect(oldNode).toMatchObject({
      name: 'plugin.alpha',
      installed: false,
      status: 'missing',
      outgoingCalls: 1,
    })

    renderInspectorWith(currentGraph, { type: 'node', node: oldNode! })

    expect(
      screen.getByRole('heading', { name: 'Updated Alpha' })
    ).toBeInTheDocument()
    expect(screen.getByText(strings.statuses.error)).toBeInTheDocument()
    expect(screen.queryByText(strings.statuses.missing)).not.toBeInTheDocument()
    expect(
      screen.getByText(strings.incomingCalls).nextElementSibling
    ).toHaveTextContent('4')
    expect(
      screen.getByText(strings.outgoingCalls).nextElementSibling
    ).toHaveTextContent('9')
    const connections = screen.getByRole('list', {
      name: strings.connections,
    })
    const connectionItems = within(connections).getAllByRole('listitem')
    expect(connectionItems[0]).toHaveTextContent('Current Beta')
    expect(connectionItems[0]).toHaveTextContent(strings.callsLabel(9))
    expect(connectionItems[1]).toHaveTextContent('Current Gamma')
    expect(connectionItems[1]).toHaveTextContent(strings.callsLabel(4))

    await user.click(screen.getByRole('button', { name: strings.openPlugin }))
    expect(navigate).toHaveBeenCalledWith('/plugins/plugin.alpha')
  })

  it('falls back to neutral scope when the selected node left the model', () => {
    const oldNode = graph.nodes.find(
      (candidate) => candidate.id === 'plugin.alpha'
    )
    const currentGraph = buildCallGraphModel(
      {
        edges: [
          {
            sourcePluginId: 'plugin.beta',
            targetPluginId: 'plugin.gamma',
            commandId: 'plugin.gamma.run',
            calls: 2,
            lastCalledAt: 200,
          },
        ],
      },
      [
        { id: 'plugin.beta', name: 'Beta Tools', status: 'active' },
        { id: 'plugin.gamma', name: 'Gamma Tools', status: 'inactive' },
      ]
    )

    renderInspectorWith(currentGraph, { type: 'node', node: oldNode! })

    expect(
      screen.getByRole('heading', { name: strings.scopeTitle })
    ).toBeInTheDocument()
    expect(screen.getByText(strings.neutralScope)).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Alpha Tools' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: strings.openPlugin })
    ).not.toBeInTheDocument()
  })

  it('opens installed plugins with an encoded detail route', async () => {
    const user = userEvent.setup()
    const specialGraph = buildCallGraphModel(
      {
        edges: [
          {
            sourcePluginId: 'plugin/a b?#',
            targetPluginId: 'plugin.target',
            commandId: 'plugin.target.run',
            calls: 1,
            lastCalledAt: 100,
          },
        ],
      },
      [
        { id: 'plugin/a b?#', name: 'Special Plugin', status: 'active' },
        { id: 'plugin.target', name: 'Target', status: 'inactive' },
      ]
    )
    const node = specialGraph.nodes.find(
      (candidate) => candidate.id === 'plugin/a b?#'
    )
    expect(node).toBeDefined()
    render(
      <PluginCallGraphInspector
        model={specialGraph}
        selection={{ type: 'node', node: node! }}
        strings={strings}
      />
    )

    await user.click(screen.getByRole('button', { name: strings.openPlugin }))
    expect(navigate).toHaveBeenCalledWith('/plugins/plugin%2Fa%20b%3F%23')
  })

  it('does not offer navigation for a historical missing node', () => {
    const missingGraph = buildCallGraphModel(
      {
        edges: [
          {
            sourcePluginId: 'plugin.installed',
            targetPluginId: 'plugin.removed',
            commandId: 'plugin.removed.run',
            calls: 1,
            lastCalledAt: 100,
          },
        ],
      },
      [{ id: 'plugin.installed', name: 'Installed', status: 'active' }]
    )
    const node = missingGraph.nodes.find(
      (candidate) => candidate.id === 'plugin.removed'
    )
    expect(node).toBeDefined()
    render(
      <PluginCallGraphInspector
        model={missingGraph}
        selection={{ type: 'node', node: node! }}
        strings={strings}
      />
    )

    expect(screen.getByText(strings.statuses.missing)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: strings.openPlugin })
    ).not.toBeInTheDocument()
  })

  it('shows the Task 6 edge breakdown order and localized last-call time', () => {
    const edge = graph.pairEdges.find(
      (candidate) =>
        candidate.source === 'plugin.beta' &&
        candidate.target === 'plugin.gamma'
    )
    expect(edge).toBeDefined()
    renderInspector({ type: 'edge', edge: edge! })

    expect(
      screen.getByText(strings.caller).nextElementSibling
    ).toHaveTextContent('plugin.beta')
    expect(
      screen.getByText(strings.callee).nextElementSibling
    ).toHaveTextContent('plugin.gamma')
    expect(
      screen.getByText(strings.totalCalls).nextElementSibling
    ).toHaveTextContent('19')
    expect(
      screen.getByText(strings.lastCall).nextElementSibling
    ).toHaveTextContent('localized timestamp 500')
    expect(formatLastCall).toHaveBeenCalledWith(500)

    const commands = screen.getByRole('list', { name: strings.commands })
    const items = within(commands).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/command\.alpha.*8 successful calls/),
      expect.stringMatching(/command\.beta.*8 successful calls/),
      expect.stringMatching(/command\.low.*3 successful calls/),
    ])
  })

  it('resolves every edge detail from the current model', () => {
    const oldGraph = buildCallGraphModel(
      {
        edges: [
          {
            sourcePluginId: 'plugin.alpha',
            targetPluginId: 'plugin.beta',
            commandId: 'command.old',
            calls: 1,
            lastCalledAt: 100,
          },
        ],
      },
      []
    )
    const currentGraph = buildCallGraphModel(
      {
        edges: [
          {
            sourcePluginId: 'plugin.alpha',
            targetPluginId: 'plugin.beta',
            commandId: 'command.new',
            calls: 8,
            lastCalledAt: 500,
          },
          {
            sourcePluginId: 'plugin.alpha',
            targetPluginId: 'plugin.beta',
            commandId: 'command.old',
            calls: 3,
            lastCalledAt: 400,
          },
        ],
      },
      []
    )
    const oldEdge = oldGraph.pairEdges[0]

    renderInspectorWith(currentGraph, { type: 'edge', edge: oldEdge! })

    expect(
      screen.getByText(strings.totalCalls).nextElementSibling
    ).toHaveTextContent('11')
    expect(
      screen.getByText(strings.lastCall).nextElementSibling
    ).toHaveTextContent('localized timestamp 500')
    const items = within(
      screen.getByRole('list', { name: strings.commands })
    ).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/command\.new.*8 successful calls/),
      expect.stringMatching(/command\.old.*3 successful calls/),
    ])
  })

  it('falls back to neutral scope when the selected edge left the model', () => {
    const oldEdge = graph.pairEdges.find(
      (candidate) =>
        candidate.source === 'plugin.beta' &&
        candidate.target === 'plugin.gamma'
    )
    const currentGraph = buildCallGraphModel(
      {
        edges: [
          {
            sourcePluginId: 'plugin.alpha',
            targetPluginId: 'plugin.beta',
            commandId: 'plugin.beta.run',
            calls: 2,
            lastCalledAt: 200,
          },
        ],
      },
      []
    )

    renderInspectorWith(currentGraph, { type: 'edge', edge: oldEdge! })

    expect(
      screen.getByRole('heading', { name: strings.scopeTitle })
    ).toBeInTheDocument()
    expect(screen.getByText(strings.neutralScope)).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: strings.edgeTitle })
    ).not.toBeInTheDocument()
  })

  it('resolves semantically equivalent cloned selection identities', () => {
    const node = graph.nodes.find(
      (candidate) => candidate.id === 'plugin.alpha'
    )
    const edge = graph.pairEdges.find(
      (candidate) =>
        candidate.source === 'plugin.beta' &&
        candidate.target === 'plugin.gamma'
    )
    const { rerender } = renderInspectorWith(graph, {
      type: 'node',
      node: { ...node! },
    })
    expect(
      screen.getByRole('heading', { name: 'Alpha Tools' })
    ).toBeInTheDocument()

    rerender(
      <PluginCallGraphInspector
        model={graph}
        selection={{
          type: 'edge',
          edge: {
            ...edge!,
            commands: edge!.commands.map((command) => ({ ...command })),
          },
        }}
        strings={strings}
      />
    )
    expect(
      screen.getByRole('heading', { name: strings.edgeTitle })
    ).toBeInTheDocument()
    expect(
      screen.getByText(strings.totalCalls).nextElementSibling
    ).toHaveTextContent('19')
  })

  it('owns one bounded inspector scroller without a hard 360px minimum', () => {
    const { container } = renderInspector(null)
    const inspector = screen.getByRole('complementary', {
      name: strings.inspectorLabel,
    })

    expect(inspector).toHaveClass('min-h-0', 'overflow-auto')
    expect(container.querySelectorAll('.overflow-auto')).toHaveLength(1)
    expect(inspector.className).not.toContain('360')
  })
})
