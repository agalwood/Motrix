import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { i18n } from '@renderer/lib/i18n'
import { Queries } from '@shared/protocol/queries'
import type { PluginListDTO } from '@shared/types/plugin'
import type {
  PluginCommandGraphDTO,
  PluginCommandGraphEdge,
} from '@shared/types/plugin-command-graph'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactFlowProps } from '@xyflow/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installGraphTestEnvironment } from './components/call-graph/graph-test-utils'
import type { CallGraphNodeLayout } from './lib/call-graph-layout'
import type { CallGraphModel } from './lib/call-graph-model'

const { flowHarness, layoutHarness, themeHarness, transportMock } = vi.hoisted(
  () => ({
    flowHarness: {
      props: null as ReactFlowProps | null,
      throwOnRender: false,
    },
    layoutHarness: {
      layout: vi.fn(),
    },
    themeHarness: {
      resolvedTheme: 'light' as 'light' | 'dark',
    },
    transportMock: {
      invoke: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      platform: 'darwin' as const,
    },
  })
)

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: themeHarness.resolvedTheme }),
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: transportMock,
}))

vi.mock('./lib/call-graph-layout', () => ({
  layoutCallGraphNodes: layoutHarness.layout,
}))

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()

  const MockReactFlow = (props: ReactFlowProps) => {
    if (flowHarness.throwOnRender) {
      throw new Error('synthetic canvas render failure')
    }
    flowHarness.props = props

    return (
      <div
        role="application"
        data-testid="react-flow"
        aria-label={props['aria-label']}
      >
        {props.nodes?.map((node) => {
          const data = node.data as {
            model?: { name?: string; status?: string }
            strings?: { statuses?: Record<string, string> }
          }
          return (
            <button
              key={node.id}
              type="button"
              data-testid={`flow-node-${node.id}`}
              data-position={`${node.position.x},${node.position.y}`}
              aria-pressed={Boolean(node.domAttributes?.['aria-pressed'])}
              onClick={(event) => {
                props.onNodesChange?.([
                  { id: node.id, type: 'select', selected: true },
                ])
                props.onNodeClick?.(event, node)
              }}
            >
              {data.model?.name}
              {data.model?.status
                ? ` ${data.strings?.statuses?.[data.model.status]}`
                : null}
            </button>
          )
        })}
        {props.edges?.map((edge) => (
          <button
            key={edge.id}
            type="button"
            data-testid={`flow-edge-${edge.source}-to-${edge.target}`}
            onClick={(event) => {
              props.onEdgesChange?.([
                { id: edge.id, type: 'select', selected: true },
              ])
              props.onEdgeClick?.(event, edge)
            }}
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
    ReactFlow: MockReactFlow,
    Background: () => <div data-testid="flow-background" />,
    Controls: () => <div data-testid="flow-controls" />,
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
    MiniMap: () => <div data-testid="flow-minimap" />,
  }
})

import { PluginDiagnosticsPage } from './plugin-diagnostics-page'

const NOW = 1_800_000_000_000

const PLUGINS: PluginListDTO[] = [
  plugin('plugin.alpha', 'Alpha Tools', 'active'),
  plugin('plugin.beta', 'Beta Tools', 'disabled'),
  plugin('plugin.gamma', 'Gamma Tools', 'inactive'),
]

const GRAPH = graph([
  edge('plugin.alpha', 'plugin.beta', 'plugin.beta.run', 4, NOW),
  edge('plugin.alpha', 'plugin.beta', 'plugin.beta.inspect', 2, NOW - 1_000),
  edge('plugin.beta', 'plugin.gamma', 'plugin.gamma.save', 3, NOW - 2_000),
])

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function plugin(
  id: string,
  name: string,
  status: PluginListDTO['status']
): PluginListDTO {
  return {
    id,
    name,
    version: '1.0.0',
    description: `${name} description`,
    status,
    enabled: status !== 'disabled',
    permissions: [],
    optionalPermissions: [],
    errorCount: status === 'error' ? 1 : 0,
  }
}

function edge(
  sourcePluginId: string,
  targetPluginId: string,
  commandId: string,
  calls = 1,
  lastCalledAt = NOW
): PluginCommandGraphEdge {
  return {
    sourcePluginId,
    targetPluginId,
    commandId,
    calls,
    lastCalledAt,
  }
}

function graph(
  edges: PluginCommandGraphEdge[],
  truncated = false
): PluginCommandGraphDTO {
  return {
    edges,
    cutoff: NOW - 24 * 60 * 60 * 1_000,
    generatedAt: NOW,
    truncated,
  }
}

function largeGraph(calls = 1): {
  dto: PluginCommandGraphDTO
  plugins: PluginListDTO[]
} {
  const plugins = Array.from({ length: 24 }, (_, index) =>
    plugin(`plugin.${index}`, `Plugin ${index}`, 'active')
  )
  const edges: PluginCommandGraphEdge[] = []
  for (
    let source = 0;
    source < plugins.length && edges.length < 501;
    source++
  ) {
    for (
      let target = 0;
      target < plugins.length && edges.length < 501;
      target++
    ) {
      if (source === target) continue
      edges.push(
        edge(
          `plugin.${source}`,
          `plugin.${target}`,
          `command.${source}.${target}`,
          calls
        )
      )
    }
  }
  return { dto: graph(edges), plugins }
}

function positionsFor(model: CallGraphModel, start = 10): CallGraphNodeLayout {
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

function configureTransport(
  graphResponses: Array<Promise<unknown> | unknown | (() => unknown)>,
  metadataResponses: Array<Promise<unknown> | unknown | (() => unknown)>
) {
  const graphQueue = [...graphResponses]
  const metadataQueue = [...metadataResponses]
  transportMock.invoke.mockImplementation((query: string) => {
    const queue =
      query === Queries.GetPluginCommandGraph
        ? graphQueue
        : query === Queries.ListPlugins
          ? metadataQueue
          : null
    if (!queue) return Promise.reject(new Error(`Unexpected query: ${query}`))
    if (queue.length === 0) {
      return Promise.reject(new Error(`No response queued for: ${query}`))
    }
    const response = queue.shift()
    return Promise.resolve(
      typeof response === 'function' ? response() : response
    )
  })
}

function renderPage() {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter>
        <TooltipProvider>{children}</TooltipProvider>
      </MemoryRouter>
    )
  }

  return render(<PluginDiagnosticsPage />, { wrapper: Wrapper })
}

async function renderSuccess(
  graphDto: PluginCommandGraphDTO = GRAPH,
  plugins: PluginListDTO[] = PLUGINS
) {
  configureTransport([graphDto], [plugins])
  renderPage()
  await screen.findByRole('application', {
    name: 'Plugin command relationships',
  })
}

function activePanel(name: 'Graph' | 'Table'): HTMLElement {
  const tab = screen.getByRole('tab', { name })
  const panelId = tab.getAttribute('aria-controls')
  if (!panelId) throw new Error(`${name} tab has no aria-controls`)
  const panel = document.getElementById(panelId)
  if (!panel) throw new Error(`${name} panel does not exist`)
  return panel
}

function installTooltipCompatibleResizeObserver(): void {
  const GraphResizeObserver = globalThis.ResizeObserver

  class TooltipCompatibleResizeObserver implements ResizeObserver {
    readonly #observer: ResizeObserver

    constructor(callback: ResizeObserverCallback) {
      this.#observer = new GraphResizeObserver((entries) => {
        callback(
          entries.map((entry) => {
            const size = {
              inlineSize: entry.contentRect.width,
              blockSize: entry.contentRect.height,
            }
            return {
              target: entry.target,
              contentRect: entry.contentRect,
              borderBoxSize: [size],
              contentBoxSize: [size],
              devicePixelContentBoxSize: [size],
            }
          }),
          this
        )
      })
    }

    disconnect(): void {
      this.#observer.disconnect()
    }

    observe(target: Element, options?: ResizeObserverOptions): void {
      this.#observer.observe(target, options)
    }

    unobserve(target: Element): void {
      this.#observer.unobserve(target)
    }
  }

  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: TooltipCompatibleResizeObserver,
  })
}

