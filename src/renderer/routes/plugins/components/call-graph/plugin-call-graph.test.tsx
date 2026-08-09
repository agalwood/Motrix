import '@testing-library/jest-dom/vitest'
import type { PluginCommandGraphEdge } from '@shared/types/plugin-command-graph'
import { act, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AriaLabelConfig, ReactFlowProps } from '@xyflow/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallGraphNodeLayout } from '../../lib/call-graph-layout'
import type { CallGraphModel } from '../../lib/call-graph-model'
import {
  buildCallGraphModel,
  getCallGraphDensity,
} from '../../lib/call-graph-model'
import {
  installGraphTestEnvironment,
  renderInReactFlowProvider,
} from './graph-test-utils'
import {
  PluginCallGraph,
  type PluginCallGraphProps,
  type PluginCallGraphSelection,
  type PluginCallGraphStrings,
} from './plugin-call-graph'

const flowHarness = vi.hoisted(() => ({
  props: null as ReactFlowProps | null,
  fitView: vi.fn(),
}))

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  const React = await import('react')

  const MockReactFlow = (props: ReactFlowProps) => {
    flowHarness.props = props
    React.useEffect(() => {
      props.onInit?.({ fitView: flowHarness.fitView } as never)
    }, [props.onInit])

    return (
      <div
        role="application"
        data-testid="react-flow"
        aria-label={props['aria-label']}
        aria-describedby={props['aria-describedby']}
      >
        {props.nodes?.map((node) => (
          <button
            key={node.id}
            type="button"
            data-testid={`flow-node-${node.id}`}
            data-position={`${node.position.x},${node.position.y}`}
            data-selected={String(Boolean(node.selected))}
            data-connected={String(Boolean(node.data.connected))}
            data-dimmed={String(Boolean(node.data.dimmed))}
            aria-pressed={Boolean(node.domAttributes?.['aria-pressed'])}
            onClick={(event) => {
              event.stopPropagation()
              props.onNodesChange?.([
                { id: node.id, type: 'select', selected: true },
              ])
              props.onNodeClick?.(event, node)
            }}
            onMouseEnter={(event) => props.onNodeMouseEnter?.(event, node)}
            onMouseLeave={(event) => props.onNodeMouseLeave?.(event, node)}
          >
            {String((node.data.model as { name?: string } | undefined)?.name)}
          </button>
        ))}
        {props.edges?.map((edge) => (
          <button
            key={edge.id}
            type="button"
            data-testid={`flow-edge-${edge.id}`}
            data-selected={String(Boolean(edge.selected))}
            data-highlighted={String(Boolean(edge.data?.highlighted))}
            data-dimmed={String(Boolean(edge.data?.dimmed))}
            onClick={(event) => {
              event.stopPropagation()
              props.onEdgesChange?.([
                { id: edge.id, type: 'select', selected: true },
              ])
              props.onEdgeClick?.(event, edge)
            }}
            onMouseEnter={(event) => props.onEdgeMouseEnter?.(event, edge)}
            onMouseLeave={(event) => props.onEdgeMouseLeave?.(event, edge)}
          >
            {edge.source}-to-{edge.target}
          </button>
        ))}
        {props.children}
      </div>
    )
  }

  return {
    ...actual,
    default: MockReactFlow,
    ReactFlow: MockReactFlow,
    Background: () => <div data-testid="flow-background" />,
    Controls: (props: { 'aria-label'?: string; showInteractive?: boolean }) => (
      <fieldset
        data-testid="flow-controls"
        aria-label={props['aria-label']}
        data-show-interactive={String(props.showInteractive)}
      />
    ),
    Panel: ({
      children,
      className,
    }: {
      children: ReactNode
      className?: string
    }) => (
      <div data-testid="react-flow-panel" className={className}>
        {children}
      </div>
    ),
    MiniMap: (props: { ariaLabel?: string | null; className?: string }) => (
      <div
        role="img"
        data-testid="flow-minimap"
        aria-label={props.ariaLabel ?? undefined}
        className={props.className}
      />
    ),
  }
})

const ariaLabelConfig: AriaLabelConfig = {
  'node.a11yDescription.default': 'Choose a plugin node to inspect it.',
  'node.a11yDescription.keyboardDisabled':
    'Keyboard movement is unavailable for this plugin node.',
  'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }) =>
    `Plugin node moved ${direction} to ${x}, ${y}.`,
  'edge.a11yDescription.default': 'Choose a call edge to inspect it.',
  'controls.ariaLabel': 'Plugin graph view controls',
  'controls.zoomIn.ariaLabel': 'Increase graph scale',
  'controls.zoomOut.ariaLabel': 'Decrease graph scale',
  'controls.fitView.ariaLabel': 'Fit the plugin graph in view',
  'controls.interactive.ariaLabel': 'Toggle graph interaction mode',
  'minimap.ariaLabel': 'Plugin graph overview',
  'handle.ariaLabel': 'Read-only call endpoint',
}

const strings: PluginCallGraphStrings = {
  graphAriaLabel: 'Plugin command relationships',
  graphDescription: '3 plugins and 2 relationships from the last 24 hours.',
  layoutError: 'The relationship map could not be arranged.',
  retryLayout: 'Arrange map again',
  legend: {
    label: 'Call volume legend',
    fewerCalls: 'Fewer calls',
    moreCalls: 'More calls',
  },
  node: {
    statuses: {
      active: 'Running',
      inactive: 'Ready but idle',
      disabled: 'Turned off',
      error: 'Needs attention',
      missing: 'Not on this device',
    },
    incoming: 'Received calls',
    outgoing: 'Sent calls',
  },
  ariaLabelConfig,
  nodeAriaLabel: (node) => `${node.name}, plugin node ${node.id}`,
  edgeAriaLabel: (edge) =>
    `${edge.source} calls ${edge.target} ${edge.totalCalls} times`,
  callsLabel: (count) => `${count} successful calls`,
  commandsLabel: (count) => `${count} command kinds`,
}

const plugins = [
  {
    id: 'plugin.alpha',
    name: 'Alpha Tools',
    status: 'active' as const,
  },
  {
    id: 'plugin.beta',
    name: 'Beta Tools',
    status: 'inactive' as const,
  },
  {
    id: 'plugin.gamma',
    name: 'Gamma Tools',
    status: 'disabled' as const,
  },
]

