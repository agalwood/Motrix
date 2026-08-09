import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import type { PluginCommandGraphEdge } from '@shared/types/plugin-command-graph'
import { fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AriaLabelConfig, NodeProps } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCallGraphModel } from '../../lib/call-graph-model'
import {
  installGraphTestEnvironment,
  renderInReactFlowProvider,
} from './graph-test-utils'
import {
  PluginCallGraph,
  type PluginCallGraphStrings,
} from './plugin-call-graph'
import {
  PluginCallGraphNode,
  type PluginCallGraphNodeData,
  type PluginCallGraphNodeType,
} from './plugin-call-graph-node'

const strings: PluginCallGraphNodeData['strings'] = {
  statuses: {
    active: 'Running',
    inactive: 'Ready but idle',
    disabled: 'Turned off',
    error: 'Needs attention',
    missing: 'Not on this device',
  },
  incoming: 'Received calls',
  outgoing: 'Sent calls',
}

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

const graphStrings: PluginCallGraphStrings = {
  graphAriaLabel: 'Plugin command relationships',
  graphDescription: '2 plugins and 1 relationship from the last 24 hours.',
  layoutError: 'The relationship map could not be arranged.',
  retryLayout: 'Arrange map again',
  legend: {
    label: 'Call volume legend',
    fewerCalls: 'Fewer calls',
    moreCalls: 'More calls',
  },
  node: strings,
  ariaLabelConfig,
  nodeAriaLabel: (node) => `${node.name}, plugin node ${node.id}`,
  edgeAriaLabel: (edge) =>
    `${edge.source} calls ${edge.target} ${edge.totalCalls} times`,
  callsLabel: (count) => `${count} successful calls`,
  commandsLabel: (count) => `${count} command kinds`,
}

const graphEdge: PluginCommandGraphEdge = {
  sourcePluginId: 'plugin.alpha',
  targetPluginId: 'plugin.beta',
  commandId: 'plugin.beta.run',
  calls: 4,
  lastCalledAt: 100,
}

const realFlowModel = buildCallGraphModel({ edges: [graphEdge] }, [
  { id: 'plugin.alpha', name: 'Alpha Tools', status: 'active' },
  { id: 'plugin.beta', name: 'Beta Tools', status: 'inactive' },
])

const realFlowLayout = {
  structuralSignature: realFlowModel.signature,
  positions: {
    'plugin.alpha': { x: 10, y: 40 },
    'plugin.beta': { x: 360, y: 40 },
  },
}

function nodeProps(
  data: Partial<PluginCallGraphNodeData> = {},
  selected = false
): NodeProps<PluginCallGraphNodeType> {
  return {
    id: 'plugin.alpha',
    type: 'pluginCallGraph',
    data: {
      model: {
        id: 'plugin.alpha',
        name: 'Alpha Tools',
        installed: true,
        status: 'active',
        incomingCalls: 7,
        outgoingCalls: 13,
      },
      strings,
      ...data,
    },
    width: 224,
    height: 88,
    sourcePosition: undefined,
    targetPosition: undefined,
    dragHandle: undefined,
    parentId: undefined,
    dragging: false,
    zIndex: 0,
    selectable: true,
    deletable: false,
    selected,
    draggable: true,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  }
}

