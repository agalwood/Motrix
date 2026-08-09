import '@testing-library/jest-dom/vitest'
import { render } from '@testing-library/react'
import { type EdgeProps, getSmoothStepPath, Position } from '@xyflow/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PluginCallGraphEdge,
  type PluginCallGraphEdgeType,
} from './plugin-call-graph-edge'

const viewportHarness = vi.hoisted(() => ({ zoom: 1 }))

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  return {
    ...actual,
    getSmoothStepPath: vi.fn(actual.getSmoothStepPath),
    BaseEdge: ({
      path,
      markerEnd,
      className,
      style,
      ...props
    }: {
      path: string
      markerEnd?: string
      className?: string
      style?: React.CSSProperties
      [key: string]: unknown
    }) => (
      <svg aria-hidden="true" data-testid="base-edge">
        <path
          {...props}
          data-testid="edge-path"
          d={path}
          markerEnd={markerEnd}
          className={className}
          style={style}
        />
      </svg>
    ),
    EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="edge-label-layer">{children}</div>
    ),
    useViewport: () => ({ x: 0, y: 0, zoom: viewportHarness.zoom }),
  }
})

function edgeProps(
  overrides: Partial<EdgeProps<PluginCallGraphEdgeType>> = {}
): EdgeProps<PluginCallGraphEdgeType> {
  return {
    id: 'plugin.alpha->plugin.beta',
    type: 'pluginCallGraph',
    source: 'plugin.alpha',
    target: 'plugin.beta',
    sourceX: 224,
    sourceY: 44,
    targetX: 420,
    targetY: 144,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    selected: false,
    animated: false,
    data: {
      model: {
        source: 'plugin.alpha',
        target: 'plugin.beta',
        totalCalls: 18,
        commandCount: 2,
        lastCalledAt: 123,
        commands: [
          { commandId: 'beta.fetch', calls: 12, lastCalledAt: 123 },
          { commandId: 'beta.parse', calls: 6, lastCalledAt: 120 },
        ],
        strokeWidth: 5.5,
      },
      callsLabel: '18 successful calls',
      commandsLabel: '2 command kinds',
      density: 'full',
    },
    markerEnd: 'url(#arrow-at-target)',
    ...overrides,
  }
}

describe('PluginCallGraphEdge', () => {
  afterEach(() => {
    viewportHarness.zoom = 1
  })

  it('routes source to target with React Flow smooth-step and a target arrow', () => {
    const { getByTestId } = render(<PluginCallGraphEdge {...edgeProps()} />)

    expect(getSmoothStepPath).toHaveBeenCalledWith({
      sourceX: 224,
      sourceY: 44,
      sourcePosition: Position.Right,
      targetX: 420,
      targetY: 144,
      targetPosition: Position.Left,
    })
    expect(getByTestId('edge-path')).toHaveAttribute(
      'marker-end',
      'url(#arrow-at-target)'
    )
    expect(getByTestId('edge-path')).not.toHaveAttribute('marker-start')
  })

  it('routes a feedback edge below same-row intermediate nodes', () => {
    render(
      <PluginCallGraphEdge
        {...edgeProps({
          sourceX: 700,
          sourceY: 144,
          targetX: 200,
          targetY: 144,
        })}
      />
    )

    expect(getSmoothStepPath).toHaveBeenLastCalledWith({
      sourceX: 700,
      sourceY: 144,
      sourcePosition: Position.Right,
      targetX: 200,
      targetY: 144,
      targetPosition: Position.Left,
      centerY: 224,
    })
  })

  it('renders localized call and command labels in full density', () => {
    const { getByText } = render(<PluginCallGraphEdge {...edgeProps()} />)

    expect(
      getByText('18 successful calls · 2 command kinds')
    ).toBeInTheDocument()
  })

  it('hides low-zoom labels until the edge is selected', () => {
    viewportHarness.zoom = 0.5
    const { getByTestId, queryByTestId, rerender } = render(
      <PluginCallGraphEdge {...edgeProps()} />
    )

    expect(queryByTestId('edge-label')).not.toBeInTheDocument()

    rerender(<PluginCallGraphEdge {...edgeProps({ selected: true })} />)
    expect(getByTestId('edge-label')).toHaveStyle({
      transform: 'translate(-50%, -50%) scale(2)',
    })
    expect(getByTestId('edge-label')).toHaveClass(
      'max-w-[88px]',
      'whitespace-normal',
      'text-center',
      'leading-tight'
    )
  })

  it('keeps the designated compact label readable at low zoom', () => {
    viewportHarness.zoom = 0.5
    const { getByTestId } = render(
      <PluginCallGraphEdge
        {...edgeProps({
          data: {
            ...edgeProps().data!,
            compactAtLowZoom: true,
          },
        })}
      />
    )

    expect(getByTestId('edge-label')).toHaveTextContent('18 successful calls')
    expect(getByTestId('edge-label')).not.toHaveTextContent('command kinds')
    expect(getByTestId('edge-label')).toHaveStyle({
      transform: 'translate(-50%, -50%) scale(2)',
    })
    expect(getByTestId('edge-label')).toHaveClass(
      'max-w-[88px]',
      'whitespace-normal',
      'text-center',
      'leading-tight'
    )
  })

  it('uses Task 6 bounded width and exposes selected styling', () => {
    const { getByTestId } = render(
      <PluginCallGraphEdge {...edgeProps({ selected: true })} />
    )
    const path = getByTestId('edge-path')

    expect(path).toHaveStyle({ strokeWidth: '5.5' })
    expect(path).toHaveAttribute('data-selected', 'true')
    expect(path).toHaveClass('stroke-primary')
    expect(path).not.toHaveClass('animated')
  })

  it('hides non-selected labels in reduced and table-first density', () => {
    const { queryByTestId, rerender } = render(
      <PluginCallGraphEdge
        {...edgeProps({
          data: { ...edgeProps().data!, density: 'reduced' },
        })}
      />
    )

    expect(queryByTestId('edge-label')).not.toBeInTheDocument()

    rerender(
      <PluginCallGraphEdge
        {...edgeProps({
          data: { ...edgeProps().data!, density: 'table-first' },
        })}
      />
    )
    expect(queryByTestId('edge-label')).not.toBeInTheDocument()
  })

  it('keeps a selected edge label visible in dense mode', () => {
    const { getByTestId } = render(
      <PluginCallGraphEdge
        {...edgeProps({
          selected: true,
          data: { ...edgeProps().data!, density: 'reduced' },
        })}
      />
    )

    expect(getByTestId('edge-label')).toHaveTextContent(
      '18 successful calls · 2 command kinds'
    )
  })
})