function graphModel(edges: PluginCommandGraphEdge[]): CallGraphModel {
  return buildCallGraphModel({ edges }, plugins)
}

function edge(
  sourcePluginId: string,
  targetPluginId: string,
  calls = 1,
  commandId = `${targetPluginId}.run`,
  lastCalledAt = 100
): PluginCommandGraphEdge {
  return {
    sourcePluginId,
    targetPluginId,
    commandId,
    calls,
    lastCalledAt,
  }
}

const modelA = graphModel([
  edge('plugin.alpha', 'plugin.beta', 2),
  edge('plugin.beta', 'plugin.gamma', 3),
])
const modelACountUpdate = graphModel([
  edge('plugin.alpha', 'plugin.beta', 9),
  edge('plugin.beta', 'plugin.gamma', 3),
])
const modelANodePayloadUpdate = buildCallGraphModel(
  {
    edges: [
      edge('plugin.alpha', 'plugin.beta', 9),
      edge('plugin.beta', 'plugin.gamma', 3),
    ],
  },
  plugins.map((plugin) =>
    plugin.id === 'plugin.alpha'
      ? { ...plugin, status: 'error' as const }
      : plugin
  )
)
const modelAEdgePayloadUpdate = graphModel([
  edge('plugin.alpha', 'plugin.beta', 7, 'plugin.beta.run', 220),
  edge('plugin.alpha', 'plugin.beta', 3, 'plugin.beta.inspect', 210),
  edge('plugin.beta', 'plugin.gamma', 3),
])
const modelB = graphModel([edge('plugin.alpha', 'plugin.gamma', 4)])
const modelWithoutAlpha = graphModel([edge('plugin.beta', 'plugin.gamma', 5)])