describe('PluginCallGraphNode', () => {
  let restoreEnvironment: () => void

  beforeEach(() => {
    restoreEnvironment = installGraphTestEnvironment()
  })

  afterEach(() => {
    restoreEnvironment()
  })

  it('renders an installed plugin avatar, identity, localized status, and totals', () => {
    const { container, getByText } = renderInReactFlowProvider(
      <PluginCallGraphNode {...nodeProps()} />
    )

    expect(container.querySelector('[data-slot="avatar"]')).toBeInTheDocument()
    expect(container.querySelector('.bg-emerald-500')).toBeInTheDocument()
    expect(getByText('Alpha Tools')).toBeInTheDocument()
    expect(getByText('plugin.alpha')).toBeInTheDocument()
    expect(getByText('Running')).toBeInTheDocument()
    expect(getByText('Received calls: 7')).toHaveClass('sr-only')
    expect(getByText('Sent calls: 13')).toHaveClass('sr-only')
    expect(getByText('Alpha Tools').closest('[data-testid]')).toHaveClass(
      'motion-reduce:transition-none'
    )
  })

  it('renders a missing historical plugin without an installed status dot', () => {
    const { container, getByText } = renderInReactFlowProvider(
      <PluginCallGraphNode
        {...nodeProps({
          model: {
            id: 'plugin.removed',
            name: 'plugin.removed',
            installed: false,
            status: 'missing',
            incomingCalls: 2,
            outgoingCalls: 0,
          },
        })}
      />
    )

    expect(container.querySelectorAll('code')).toHaveLength(1)
    expect(container.querySelector('code')).toHaveTextContent('plugin.removed')
    expect(getByText('Not on this device')).toBeInTheDocument()
    expect(container.querySelector('.bg-emerald-500')).not.toBeInTheDocument()
    expect(
      container.querySelector('[data-missing-status-icon="true"]')
    ).toBeInTheDocument()
  })

  it('renders fixed non-connectable target and source handles', () => {
    const { container } = renderInReactFlowProvider(
      <PluginCallGraphNode {...nodeProps()} />
    )
    const target = container.querySelector('.react-flow__handle-left')
    const source = container.querySelector('.react-flow__handle-right')

    expect(target).toHaveAttribute('data-handlepos', 'left')
    expect(source).toHaveAttribute('data-handlepos', 'right')
    expect(target).not.toHaveClass('connectable')
    expect(source).not.toHaveClass('connectable')
    expect(target).not.toHaveClass('connectablestart', 'connectableend')
    expect(source).not.toHaveClass('connectablestart', 'connectableend')
  })

  it('exposes selected state without relying on color alone', () => {
    const { getByTestId } = renderInReactFlowProvider(
      <PluginCallGraphNode {...nodeProps({}, true)} />
    )

    expect(getByTestId('plugin-call-graph-node')).toHaveAttribute(
      'data-selected',
      'true'
    )
  })

  it('does not add a second keyboard stop inside the React Flow wrapper', () => {
    const { getByTestId } = renderInReactFlowProvider(
      <PluginCallGraphNode {...nodeProps()} />
    )
    const presentation = getByTestId('plugin-call-graph-node')

    expect(presentation).not.toHaveAttribute('tabindex')
    expect(presentation).not.toHaveAttribute('role')
    expect(presentation.querySelectorAll('button, [tabindex]')).toHaveLength(0)
  })

  it('uses the real React Flow node wrapper as the only stop and selects with Enter or Space', async () => {
    const user = userEvent.setup()
    const onNodeSelect = vi.fn()
    const onSelectionChange = vi.fn()
    const { container } = renderInReactFlowProvider(
      <PluginCallGraph
        model={realFlowModel}
        density="full"
        strings={graphStrings}
        layoutNodes={vi.fn().mockResolvedValue(realFlowLayout)}
        onNodeSelect={onNodeSelect}
        onSelectionChange={onSelectionChange}
      />
    )

    const node = await waitFor(() => {
      const element = container.querySelector(
        '[data-testid="rf__node-plugin.alpha"]'
      )
      expect(element).toBeInTheDocument()
      return element as HTMLElement
    })
    expect(node).toHaveAttribute('tabindex', '0')
    expect(
      node.querySelectorAll(
        'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).toHaveLength(0)

    node.focus()
    expect(node).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(onNodeSelect).toHaveBeenCalledOnce())
    expect(node).toHaveAttribute('aria-pressed', 'true')

    await user.keyboard('{ArrowRight}')
    await waitFor(() =>
      expect(node.style.transform).toBe('translate(15px,40px)')
    )

    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith(null)
    )
    await waitFor(() => expect(node).not.toHaveFocus())
    node.focus()
    expect(node).toHaveFocus()
    await user.keyboard(' ')
    await waitFor(() => expect(onNodeSelect).toHaveBeenCalledTimes(2))
  })

  it('selects and clears a controlled edge through the real React Flow keyboard wrapper', async () => {
    const user = userEvent.setup()
    const onEdgeSelect = vi.fn()
    const onSelectionChange = vi.fn()
    const { container } = renderInReactFlowProvider(
      <PluginCallGraph
        model={realFlowModel}
        density="full"
        strings={graphStrings}
        layoutNodes={vi.fn().mockResolvedValue(realFlowLayout)}
        onEdgeSelect={onEdgeSelect}
        onSelectionChange={onSelectionChange}
      />
    )

    const edge = await waitFor(() => {
      const element = container.querySelector('.react-flow__edge')
      expect(element).toBeInTheDocument()
      return element as SVGGElement
    })
    expect(edge).toHaveAttribute('role', 'button')
    expect(edge).toHaveAttribute('aria-pressed', 'false')
    edge.focus()
    expect(edge).toHaveFocus()
    await user.keyboard('{Enter}')

    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(container.querySelector('.react-flow__edge')).toHaveClass(
        'selected'
      )
    )
    expect(edge).toHaveAttribute('aria-pressed', 'true')
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      type: 'edge',
      edge: expect.objectContaining({
        source: 'plugin.alpha',
        target: 'plugin.beta',
      }),
    })

    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith(null)
    )
    expect(edge).toHaveAttribute('aria-pressed', 'false')
    expect(onEdgeSelect).toHaveBeenCalledOnce()

    edge.focus()
    await user.keyboard(' ')
    await waitFor(() => expect(onEdgeSelect).toHaveBeenCalledTimes(2))
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      type: 'edge',
      edge: expect.objectContaining({
        source: 'plugin.alpha',
        target: 'plugin.beta',
      }),
    })
  })

  it('notifies once when the real React Flow node wrapper is clicked', async () => {
    const onNodeSelect = vi.fn()
    const onSelectionChange = vi.fn()
    const { container } = renderInReactFlowProvider(
      <PluginCallGraph
        model={realFlowModel}
        density="full"
        strings={graphStrings}
        layoutNodes={vi.fn().mockResolvedValue(realFlowLayout)}
        onNodeSelect={onNodeSelect}
        onSelectionChange={onSelectionChange}
      />
    )
    const node = await waitFor(() => {
      const element = container.querySelector(
        '[data-testid="rf__node-plugin.alpha"]'
      )
      expect(element).toBeInTheDocument()
      return element as HTMLElement
    })

    fireEvent.click(node)

    expect(onNodeSelect).toHaveBeenCalledOnce()
    expect(onSelectionChange).toHaveBeenCalledOnce()
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      type: 'node',
      node: expect.objectContaining({ id: 'plugin.alpha' }),
    })
  })
})