describe('PluginDiagnosticsPage', () => {
  let restoreGraphEnvironment: () => void

  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
    restoreGraphEnvironment = installGraphTestEnvironment()
    installTooltipCompatibleResizeObserver()
    flowHarness.props = null
    flowHarness.throwOnRender = false
    themeHarness.resolvedTheme = 'light'
    layoutHarness.layout.mockReset()
    layoutHarness.layout.mockImplementation((model: CallGraphModel) =>
      Promise.resolve(positionsFor(model))
    )
    transportMock.invoke.mockReset()
    transportMock.on.mockReset()
    transportMock.off.mockReset()
  })

  afterEach(() => {
    cleanup()
    restoreGraphEnvironment()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('passes the resolved dark theme to the graph canvas', async () => {
    themeHarness.resolvedTheme = 'dark'
    await renderSuccess()

    expect(flowHarness.props?.colorMode).toBe('dark')
  })

  it('waits for graph and metadata before building and laying out the graph', async () => {
    const graphRequest = deferred<PluginCommandGraphDTO>()
    const metadataRequest = deferred<PluginListDTO[]>()
    configureTransport([graphRequest.promise], [metadataRequest.promise])

    renderPage()
    expect(screen.getByText('Loading call history…')).toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'Call volume legend' })
    ).toBeNull()

    await act(async () => {
      graphRequest.resolve(
        graph([edge('plugin.alpha', 'plugin.removed', 'plugin.removed.run')])
      )
      await graphRequest.promise
    })

    expect(screen.getByText('Loading plugin details…')).toBeInTheDocument()
    expect(screen.queryByText('Not installed')).not.toBeInTheDocument()
    expect(layoutHarness.layout).not.toHaveBeenCalled()

    await act(async () => {
      metadataRequest.resolve(PLUGINS)
      await metadataRequest.promise
    })

    expect(
      await screen.findByRole('application', {
        name: 'Plugin command relationships',
      })
    ).toBeInTheDocument()
    expect(layoutHarness.layout).toHaveBeenCalledTimes(1)
    const invokedQueries = transportMock.invoke.mock.calls.map(
      ([query]) => query
    )
    expect(invokedQueries).toEqual(
      expect.arrayContaining([
        Queries.GetPluginCommandGraph,
        Queries.ListPlugins,
      ])
    )
    expect(invokedQueries).not.toContain(Queries.ListPluginGrants)
    expect(invokedQueries).not.toContain(Queries.GetPluginGrants)
  })

  it('explains a successful globally empty graph without fabricating an error', async () => {
    configureTransport([graph([])], [PLUGINS])
    renderPage()

    expect(
      await screen.findByText('No successful cross-plugin calls yet')
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Built-in plugins may not create cross-plugin traffic by default.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole('application')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'Call volume legend' })
    ).toBeNull()
    expect(layoutHarness.layout).not.toHaveBeenCalled()
  })

  it('recovers a graph transport error with Retry and retains data while refreshing', async () => {
    const refreshRequest = deferred<PluginCommandGraphDTO>()
    const retryRequest = deferred<PluginCommandGraphDTO>()
    configureTransport(
      [
        () => Promise.reject(new Error('private transport detail')),
        GRAPH,
        refreshRequest.promise,
        () => Promise.reject(new Error('refresh transport detail')),
        retryRequest.promise,
      ],
      [PLUGINS]
    )
    renderPage()

    expect(
      await screen.findByText('Call history could not be loaded')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('private transport detail')
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry call history' }))
    const canvas = await screen.findByRole('application', {
      name: 'Plugin command relationships',
    })
    expect(canvas).toBeInTheDocument()
    expect(
      await screen.findByRole('group', { name: 'Call volume legend' })
    ).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(canvas).toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'Call volume legend' })
    ).toBeNull()
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toHaveAttribute(
      'aria-busy',
      'true'
    )

    await act(async () => {
      refreshRequest.resolve({
        ...GRAPH,
        edges: GRAPH.edges.map((item) => ({ ...item, calls: item.calls + 1 })),
      })
      await refreshRequest.promise
    })
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled()
    expect(
      await screen.findByRole('group', { name: 'Call volume legend' })
    ).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(
      await screen.findByText('Call history could not be loaded')
    ).toBeInTheDocument()
    expect(canvas).toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'Call volume legend' })
    ).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry call history' }))
    expect(canvas).toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'Call volume legend' })
    ).toBeNull()
    await act(async () => {
      retryRequest.resolve({
        ...GRAPH,
        edges: GRAPH.edges.map((item) => ({ ...item, calls: item.calls + 2 })),
      })
      await retryRequest.promise
    })
    expect(
      await screen.findByRole('group', { name: 'Call volume legend' })
    ).toBeVisible()
  })

  it('keeps missing status hidden until metadata Retry succeeds', async () => {
    configureTransport(
      [graph([edge('plugin.alpha', 'plugin.removed', 'plugin.removed.run')])],
      [() => Promise.reject(new Error('metadata detail')), []]
    )
    renderPage()

    expect(
      await screen.findByText('Plugin details could not be loaded')
    ).toBeInTheDocument()
    expect(screen.queryByText('metadata detail')).not.toBeInTheDocument()
    expect(screen.queryByText('Not installed')).not.toBeInTheDocument()
    expect(layoutHarness.layout).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole('button', { name: 'Retry plugin details' })
    )
    expect(
      await screen.findByRole('application', {
        name: 'Plugin command relationships',
      })
    ).toBeInTheDocument()
    expect(
      screen.getByText(/plugin\.removed Not installed/)
    ).toBeInTheDocument()
  })

  it('shows the partial-history warning for a truncated successful response', async () => {
    await renderSuccess({ ...GRAPH, truncated: true })

    expect(screen.getByRole('status')).toHaveTextContent(
      'Call history may be incomplete because the read budget, retention, or file rotation limited this result.'
    )
  })

  it('switches associated views and filters all relationships with one query', async () => {
    const user = userEvent.setup()
    await renderSuccess()

    expect(screen.queryByText(/^Legend:/)).toBeNull()
    expect(
      await screen.findByRole('group', { name: 'Call volume legend' })
    ).toBeVisible()

    const graphTab = screen.getByRole('tab', { name: 'Graph' })
    const tableTab = screen.getByRole('tab', { name: 'Table' })
    const graphPanel = activePanel('Graph')
    const tablePanel = activePanel('Table')
    expect(graphPanel).toHaveAttribute('aria-labelledby', graphTab.id)
    expect(tablePanel).toHaveAttribute('aria-labelledby', tableTab.id)
    expect(graphPanel).not.toHaveAttribute('hidden')
    expect(tablePanel).toHaveAttribute('hidden')

    await user.click(tableTab)
    expect(
      screen.queryByRole('group', { name: 'Call volume legend' })
    ).toBeNull()
    expect(graphPanel).toHaveAttribute('hidden')
    expect(tablePanel).not.toHaveAttribute('hidden')
    const initialTable = within(tablePanel).getByRole('table', {
      name: 'Plugin command relationships',
    })
    expect(within(initialTable).getAllByRole('row')).toHaveLength(4)
    expect(screen.queryByRole('application')).not.toBeInTheDocument()

    await user.click(graphTab)
    fireEvent.click(screen.getByTestId('flow-node-plugin.beta'))
    expect(
      screen.getByRole('heading', { name: 'Beta Tools' })
    ).toBeInTheDocument()
    expect(screen.getByTestId('flow-node-plugin.beta')).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    const search = screen.getByRole('combobox', {
      name: 'Search relationships',
    })
    await user.type(search, 'Alpha Tools')
    await user.keyboard('[Escape]')
    expect(
      screen.getByRole('heading', { name: 'Successful calls' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Beta Tools' })
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('flow-node-plugin.beta')).toHaveAttribute(
      'aria-pressed',
      'false'
    )

    await user.click(tableTab)
    expect(graphPanel).toHaveAttribute('hidden')
    expect(tablePanel).not.toHaveAttribute('hidden')
    const table = within(tablePanel).getByRole('table', {
      name: 'Plugin command relationships',
    })
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    const typedRows = within(table)
      .getAllByRole('row')
      .map((row) => row.textContent)

    await user.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(search).toHaveValue('')
    expect(within(table).getAllByRole('row')).toHaveLength(4)

    await user.type(search, 'alpha')
    await user.click(
      await screen.findByRole('option', {
        name: /Alpha Tools.*plugin\.alpha/,
      })
    )
    expect(search).toHaveValue('Alpha Tools')
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent)
    ).toEqual(typedRows)
    expect(screen.queryByRole('application')).not.toBeInTheDocument()
  })

  it('starts a >500-pair result in Table without hidden layout and preserves explicit Graph through polling', async () => {
    vi.useFakeTimers()
    const initial = largeGraph(1)
    const polled = largeGraph(2)
    configureTransport([initial.dto, polled.dto], [initial.plugins])
    renderPage()

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('tab', { name: 'Table' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.queryByRole('application')).not.toBeInTheDocument()
    expect(layoutHarness.layout).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: 'Graph' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('application')).toBeInTheDocument()
    expect(layoutHarness.layout).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1_000)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(
      transportMock.invoke.mock.calls.filter(
        ([query]) => query === Queries.GetPluginCommandGraph
      )
    ).toHaveLength(2)
    expect(screen.getByRole('tab', { name: 'Graph' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByRole('application')).toBeInTheDocument()
  })

  it('distinguishes a search-filtered empty result from global inactivity', async () => {
    await renderSuccess()

    fireEvent.change(
      screen.getByRole('combobox', { name: 'Search relationships' }),
      {
        target: { value: 'does-not-exist' },
      }
    )
    expect(
      screen.getByText('No successful calls match this search.')
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'Call volume legend' })
    ).toBeNull()
    expect(
      screen.queryByText('No successful cross-plugin calls yet')
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('application')).not.toBeInTheDocument()
  })

  it('shows current node and edge selections in the Graph inspector', async () => {
    await renderSuccess()

    fireEvent.click(screen.getByTestId('flow-node-plugin.alpha'))
    const inspector = screen.getByRole('complementary', {
      name: 'Call graph selection details',
    })
    expect(
      within(inspector).getByRole('heading', { name: 'Alpha Tools' })
    ).toBeInTheDocument()
    expect(within(inspector).getByText('plugin.alpha')).toBeInTheDocument()

    fireEvent.click(
      await screen.findByTestId('flow-edge-plugin.alpha-to-plugin.beta')
    )
    expect(
      within(inspector).getByRole('heading', { name: 'Connection details' })
    ).toBeInTheDocument()
    expect(within(inspector).getByText('plugin.beta.run')).toBeInTheDocument()
    expect(
      within(inspector).getByText('plugin.beta.inspect')
    ).toBeInTheDocument()
  })

  it('clears graph selection when switching through Table mode', async () => {
    const user = userEvent.setup()
    await renderSuccess()

    fireEvent.click(
      await screen.findByTestId('flow-edge-plugin.alpha-to-plugin.beta')
    )
    expect(
      screen.getByRole('heading', { name: 'Connection details' })
    ).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Table' }))
    await user.click(screen.getByRole('tab', { name: 'Graph' }))

    expect(
      screen.getByRole('heading', { name: 'Successful calls' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Connection details' })
    ).not.toBeInTheDocument()
  })

  it('localizes React Flow keyboard movement and all live directions', async () => {
    const readMovementConfig = () => {
      const config = flowHarness.props?.ariaLabelConfig
      if (!config) throw new Error('React Flow ariaLabelConfig is unavailable')
      const liveMessage = config['node.a11yDescription.ariaLiveMessage']
      if (typeof liveMessage !== 'function') {
        throw new Error('React Flow node movement callback is unavailable')
      }
      return { config, liveMessage }
    }

    try {
      await renderSuccess()
      const english = readMovementConfig()
      expect(Object.keys(english.config)).toHaveLength(11)
      expect(english.config['node.a11yDescription.keyboardDisabled']).toBe(
        'Use the arrow keys to move this plugin node.'
      )
      expect(
        english.config['node.a11yDescription.keyboardDisabled']
      ).not.toMatch(/unavailable/i)
      for (const direction of ['left', 'right', 'up', 'down'] as const) {
        expect(english.liveMessage({ direction, x: 1, y: 2 })).toBe(
          `Plugin node moved ${direction} to 1, 2.`
        )
      }
      expect(
        Object.values(english.config)
          .map((value) =>
            typeof value === 'function'
              ? value({ direction: 'left', x: 1, y: 2 })
              : value
          )
          .join(' ')
      ).not.toMatch(/delete/i)

      cleanup()
      await i18n.changeLanguage('zh-CN')
      configureTransport([GRAPH], [PLUGINS])
      renderPage()
      await screen.findByRole('application', { name: '插件命令调用关系' })

      const chinese = readMovementConfig()
      expect(chinese.config['node.a11yDescription.keyboardDisabled']).toBe(
        '使用方向键移动此插件节点。'
      )
      expect(
        chinese.config['node.a11yDescription.keyboardDisabled']
      ).not.toMatch(/无法/)
      const directions = {
        left: '左',
        right: '右',
        up: '上',
        down: '下',
      } as const
      for (const [direction, localizedDirection] of Object.entries(
        directions
      ) as Array<[keyof typeof directions, string]>) {
        const announcement = chinese.liveMessage({ direction, x: 1, y: 2 })
        expect(announcement).toBe(
          `插件节点已向${localizedDirection}移动到 1, 2。`
        )
        expect(announcement).not.toMatch(/left|right|up|down/i)
      }
    } finally {
      cleanup()
      await i18n.changeLanguage('en-US')
    }
  })

  it('does not let an older ELK layout overwrite a newer graph signature', async () => {
    const layoutA = deferred<CallGraphNodeLayout>()
    const layoutB = deferred<CallGraphNodeLayout>()
    const graphB = graph([
      edge('plugin.alpha', 'plugin.gamma', 'plugin.gamma.new', 7),
    ])
    configureTransport([GRAPH, graphB], [PLUGINS])
    layoutHarness.layout
      .mockReturnValueOnce(layoutA.promise)
      .mockReturnValueOnce(layoutB.promise)
    renderPage()

    await screen.findByRole('button', { name: 'Refresh' })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(layoutHarness.layout).toHaveBeenCalledTimes(2))
    const modelA = layoutHarness.layout.mock.calls[0]?.[0] as CallGraphModel
    const modelB = layoutHarness.layout.mock.calls[1]?.[0] as CallGraphModel

    await act(async () => {
      layoutB.resolve(positionsFor(modelB, 500))
      await layoutB.promise
    })
    expect(
      await screen.findByTestId('flow-edge-plugin.alpha-to-plugin.gamma')
    ).toBeInTheDocument()
    const alphaNode = screen.getByTestId('flow-node-plugin.alpha')
    const currentBPosition = alphaNode.getAttribute('data-position')
    const staleAPosition = positionsFor(modelA, 10).positions['plugin.alpha']
    expect(currentBPosition).toBe('500,20')
    expect(staleAPosition).toEqual({ x: 10, y: 20 })

    await act(async () => {
      layoutA.resolve(positionsFor(modelA, 10))
      await layoutA.promise
    })
    expect(
      screen.getByTestId('flow-edge-plugin.alpha-to-plugin.gamma')
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('flow-edge-plugin.alpha-to-plugin.beta')
    ).not.toBeInTheDocument()
    expect(alphaNode).toHaveAttribute('data-position', currentBPosition)
    expect(alphaNode).not.toHaveAttribute(
      'data-position',
      `${staleAPosition?.x},${staleAPosition?.y}`
    )
  })

  it('keeps toolbar and Table fallback available after a canvas render failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    flowHarness.throwOnRender = true
    configureTransport([GRAPH], [PLUGINS])
    renderPage()

    expect(
      await screen.findByText('The graph canvas could not be displayed')
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'Call volume legend' })
    ).toBeNull()
    expect(
      screen.getByRole('toolbar', { name: 'Call graph controls' })
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Use Table instead' }))
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(consoleError).toHaveBeenCalled()
  })

  it('keeps async layout Retry separate from the canvas fallback', async () => {
    const retryLayout = deferred<CallGraphNodeLayout>()
    layoutHarness.layout
      .mockRejectedValueOnce(new Error('layout failed'))
      .mockReturnValueOnce(retryLayout.promise)
    configureTransport([GRAPH], [PLUGINS])
    renderPage()

    expect(
      await screen.findByText('The relationship map could not be arranged.')
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'Call volume legend' })
    ).toBeNull()
    expect(
      screen.queryByText('The graph canvas could not be displayed')
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Arrange map again' }))
    await waitFor(() => expect(layoutHarness.layout).toHaveBeenCalledTimes(2))
    expect(
      screen.queryByRole('group', { name: 'Call volume legend' })
    ).toBeNull()
    const retryModel = layoutHarness.layout.mock.calls[1]?.[0] as CallGraphModel
    await act(async () => {
      retryLayout.resolve(positionsFor(retryModel))
      await retryLayout.promise
    })
    await waitFor(() =>
      expect(
        screen.queryByText('The relationship map could not be arranged.')
      ).not.toBeInTheDocument()
    )
    expect(
      screen.getByRole('application', {
        name: 'Plugin command relationships',
      })
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('group', { name: 'Call volume legend' })
    ).toBeVisible()
  })

  it('uses a named bounded container and exactly one active mode scroller', async () => {
    const user = userEvent.setup()
    await renderSuccess()

    const root = screen.getByTestId('plugin-call-graph-container')
    expect(root.className).toContain('@container/call-graph')
    expect(root).toHaveClass('min-h-0', 'flex-1')
    expect(root).not.toHaveClass('overflow-hidden')
    expect(activePanel('Graph')).toHaveClass('overflow-hidden')
    expect(root.innerHTML).not.toMatch(/(?:min-h|h)-\[360px\]/)
    expect(root.querySelectorAll('[class~="overflow-auto"]')).toHaveLength(1)
    expect(
      screen.getByRole('complementary', {
        name: 'Call graph selection details',
      })
    ).toHaveClass('overflow-auto')

    await user.click(screen.getByRole('tab', { name: 'Table' }))
    expect(activePanel('Table')).toHaveClass('overflow-hidden')
    expect(root.querySelectorAll('[class~="overflow-auto"]')).toHaveLength(1)
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'Scrollable command relationships' })
    ).toHaveClass('overflow-auto')
  })
})