function positions(
  model: Pick<CallGraphModel, 'nodes' | 'signature'>,
  start = 10
): CallGraphNodeLayout {
  return {
    structuralSignature: model.signature,
    positions: Object.fromEntries(
      model.nodes.map((node, index) => [
        node.id,
        { x: start + index * 250, y: 20 + index * 100 },
      ])
    ),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function graphProps(
  model: CallGraphModel,
  layoutNodes: NonNullable<PluginCallGraphProps['layoutNodes']>
): PluginCallGraphProps {
  return {
    model,
    density: getCallGraphDensity(model.nodes.length, model.pairEdges.length),
    strings,
    layoutNodes,
  }
}

describe('PluginCallGraph', () => {
  let restoreEnvironment: () => void

  beforeEach(() => {
    restoreEnvironment = installGraphTestEnvironment()
    flowHarness.props = null
    flowHarness.fitView.mockReset()
  })

  afterEach(() => {
    restoreEnvironment()
  })

  it('configures React Flow as a localized read-only selectable viewer', async () => {
    const layoutNodes = vi.fn().mockResolvedValue(positions(modelA))
    const { getByTestId, getByText } = renderInReactFlowProvider(
      <PluginCallGraph {...graphProps(modelA, layoutNodes)} />
    )

    await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(3))
    expect(flowHarness.props).toMatchObject({
      nodesConnectable: false,
      edgesReconnectable: false,
      deleteKeyCode: null,
      elementsSelectable: true,
      nodesFocusable: true,
      edgesFocusable: true,
      nodesDraggable: true,
      fitView: true,
      onlyRenderVisibleElements: true,
      ariaLabelConfig,
    })
    expect(flowHarness.props?.onNodesChange).toEqual(expect.any(Function))
    expect(flowHarness.props?.nodes?.every((node) => !node.connectable)).toBe(
      true
    )
    expect(
      flowHarness.props?.edges?.every(
        (edge) =>
          edge.reconnectable === false &&
          edge.deletable === false &&
          edge.animated === false &&
          edge.ariaRole === 'button' &&
          edge.domAttributes?.['aria-pressed'] === false
      )
    ).toBe(true)
    expect(
      flowHarness.props?.edges
        ?.filter((edge) => edge.data?.compactAtLowZoom)
        .map((edge) => [edge.source, edge.target])
    ).toEqual([['plugin.beta', 'plugin.gamma']])
    expect(flowHarness.props?.edges?.[0]?.markerEnd).toEqual({
      type: 'arrowclosed',
    })
    expect(getByTestId('react-flow')).toHaveAccessibleName(
      'Plugin command relationships'
    )
    expect(
      getByText('3 plugins and 2 relationships from the last 24 hours.')
    ).toHaveClass('sr-only')
    expect(getByTestId('flow-background')).toBeInTheDocument()
    expect(getByTestId('flow-controls')).toHaveAccessibleName(
      'Plugin graph view controls'
    )
    expect(getByTestId('flow-controls')).toHaveAttribute(
      'data-show-interactive',
      'false'
    )
    expect(getByTestId('flow-minimap')).toHaveAccessibleName(
      'Plugin graph overview'
    )

    const allCopy = Object.values(ariaLabelConfig)
      .map((value) =>
        typeof value === 'function'
          ? value({ direction: 'right', x: 1, y: 2 })
          : value
      )
      .join(' ')
    expect(allCopy).not.toMatch(/delete/i)
  })

  it('chooses the same binary-ordered compact anchor for reversed ties', async () => {
    const tiedEdges = [
      edge('plugin.z', 'plugin.target', 5),
      edge('plugin.ä', 'plugin.target', 5),
    ]
    const first = graphModel(tiedEdges)
    const reversed = graphModel([...tiedEdges].reverse())
    const layoutNodes: NonNullable<PluginCallGraphProps['layoutNodes']> = vi.fn(
      (model) => Promise.resolve(positions(model))
    )
    const { rerender } = renderInReactFlowProvider(
      <PluginCallGraph {...graphProps(first, layoutNodes)} />
    )

    await waitFor(() => expect(flowHarness.props?.edges).toHaveLength(2))
    expect(
      flowHarness.props?.edges
        ?.filter((candidate) => candidate.data?.compactAtLowZoom)
        .map((candidate) => [candidate.source, candidate.target])
    ).toEqual([['plugin.z', 'plugin.target']])

    rerender(<PluginCallGraph {...graphProps(reversed, layoutNodes)} />)
    await waitFor(() =>
      expect(
        flowHarness.props?.edges
          ?.filter((candidate) => candidate.data?.compactAtLowZoom)
          .map((candidate) => [candidate.source, candidate.target])
      ).toEqual([['plugin.z', 'plugin.target']])
    )
  })

  it('shows the minimap only at full density', async () => {
    const layoutNodes = vi.fn().mockResolvedValue(positions(modelA))
    const { queryByTestId, rerender } = renderInReactFlowProvider(
      <PluginCallGraph {...graphProps(modelA, layoutNodes)} />
    )
    await waitFor(() =>
      expect(queryByTestId('flow-minimap')).toBeInTheDocument()
    )
    expect(queryByTestId('flow-minimap')).toHaveClass(
      'hidden',
      '@[48rem]/call-graph:block'
    )

    rerender(
      <PluginCallGraph {...graphProps(modelA, layoutNodes)} density="reduced" />
    )
    expect(queryByTestId('flow-minimap')).not.toBeInTheDocument()
  })

  it('hides the legend until the current non-empty layout succeeds', async () => {
    const first = deferred<CallGraphNodeLayout>()
    const layoutNodes = vi.fn().mockReturnValue(first.promise)
    const { findByRole, getByTestId, queryByRole } = renderInReactFlowProvider(
      <PluginCallGraph {...graphProps(modelA, layoutNodes)} />
    )
    await waitFor(() => expect(layoutNodes).toHaveBeenCalledOnce())
    expect(queryByRole('group', { name: 'Call volume legend' })).toBeNull()

    await act(async () => first.resolve(positions(modelA)))
    expect(
      await findByRole('group', { name: 'Call volume legend' })
    ).toBeVisible()
    const panel = getByTestId('react-flow-panel')
    expect(panel).toHaveClass('pointer-events-none')
    expect(panel).not.toHaveClass('m-2')
  })

  it('selects and hovers connected elements while dimming unrelated ones', async () => {
    const user = userEvent.setup()
    const layoutNodes = vi.fn().mockResolvedValue(positions(modelA))
    const onNodeSelect = vi.fn()
    const onEdgeSelect = vi.fn()
    const onSelectionChange = vi.fn()
    const { getByTestId } = renderInReactFlowProvider(
      <PluginCallGraph
        {...graphProps(modelA, layoutNodes)}
        onNodeSelect={onNodeSelect}
        onEdgeSelect={onEdgeSelect}
        onSelectionChange={onSelectionChange}
      />
    )
    await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(3))

    await user.click(getByTestId('flow-node-plugin.alpha'))
    expect(onNodeSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'plugin.alpha' })
    )
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      type: 'node',
      node: expect.objectContaining({ id: 'plugin.alpha' }),
    })
    expect(getByTestId('flow-node-plugin.beta')).toHaveAttribute(
      'data-connected',
      'true'
    )
    expect(getByTestId('flow-node-plugin.gamma')).toHaveAttribute(
      'data-dimmed',
      'true'
    )
    expect(
      getByTestId('flow-edge-["plugin.alpha","plugin.beta"]')
    ).toHaveAttribute('data-highlighted', 'true')
    expect(
      getByTestId('flow-edge-["plugin.beta","plugin.gamma"]')
    ).toHaveAttribute('data-dimmed', 'true')

    fireEvent.mouseEnter(
      getByTestId('flow-edge-["plugin.beta","plugin.gamma"]')
    )
    expect(getByTestId('flow-node-plugin.alpha')).toHaveAttribute(
      'data-dimmed',
      'true'
    )
    fireEvent.mouseLeave(
      getByTestId('flow-edge-["plugin.beta","plugin.gamma"]')
    )
    await user.click(getByTestId('flow-edge-["plugin.beta","plugin.gamma"]'))
    expect(onEdgeSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'plugin.beta',
        target: 'plugin.gamma',
      })
    )
    expect(onEdgeSelect).toHaveBeenCalledOnce()
  })

  it('applies controlled edge select changes once and clears the selection', async () => {
    const layoutNodes = vi.fn().mockResolvedValue(positions(modelA))
    const onEdgeSelect = vi.fn()
    const onSelectionChange = vi.fn()
    renderInReactFlowProvider(
      <PluginCallGraph
        {...graphProps(modelA, layoutNodes)}
        onEdgeSelect={onEdgeSelect}
        onSelectionChange={onSelectionChange}
      />
    )
    await waitFor(() => expect(flowHarness.props?.edges).toHaveLength(2))
    const edgeId = JSON.stringify(['plugin.alpha', 'plugin.beta'])

    act(() => {
      flowHarness.props?.onEdgesChange?.([
        { id: edgeId, type: 'select', selected: true },
      ])
    })

    await waitFor(() =>
      expect(
        flowHarness.props?.edges?.find((edge) => edge.id === edgeId)?.selected
      ).toBe(true)
    )
    expect(onEdgeSelect).toHaveBeenCalledOnce()
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      type: 'edge',
      edge: expect.objectContaining({
        source: 'plugin.alpha',
        target: 'plugin.beta',
      }),
    })
    expect(
      flowHarness.props?.edges?.find((edge) => edge.id === edgeId)
        ?.domAttributes?.['aria-pressed']
    ).toBe(true)

    act(() => {
      flowHarness.props?.onEdgesChange?.([
        { id: edgeId, type: 'select', selected: false },
      ])
    })

    await waitFor(() =>
      expect(
        flowHarness.props?.edges?.find((edge) => edge.id === edgeId)?.selected
      ).toBe(false)
    )
    expect(onEdgeSelect).toHaveBeenCalledOnce()
    expect(onSelectionChange).toHaveBeenLastCalledWith(null)
  })

  it('replaces selection from a mixed false-then-true batch without intermediate null', async () => {
    const layoutNodes = vi.fn().mockResolvedValue(positions(modelA))
    const onEdgeSelect = vi.fn()
    const onSelectionChange = vi.fn()
    renderInReactFlowProvider(
      <PluginCallGraph
        {...graphProps(modelA, layoutNodes)}
        onEdgeSelect={onEdgeSelect}
        onSelectionChange={onSelectionChange}
      />
    )
    await waitFor(() => expect(flowHarness.props?.edges).toHaveLength(2))
    const firstEdgeId = JSON.stringify(['plugin.alpha', 'plugin.beta'])
    const secondEdgeId = JSON.stringify(['plugin.beta', 'plugin.gamma'])
    act(() => {
      flowHarness.props?.onEdgesChange?.([
        { id: firstEdgeId, type: 'select', selected: true },
      ])
    })
    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledOnce())
    onEdgeSelect.mockClear()
    onSelectionChange.mockClear()

    act(() => {
      flowHarness.props?.onEdgesChange?.([
        { id: firstEdgeId, type: 'select', selected: false },
        { id: secondEdgeId, type: 'select', selected: true },
      ])
    })

    expect(onEdgeSelect).toHaveBeenCalledOnce()
    expect(onEdgeSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: 'plugin.beta',
        target: 'plugin.gamma',
      })
    )
    expect(onSelectionChange).toHaveBeenCalledOnce()
    expect(onSelectionChange).not.toHaveBeenCalledWith(null)
  })

  it('rehydrates a selected node once when status or totals change', async () => {
    const user = userEvent.setup()
    const layoutNodes = vi.fn().mockResolvedValue(positions(modelA))
    const onNodeSelect = vi.fn()
    const onSelectionChange = vi.fn()
    const { getByTestId, rerender } = renderInReactFlowProvider(
      <PluginCallGraph
        {...graphProps(modelA, layoutNodes)}
        onNodeSelect={onNodeSelect}
        onSelectionChange={onSelectionChange}
      />
    )
    await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(3))
    expect(onSelectionChange).not.toHaveBeenCalled()
    await user.click(getByTestId('flow-node-plugin.alpha'))
    expect(onNodeSelect).toHaveBeenCalledOnce()
    onNodeSelect.mockClear()
    onSelectionChange.mockClear()

    rerender(
      <PluginCallGraph
        {...graphProps(modelANodePayloadUpdate, layoutNodes)}
        onNodeSelect={onNodeSelect}
        onSelectionChange={onSelectionChange}
      />
    )

    await waitFor(() => expect(onNodeSelect).toHaveBeenCalledOnce())
    expect(onNodeSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'plugin.alpha',
        status: 'error',
        outgoingCalls: 9,
      })
    )
    expect(onSelectionChange).toHaveBeenCalledOnce()
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      type: 'node',
      node: expect.objectContaining({
        id: 'plugin.alpha',
        status: 'error',
        outgoingCalls: 9,
      }),
    })

    act(() => {
      flowHarness.props?.onNodesChange?.([
        { id: 'plugin.alpha', type: 'select', selected: true },
      ])
    })
    await user.click(getByTestId('flow-node-plugin.alpha'))
    expect(onNodeSelect).toHaveBeenCalledOnce()
    expect(onSelectionChange).toHaveBeenCalledOnce()
  })

  it('clears a selected node before reconciling a reset model payload', async () => {
    const user = userEvent.setup()
    const layoutNodes = vi.fn().mockResolvedValue(positions(modelA))
    const onNodeSelect = vi.fn()
    const onSelectionChange = vi.fn()
    const { getByTestId, rerender } = renderInReactFlowProvider(
      <PluginCallGraph
        {...graphProps(modelA, layoutNodes)}
        selectionResetKey=""
        onNodeSelect={onNodeSelect}
        onSelectionChange={onSelectionChange}
      />
    )
    await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(3))
    await user.click(getByTestId('flow-node-plugin.alpha'))
    expect(getByTestId('flow-node-plugin.alpha')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    onNodeSelect.mockClear()
    onSelectionChange.mockClear()

    rerender(
      <PluginCallGraph
        {...graphProps(modelACountUpdate, layoutNodes)}
        selectionResetKey="Alpha Tools"
        onNodeSelect={onNodeSelect}
        onSelectionChange={onSelectionChange}
      />
    )

    await waitFor(() =>
      expect(getByTestId('flow-node-plugin.alpha')).toHaveAttribute(
        'aria-pressed',
        'false'
      )
    )
    expect(onNodeSelect).not.toHaveBeenCalled()
    expect(onSelectionChange).toHaveBeenCalledOnce()
    expect(onSelectionChange).toHaveBeenLastCalledWith(null)
    expect(
      onSelectionChange.mock.calls.some(([payload]) => payload?.type === 'node')
    ).toBe(false)

    onSelectionChange.mockClear()
    rerender(
      <PluginCallGraph
        {...graphProps(modelACountUpdate, layoutNodes)}
        selectionResetKey="Alpha Tools"
        onNodeSelect={onNodeSelect}
        onSelectionChange={onSelectionChange}
      />
    )
    await act(async () => {})
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('rehydrates a selected edge once when calls, time, or breakdown change', async () => {
    const user = userEvent.setup()
    const layoutNodes = vi.fn().mockResolvedValue(positions(modelA))
    const onEdgeSelect = vi.fn()
    const onSelectionChange = vi.fn()
    const { getByTestId, rerender } = renderInReactFlowProvider(
      <PluginCallGraph
        {...graphProps(modelA, layoutNodes)}
        onEdgeSelect={onEdgeSelect}
        onSelectionChange={onSelectionChange}
      />
    )
    await waitFor(() => expect(flowHarness.props?.edges).toHaveLength(2))
    const edgeId = JSON.stringify(['plugin.alpha', 'plugin.beta'])
    await user.click(getByTestId(`flow-edge-${edgeId}`))
    expect(onEdgeSelect).toHaveBeenCalledOnce()
    onEdgeSelect.mockClear()
    onSelectionChange.mockClear()

    rerender(
      <PluginCallGraph
        {...graphProps(modelAEdgePayloadUpdate, layoutNodes)}
        onEdgeSelect={onEdgeSelect}
        onSelectionChange={onSelectionChange}
      />
    )

    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledOnce())
    expect(onEdgeSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: 'plugin.alpha',
        target: 'plugin.beta',
        totalCalls: 10,
        commandCount: 2,
        lastCalledAt: 220,
        commands: [
          { commandId: 'plugin.beta.run', calls: 7, lastCalledAt: 220 },
          { commandId: 'plugin.beta.inspect', calls: 3, lastCalledAt: 210 },
        ],
      })
    )
    expect(onSelectionChange).toHaveBeenCalledOnce()
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      type: 'edge',
      edge: expect.objectContaining({
        source: 'plugin.alpha',
        target: 'plugin.beta',
        totalCalls: 10,
        commandCount: 2,
        lastCalledAt: 220,
      }),
    })

    act(() => {
      flowHarness.props?.onEdgesChange?.([
        { id: edgeId, type: 'select', selected: true },
      ])
    })
    await user.click(getByTestId(`flow-edge-${edgeId}`))
    expect(onEdgeSelect).toHaveBeenCalledOnce()
    expect(onSelectionChange).toHaveBeenCalledOnce()
  })

  it('keeps the current node payload when a stale canvas selects it during structural layout', async () => {
    const user = userEvent.setup()
    const pendingLayout = deferred<CallGraphNodeLayout>()
    const layoutNodes = vi
      .fn()
      .mockResolvedValueOnce(positions(modelA))
      .mockReturnValueOnce(pendingLayout.promise)
    const onNodeSelect = vi.fn()
    let inspectorSelection: PluginCallGraphSelection = null
    const onSelectionChange = vi.fn((selection: PluginCallGraphSelection) => {
      inspectorSelection = selection
    })
    const { findByRole, getByTestId, queryByRole, rerender } =
      renderInReactFlowProvider(
        <PluginCallGraph
          {...graphProps(modelA, layoutNodes)}
          onNodeSelect={onNodeSelect}
          onSelectionChange={onSelectionChange}
        />
      )
    await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(3))
    expect(
      await findByRole('group', { name: 'Call volume legend' })
    ).toBeVisible()
    await user.click(getByTestId('flow-node-plugin.alpha'))
    onNodeSelect.mockClear()
    onSelectionChange.mockClear()

    rerender(
      <PluginCallGraph
        {...graphProps(modelB, layoutNodes)}
        onNodeSelect={onNodeSelect}
        onSelectionChange={onSelectionChange}
      />
    )

    await waitFor(() => expect(layoutNodes).toHaveBeenCalledTimes(2))
    expect(
      queryByRole('group', { name: 'Call volume legend' })
    ).not.toBeInTheDocument()
    await waitFor(() => expect(onNodeSelect).toHaveBeenCalledOnce())
    expect(onNodeSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'plugin.alpha', outgoingCalls: 4 })
    )
    expect(inspectorSelection).toEqual({
      type: 'node',
      node: expect.objectContaining({
        id: 'plugin.alpha',
        outgoingCalls: 4,
      }),
    })
    onNodeSelect.mockClear()
    onSelectionChange.mockClear()

    act(() => {
      flowHarness.props?.onNodesChange?.([
        { id: 'plugin.alpha', type: 'select', selected: true },
      ])
    })
    expect(onNodeSelect).not.toHaveBeenCalled()
    expect(onSelectionChange).not.toHaveBeenCalled()

    await user.click(getByTestId('flow-node-plugin.alpha'))
    expect(onNodeSelect).not.toHaveBeenCalled()
    expect(onSelectionChange).not.toHaveBeenCalled()
    expect(inspectorSelection).toEqual({
      type: 'node',
      node: expect.objectContaining({
        id: 'plugin.alpha',
        outgoingCalls: 4,
      }),
    })
    expect(getByTestId('flow-node-plugin.alpha')).toHaveAttribute(
      'data-selected',
      'true'
    )

    await act(async () => pendingLayout.resolve(positions(modelB, 80)))
    await waitFor(() =>
      expect(flowHarness.props?.nodes?.map((node) => node.id)).toEqual([
        'plugin.alpha',
        'plugin.gamma',
      ])
    )
    expect(
      await findByRole('group', { name: 'Call volume legend' })
    ).toBeVisible()
    expect(onNodeSelect).not.toHaveBeenCalled()
    expect(onSelectionChange).not.toHaveBeenCalled()
    expect(inspectorSelection).toEqual({
      type: 'node',
      node: expect.objectContaining({
        id: 'plugin.alpha',
        outgoingCalls: 4,
      }),
    })
  })

  it('ignores stale edge selection after the current model removes it during structural layout', async () => {
    const user = userEvent.setup()
    const pendingLayout = deferred<CallGraphNodeLayout>()
    const layoutNodes = vi
      .fn()
      .mockResolvedValueOnce(positions(modelA))
      .mockReturnValueOnce(pendingLayout.promise)
    const onEdgeSelect = vi.fn()
    let inspectorSelection: PluginCallGraphSelection = null
    const onSelectionChange = vi.fn((selection: PluginCallGraphSelection) => {
      inspectorSelection = selection
    })
    const edgeId = JSON.stringify(['plugin.alpha', 'plugin.beta'])
    const { getByTestId, rerender } = renderInReactFlowProvider(
      <PluginCallGraph
        {...graphProps(modelA, layoutNodes)}
        onEdgeSelect={onEdgeSelect}
        onSelectionChange={onSelectionChange}
      />
    )
    await waitFor(() => expect(flowHarness.props?.edges).toHaveLength(2))
    await user.click(getByTestId(`flow-edge-${edgeId}`))
    onEdgeSelect.mockClear()
    onSelectionChange.mockClear()

    rerender(
      <PluginCallGraph
        {...graphProps(modelB, layoutNodes)}
        onEdgeSelect={onEdgeSelect}
        onSelectionChange={onSelectionChange}
      />
    )

    await waitFor(() => expect(layoutNodes).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(onSelectionChange).toHaveBeenCalledOnce())
    expect(onSelectionChange).toHaveBeenLastCalledWith(null)
    expect(inspectorSelection).toBeNull()
    await waitFor(() =>
      expect(getByTestId(`flow-edge-${edgeId}`)).toHaveAttribute(
        'data-selected',
        'false'
      )
    )
    onEdgeSelect.mockClear()
    onSelectionChange.mockClear()

    act(() => {
      flowHarness.props?.onEdgesChange?.([
        { id: edgeId, type: 'select', selected: true },
      ])
    })
    expect(onEdgeSelect).not.toHaveBeenCalled()
    expect(onSelectionChange).not.toHaveBeenCalled()

    await user.click(getByTestId(`flow-edge-${edgeId}`))
    expect(onEdgeSelect).not.toHaveBeenCalled()
    expect(onSelectionChange).not.toHaveBeenCalled()
    expect(inspectorSelection).toBeNull()
    expect(getByTestId(`flow-edge-${edgeId}`)).toHaveAttribute(
      'data-selected',
      'false'
    )

    await act(async () => pendingLayout.resolve(positions(modelB, 80)))
    await waitFor(() => expect(flowHarness.props?.edges).toHaveLength(1))
    expect(onEdgeSelect).not.toHaveBeenCalled()
    expect(onSelectionChange).not.toHaveBeenCalled()
    expect(inspectorSelection).toBeNull()
    expect(flowHarness.props?.edges?.every((edge) => !edge.selected)).toBe(true)
  })

  it('does not re-notify an equal selected payload when model and callbacks are cloned', async () => {
    const user = userEvent.setup()
    const layoutNodes = vi.fn().mockResolvedValue(positions(modelA))
    const onNodeSelect = vi.fn()
    const onSelectionChange = vi.fn()
    const { getByTestId, rerender } = renderInReactFlowProvider(
      <PluginCallGraph
        {...graphProps(modelA, layoutNodes)}
        onNodeSelect={onNodeSelect}
        onSelectionChange={onSelectionChange}
      />
    )
    await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(3))
    await user.click(getByTestId('flow-node-plugin.alpha'))
    const clonedModel = graphModel([
      edge('plugin.alpha', 'plugin.beta', 2),
      edge('plugin.beta', 'plugin.gamma', 3),
    ])
    const replacementNodeSelect = vi.fn()
    const replacementSelectionChange = vi.fn()

    rerender(
      <PluginCallGraph
        {...graphProps(clonedModel, layoutNodes)}
        onNodeSelect={replacementNodeSelect}
        onSelectionChange={replacementSelectionChange}
      />
    )
    await act(async () => {})

    expect(replacementNodeSelect).not.toHaveBeenCalled()
    expect(replacementSelectionChange).not.toHaveBeenCalled()
    expect(layoutNodes).toHaveBeenCalledOnce()
  })

  it('preserves route-local moves on count-only updates and passes prior layout on structural changes', async () => {
    const firstLayout = positions(modelA)
    const secondLayout = positions(modelB, 40)
    const layoutNodes = vi
      .fn()
      .mockResolvedValueOnce(firstLayout)
      .mockResolvedValueOnce(secondLayout)
    const { rerender } = renderInReactFlowProvider(
      <PluginCallGraph {...graphProps(modelA, layoutNodes)} />
    )
    await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(3))
    await waitFor(() => expect(flowHarness.fitView).toHaveBeenCalledOnce())
    flowHarness.fitView.mockClear()

    act(() => {
      flowHarness.props?.onNodesChange?.([
        {
          type: 'position',
          id: 'plugin.alpha',
          position: { x: 777, y: 333 },
          dragging: false,
        },
      ])
    })
    rerender(
      <PluginCallGraph {...graphProps(modelACountUpdate, layoutNodes)} />
    )

    await waitFor(() => {
      const alpha = flowHarness.props?.nodes?.find(
        (node) => node.id === 'plugin.alpha'
      )
      expect(alpha?.position).toEqual({ x: 777, y: 333 })
      expect(alpha?.data.model).toMatchObject({ outgoingCalls: 9 })
    })
    expect(layoutNodes).toHaveBeenCalledTimes(1)
    expect(flowHarness.fitView).not.toHaveBeenCalled()

    rerender(<PluginCallGraph {...graphProps(modelB, layoutNodes)} />)
    await waitFor(() => expect(layoutNodes).toHaveBeenCalledTimes(2))
    expect(layoutNodes.mock.calls[1]?.[1]).toBe(firstLayout)
    await waitFor(() =>
      expect(flowHarness.props?.nodes?.map((node) => node.id)).toEqual([
        'plugin.alpha',
        'plugin.gamma',
      ])
    )
    await waitFor(() => expect(flowHarness.fitView).toHaveBeenCalledOnce())
  })

  it('uses the latest count data when a same-signature update arrives during layout', async () => {
    const pending = deferred<CallGraphNodeLayout>()
    const layoutNodes = vi.fn().mockReturnValue(pending.promise)
    const { rerender } = renderInReactFlowProvider(
      <PluginCallGraph {...graphProps(modelA, layoutNodes)} />
    )
    await waitFor(() => expect(layoutNodes).toHaveBeenCalledOnce())

    rerender(
      <PluginCallGraph
        {...graphProps(modelACountUpdate, layoutNodes)}
        iconsByPluginId={{ 'plugin.alpha': 'alpha-icon.png' }}
      />
    )
    expect(layoutNodes).toHaveBeenCalledOnce()

    await act(async () => pending.resolve(positions(modelA, 35)))

    await waitFor(() => {
      const alpha = flowHarness.props?.nodes?.find(
        (node) => node.id === 'plugin.alpha'
      )
      expect(alpha?.position.x).toBe(35)
      expect(alpha?.data.model).toMatchObject({ outgoingCalls: 9 })
      expect(alpha?.data.icon).toBe('alpha-icon.png')
    })
  })

  it('does not relayout when localized presentation or callbacks change', async () => {
    const layoutNodes = vi.fn().mockResolvedValue(positions(modelA))
    const { rerender } = renderInReactFlowProvider(
      <PluginCallGraph
        {...graphProps(modelA, layoutNodes)}
        onNodeSelect={vi.fn()}
      />
    )
    await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(3))

    rerender(
      <PluginCallGraph
        {...graphProps(modelA, layoutNodes)}
        strings={{
          ...strings,
          graphDescription:
            '3 localized plugins and 2 localized relationships.',
        }}
        onNodeSelect={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(flowHarness.props?.['aria-describedby']).toBeTruthy()
    )
    expect(layoutNodes).toHaveBeenCalledTimes(1)
  })

  it('restarts a pending layout when its adapter changes at the same signature', async () => {
    const first = deferred<CallGraphNodeLayout>()
    const second = deferred<CallGraphNodeLayout>()
    const adapterA = vi.fn().mockReturnValue(first.promise)
    const adapterB = vi.fn().mockReturnValue(second.promise)
    const { rerender } = renderInReactFlowProvider(
      <PluginCallGraph {...graphProps(modelA, adapterA)} />
    )
    await waitFor(() => expect(adapterA).toHaveBeenCalledOnce())

    rerender(<PluginCallGraph {...graphProps(modelA, adapterB)} />)
    await waitFor(() => expect(adapterB).toHaveBeenCalledOnce())

    await act(async () => second.resolve(positions(modelA, 70)))
    expect(flowHarness.props?.nodes?.[0]?.position.x).toBe(70)
    const fitCount = flowHarness.fitView.mock.calls.length

    await act(async () => first.resolve(positions(modelA, 900)))
    expect(flowHarness.props?.nodes?.[0]?.position.x).toBe(70)
    expect(flowHarness.fitView).toHaveBeenCalledTimes(fitCount)
  })

  it('ignores rejection from a replaced same-signature layout adapter', async () => {
    const first = deferred<CallGraphNodeLayout>()
    const second = deferred<CallGraphNodeLayout>()
    const adapterA = vi.fn().mockReturnValue(first.promise)
    const adapterB = vi.fn().mockReturnValue(second.promise)
    const { queryByRole, rerender } = renderInReactFlowProvider(
      <PluginCallGraph {...graphProps(modelA, adapterA)} />
    )
    await waitFor(() => expect(adapterA).toHaveBeenCalledOnce())

    rerender(<PluginCallGraph {...graphProps(modelA, adapterB)} />)
    await waitFor(() => expect(adapterB).toHaveBeenCalledOnce())
    await act(async () => second.resolve(positions(modelA, 80)))
    await act(async () => first.reject(new Error('replaced adapter failed')))

    expect(queryByRole('alert')).not.toBeInTheDocument()
    expect(flowHarness.props?.nodes?.[0]?.position.x).toBe(80)
  })

  it('keeps only the newest result across an A-to-B-to-A signature sequence', async () => {
    const oldA = deferred<CallGraphNodeLayout>()
    const middleB = deferred<CallGraphNodeLayout>()
    const currentA = deferred<CallGraphNodeLayout>()
    const layoutNodes = vi
      .fn()
      .mockReturnValueOnce(oldA.promise)
      .mockReturnValueOnce(middleB.promise)
      .mockReturnValueOnce(currentA.promise)
    const { queryByRole, rerender } = renderInReactFlowProvider(
      <PluginCallGraph {...graphProps(modelA, layoutNodes)} />
    )
    await waitFor(() => expect(layoutNodes).toHaveBeenCalledTimes(1))
    rerender(<PluginCallGraph {...graphProps(modelB, layoutNodes)} />)
    await waitFor(() => expect(layoutNodes).toHaveBeenCalledTimes(2))
    rerender(<PluginCallGraph {...graphProps(modelA, layoutNodes)} />)
    await waitFor(() => expect(layoutNodes).toHaveBeenCalledTimes(3))

    await act(async () => currentA.resolve(positions(modelA, 65)))
    expect(flowHarness.props?.nodes?.[0]?.position.x).toBe(65)
    const fitCount = flowHarness.fitView.mock.calls.length

    await act(async () => middleB.reject(new Error('stale middle failure')))
    await act(async () => oldA.resolve(positions(modelA, 950)))

    expect(queryByRole('alert')).not.toBeInTheDocument()
    expect(flowHarness.props?.nodes?.[0]?.position.x).toBe(65)
    expect(flowHarness.fitView).toHaveBeenCalledTimes(fitCount)
  })

  it('ignores an older layout that resolves after the current signature', async () => {
    const first = deferred<CallGraphNodeLayout>()
    const second = deferred<CallGraphNodeLayout>()
    const layoutNodes = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { rerender } = renderInReactFlowProvider(
      <PluginCallGraph {...graphProps(modelA, layoutNodes)} />
    )
    await waitFor(() => expect(layoutNodes).toHaveBeenCalledTimes(1))
    rerender(<PluginCallGraph {...graphProps(modelB, layoutNodes)} />)
    await waitFor(() => expect(layoutNodes).toHaveBeenCalledTimes(2))

    await act(async () => second.resolve(positions(modelB, 80)))
    expect(flowHarness.props?.nodes?.map((node) => node.id)).toEqual([
      'plugin.alpha',
      'plugin.gamma',
    ])
    await act(async () => first.resolve(positions(modelA, 900)))
    expect(flowHarness.props?.nodes?.map((node) => node.id)).toEqual([
      'plugin.alpha',
      'plugin.gamma',
    ])
    expect(flowHarness.props?.nodes?.[0]?.position.x).toBe(80)
  })

  it('ignores an older rejection after a newer layout succeeds', async () => {
    const first = deferred<CallGraphNodeLayout>()
    const second = deferred<CallGraphNodeLayout>()
    const layoutNodes = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { queryByRole, rerender } = renderInReactFlowProvider(
      <PluginCallGraph {...graphProps(modelA, layoutNodes)} />
    )
    await waitFor(() => expect(layoutNodes).toHaveBeenCalledTimes(1))
    rerender(<PluginCallGraph {...graphProps(modelB, layoutNodes)} />)
    await waitFor(() => expect(layoutNodes).toHaveBeenCalledTimes(2))

    await act(async () => second.resolve(positions(modelB)))
    await act(async () => first.reject(new Error('stale ELK failure')))

    expect(queryByRole('alert')).not.toBeInTheDocument()
    expect(flowHarness.props?.nodes?.map((node) => node.id)).toEqual([
      'plugin.alpha',
      'plugin.gamma',
    ])
  })

  it('settles late layout resolution and rejection after unmount without errors', async () => {
    const lateResolve = deferred<CallGraphNodeLayout>()
    const resolveAdapter = vi.fn().mockReturnValue(lateResolve.promise)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const firstView = renderInReactFlowProvider(
      <PluginCallGraph {...graphProps(modelA, resolveAdapter)} />
    )
    await waitFor(() => expect(resolveAdapter).toHaveBeenCalledOnce())
    firstView.unmount()

    await expect(
      act(async () => lateResolve.resolve(positions(modelA)))
    ).resolves.toBeUndefined()

    const lateReject = deferred<CallGraphNodeLayout>()
    const rejectAdapter = vi.fn().mockReturnValue(lateReject.promise)
    const secondView = renderInReactFlowProvider(
      <PluginCallGraph {...graphProps(modelA, rejectAdapter)} />
    )
    await waitFor(() => expect(rejectAdapter).toHaveBeenCalledOnce())
    secondView.unmount()

    await expect(
      act(async () => lateReject.reject(new Error('late failure')))
    ).resolves.toBeUndefined()
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('clears a hovered element removed by a structural model update', async () => {
    const layoutNodes: NonNullable<PluginCallGraphProps['layoutNodes']> = vi.fn(
      (nextModel) => Promise.resolve(positions(nextModel))
    )
    const { getByTestId, rerender } = renderInReactFlowProvider(
      <PluginCallGraph {...graphProps(modelA, layoutNodes)} />
    )
    await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(3))
    fireEvent.mouseEnter(getByTestId('flow-node-plugin.alpha'))
    expect(getByTestId('flow-node-plugin.gamma')).toHaveAttribute(
      'data-dimmed',
      'true'
    )

    rerender(
      <PluginCallGraph {...graphProps(modelWithoutAlpha, layoutNodes)} />
    )

    await waitFor(() =>
      expect(flowHarness.props?.nodes?.map((node) => node.id)).toEqual([
        'plugin.beta',
        'plugin.gamma',
      ])
    )
    expect(getByTestId('flow-node-plugin.beta')).toHaveAttribute(
      'data-dimmed',
      'false'
    )
    expect(getByTestId('flow-node-plugin.gamma')).toHaveAttribute(
      'data-dimmed',
      'false'
    )
  })

  it('clears a hovered edge removed by a structural model update', async () => {
    const layoutNodes: NonNullable<PluginCallGraphProps['layoutNodes']> = vi.fn(
      (nextModel) => Promise.resolve(positions(nextModel))
    )
    const { getByTestId, rerender } = renderInReactFlowProvider(
      <PluginCallGraph {...graphProps(modelA, layoutNodes)} />
    )
    await waitFor(() => expect(flowHarness.props?.edges).toHaveLength(2))
    fireEvent.mouseEnter(
      getByTestId('flow-edge-["plugin.alpha","plugin.beta"]')
    )
    expect(getByTestId('flow-node-plugin.gamma')).toHaveAttribute(
      'data-dimmed',
      'true'
    )

    rerender(<PluginCallGraph {...graphProps(modelB, layoutNodes)} />)

    await waitFor(() => expect(flowHarness.props?.edges).toHaveLength(1))
    expect(getByTestId('flow-node-plugin.alpha')).toHaveAttribute(
      'data-dimmed',
      'false'
    )
    expect(getByTestId('flow-node-plugin.gamma')).toHaveAttribute(
      'data-dimmed',
      'false'
    )
  })

  it('clears selection once when the selected element leaves the model', async () => {
    const user = userEvent.setup()
    const layoutNodes: NonNullable<PluginCallGraphProps['layoutNodes']> = vi.fn(
      (nextModel) => Promise.resolve(positions(nextModel))
    )
    const onNodeSelect = vi.fn()
    const onSelectionChange = vi.fn()
    const { getByTestId, rerender } = renderInReactFlowProvider(
      <PluginCallGraph
        {...graphProps(modelA, layoutNodes)}
        onNodeSelect={onNodeSelect}
        onSelectionChange={onSelectionChange}
      />
    )
    await waitFor(() => expect(flowHarness.props?.nodes).toHaveLength(3))
    await user.click(getByTestId('flow-node-plugin.alpha'))
    expect(onNodeSelect).toHaveBeenCalledOnce()

    rerender(
      <PluginCallGraph
        {...graphProps(modelWithoutAlpha, layoutNodes)}
        onNodeSelect={onNodeSelect}
        onSelectionChange={onSelectionChange}
      />
    )

    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith(null)
    )
    expect(onSelectionChange).toHaveBeenCalledTimes(2)
    await waitFor(() =>
      expect(flowHarness.props?.nodes?.map((node) => node.id)).toEqual([
        'plugin.beta',
        'plugin.gamma',
      ])
    )
    expect(flowHarness.props?.nodes?.every((node) => !node.selected)).toBe(true)
  })

  it('clears edge selection once when the selected pair leaves the model', async () => {
    const user = userEvent.setup()
    const layoutNodes: NonNullable<PluginCallGraphProps['layoutNodes']> = vi.fn(
      (nextModel) => Promise.resolve(positions(nextModel))
    )
    const onEdgeSelect = vi.fn()
    const onSelectionChange = vi.fn()
    const { getByTestId, rerender } = renderInReactFlowProvider(
      <PluginCallGraph
        {...graphProps(modelA, layoutNodes)}
        onEdgeSelect={onEdgeSelect}
        onSelectionChange={onSelectionChange}
      />
    )
    await waitFor(() => expect(flowHarness.props?.edges).toHaveLength(2))
    await user.click(getByTestId('flow-edge-["plugin.alpha","plugin.beta"]'))
    expect(onEdgeSelect).toHaveBeenCalledOnce()

    rerender(
      <PluginCallGraph
        {...graphProps(modelB, layoutNodes)}
        onEdgeSelect={onEdgeSelect}
        onSelectionChange={onSelectionChange}
      />
    )

    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith(null)
    )
    expect(onSelectionChange).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(flowHarness.props?.edges).toHaveLength(1))
    expect(flowHarness.props?.edges?.every((edge) => !edge.selected)).toBe(true)
  })

  it('shows a localized current layout failure and retries successfully', async () => {
    const user = userEvent.setup()
    const first = deferred<CallGraphNodeLayout>()
    const second = deferred<CallGraphNodeLayout>()
    const layoutNodes = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { findByRole, getByRole, queryByRole } = renderInReactFlowProvider(
      <PluginCallGraph {...graphProps(modelA, layoutNodes)} />
    )
    await waitFor(() => expect(layoutNodes).toHaveBeenCalledTimes(1))

    await act(async () => first.reject(new Error('current ELK failure')))
    expect(getByRole('alert')).toHaveTextContent(
      'The relationship map could not be arranged.'
    )
    expect(queryByRole('group', { name: 'Call volume legend' })).toBeNull()

    await user.click(getByRole('button', { name: 'Arrange map again' }))
    await waitFor(() => expect(layoutNodes).toHaveBeenCalledTimes(2))
    expect(queryByRole('group', { name: 'Call volume legend' })).toBeNull()
    await act(async () => second.resolve(positions(modelA)))

    await waitFor(() => expect(queryByRole('alert')).not.toBeInTheDocument())
    expect(
      await findByRole('group', { name: 'Call volume legend' })
    ).toBeVisible()
    expect(flowHarness.props?.nodes).toHaveLength(3)
    expect(flowHarness.fitView).toHaveBeenCalled()
  })
})
